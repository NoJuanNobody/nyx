//! Nyx service facade. One typed entry point ([`NyxApp::call_tool`]) over every `nyx-core`
//! capability, shared by the MCP server, the CLI and (later) the Tauri shell.
//!
//! - **JSON in, JSON out**: operations are described by a [`ToolSpec`] (name, JSON schema, cost
//!   class, handler) in the [`registry`]. Front-ends never talk to `nyx-core` directly, so the
//!   guards below apply uniformly.
//! - **Guards on every call**: per-caller rate limiting, argument schema validation, input
//!   sanity checks, [`WorkspaceJail`] for every file path, redaction of secrets in errors and logs.
//! - **Credit metering**: priced operations reserve credits before running, then commit on success
//!   or release on failure (`docs/credits/utility-tokens-spec.md`). Local single-user defaults:
//!   one workspace, an initial owner grant, and a first-sight budget for each new agent.
//! - **Offline by default**: [`Services::offline`] reaches no network; operations that need a
//!   model, search or tracker backend answer `not_configured`.
#![allow(
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::struct_field_names,
    clippy::similar_names,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::module_name_repetitions,
    clippy::items_after_statements,
    clippy::unnecessary_wraps,
    clippy::doc_markdown,
    clippy::trivially_copy_pass_by_ref,
    clippy::many_single_char_names,
    clippy::unnecessary_literal_bound
)]

pub mod args;
pub mod credits;
pub mod error;
pub mod ops;
pub mod registry;
pub mod resources;
pub mod schema;
pub mod services;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use nyx_core::ledger::Credits;
use nyx_core::lifecycle::ensure_builtin_pipelines;
use nyx_core::model::{NewTeam, NewUser, UserRole};
use nyx_core::profile::{EncryptedFileSecretStore, KeychainSecretStore, ProfileStore, SecretStore};
use nyx_core::security::paths::WorkspaceJail;
use nyx_core::security::ratelimit::{Decision, RateLimiter};
use nyx_core::security::redact::redact_json;
use nyx_core::store::{Db, SqliteTeams, SqliteUsers, TeamRepo, UserRepo};
use serde_json::Value;

pub use args::Args;
pub use error::{AppError, AppResult};
pub use registry::{find, registry, Cost, Needs, Parity, ToolSpec};
pub use services::Services;

/// Crate version (same as `nyx-core`).
pub const VERSION: &str = nyx_core::VERSION;

/// Name of the local owner account created on first open.
pub const LOCAL_EMAIL: &str = "local@nyx.local";
/// Slug of the default local workspace (team).
pub const LOCAL_TEAM_SLUG: &str = "local";

/// Who is calling: the agent identity credits are metered against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    /// Credit identity (valid ledger agent id).
    pub agent_id: String,
    /// Free-form client label (MCP `clientInfo.name`, `cli`).
    pub client: String,
}

impl Caller {
    /// Caller named by an MCP/CLI client; the label becomes the agent id.
    #[must_use]
    pub fn named(client: &str) -> Self {
        Self {
            agent_id: credits::sanitize_agent(client),
            client: client.to_owned(),
        }
    }

    /// Local caller: `NYX_AGENT_ID` or `default`.
    #[must_use]
    pub fn local() -> Self {
        let id = std::env::var("NYX_AGENT_ID").unwrap_or_else(|_| "default".into());
        Self {
            agent_id: credits::sanitize_agent(&id),
            client: "local".into(),
        }
    }
}

/// How to open the app.
pub struct AppOptions {
    /// Database file. Default: `<data_dir>/nyx.db`.
    pub db_path: Option<PathBuf>,
    /// App data directory (profile, default DB). Default: the OS app-data dir.
    pub data_dir: Option<PathBuf>,
    /// Use a private in-memory database (tests, ephemeral sessions).
    pub in_memory: bool,
    /// Root all file access is jailed to. Default: the current directory.
    pub workspace_root: Option<PathBuf>,
    /// Secret store (BYOK keys, tokens). Default: the OS keychain.
    pub secrets: Option<Arc<dyn SecretStore>>,
    /// External capabilities. Default: [`Services::offline`], or [`Services::live`] when `live`.
    pub services: Option<Services>,
    /// Plug in the real network edge (`Services::live`) when `services` is not given. The shipped
    /// binaries set this; tests leave it off.
    pub live: bool,
    /// Rate limit: requests per window per caller. Default: 600 per minute.
    pub rate_limit: (u32, Duration),
    /// Owner grant created on first run (idempotent, key `cfg:init`).
    pub initial_grant: Credits,
    /// Budget moved to an agent the first time it is seen.
    pub auto_allocate: Credits,
    /// Per-tool price overrides (0 = free).
    pub cost_overrides: HashMap<String, Credits>,
    /// Display name for the local profile.
    pub display_name: String,
}

impl Default for AppOptions {
    fn default() -> Self {
        Self {
            db_path: None,
            data_dir: None,
            in_memory: false,
            workspace_root: None,
            secrets: None,
            services: None,
            live: false,
            rate_limit: (600, Duration::from_secs(60)),
            initial_grant: 1000,
            auto_allocate: 500,
            cost_overrides: HashMap::new(),
            display_name: "Local user".into(),
        }
    }
}

impl AppOptions {
    /// Defaults plus environment: `NYX_DB`, `NYX_DATA_DIR`, `NYX_WORKSPACE`, `NYX_INITIAL_GRANT`,
    /// `NYX_AUTO_ALLOCATE`, `NYX_RATE_LIMIT` (requests per minute).
    #[must_use]
    pub fn from_env() -> Self {
        let mut o = Self::default();
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        o.db_path = var("NYX_DB").map(PathBuf::from);
        o.data_dir = var("NYX_DATA_DIR").map(PathBuf::from);
        o.workspace_root = var("NYX_WORKSPACE").map(PathBuf::from);
        if let Some(n) = var("NYX_INITIAL_GRANT").and_then(|v| v.parse().ok()) {
            o.initial_grant = n;
        }
        if let Some(n) = var("NYX_AUTO_ALLOCATE").and_then(|v| v.parse().ok()) {
            o.auto_allocate = n;
        }
        if let Some(n) = var("NYX_RATE_LIMIT").and_then(|v| v.parse::<u32>().ok()) {
            o.rate_limit = (n.max(1), Duration::from_secs(60));
        }
        o
    }
}

/// OS keychain, or an encrypted file in the data dir when `NYX_SECRETS_PASSPHRASE` is set
/// (headless machines and CI without a keychain).
fn default_secret_store(data_dir: Option<&std::path::Path>) -> Arc<dyn SecretStore> {
    match (std::env::var("NYX_SECRETS_PASSPHRASE"), data_dir) {
        (Ok(pass), Some(dir)) if !pass.is_empty() => Arc::new(EncryptedFileSecretStore::new(
            dir.join("secrets.enc"),
            secrecy::SecretString::from(pass),
        )),
        _ => Arc::new(KeychainSecretStore::new()),
    }
}

type Logger = Box<dyn Fn(&str) + Send + Sync>;

/// The application: database, identity, guards and services.
pub struct NyxApp {
    db: Mutex<Db>,
    pub(crate) services: Services,
    pub(crate) secrets: Arc<dyn SecretStore>,
    pub(crate) jail: Option<WorkspaceJail>,
    limiter: RateLimiter,
    user_id: String,
    team_id: String,
    data_dir: Option<PathBuf>,
    initial_grant: Credits,
    auto_allocate: Credits,
    costs: HashMap<String, Credits>,
    logger: Mutex<Option<Logger>>,
}

impl std::fmt::Debug for NyxApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NyxApp")
            .field("team_id", &self.team_id)
            .finish_non_exhaustive()
    }
}

/// Per-call context handed to handlers.
pub struct Cx<'a> {
    /// The application.
    pub app: &'a NyxApp,
    /// Locked database.
    pub db: &'a mut Db,
    /// Caller identity.
    pub caller: &'a Caller,
}

impl Cx<'_> {
    /// Connection for auto-commit statements.
    pub fn conn(&self) -> &rusqlite::Connection {
        self.db.conn()
    }

    /// Local owner user id.
    pub fn user_id(&self) -> &str {
        &self.app.user_id
    }

    /// Team from `team_id`, defaulting to the local workspace.
    pub fn team(&self, args: &Args<'_>) -> String {
        args.opt_str("team_id")
            .map_or_else(|| self.app.team_id.clone(), str::to_owned)
    }

    /// Configured services.
    pub fn services(&self) -> &Services {
        &self.app.services
    }
}

impl NyxApp {
    /// Open (creating and migrating) the database, set up the local identity, built-in pipelines
    /// and the first-run credit grant.
    pub fn open(opts: AppOptions) -> AppResult<Self> {
        let (mut db, data_dir) = if opts.in_memory {
            (Db::open_in_memory()?, opts.data_dir.clone())
        } else {
            let dir = match &opts.data_dir {
                Some(d) => d.clone(),
                None => ProfileStore::default_location()?.dir().to_path_buf(),
            };
            let path = opts.db_path.clone().unwrap_or_else(|| dir.join("nyx.db"));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(nyx_core::Error::from)?;
            }
            (Db::open(&path)?, Some(dir))
        };

        let name = match (&data_dir, opts.in_memory) {
            (Some(d), false) => {
                ProfileStore::at(d)
                    .load_or_create(&opts.display_name)?
                    .display_name
            }
            _ => opts.display_name.clone(),
        };
        let (user_id, team_id) = db.transaction(|c| {
            let users = SqliteUsers::new(c);
            let user = match users.find_by_email(LOCAL_EMAIL)? {
                Some(u) => u,
                None => users.create(&NewUser {
                    email: LOCAL_EMAIL.into(),
                    name: name.clone(),
                    avatar_url: None,
                })?,
            };
            let teams = SqliteTeams::new(c);
            let team = if let Some(t) = teams.find_by_slug(LOCAL_TEAM_SLUG)? {
                t
            } else {
                let t = teams.create(&NewTeam {
                    name: "Local workspace".into(),
                    slug: LOCAL_TEAM_SLUG.into(),
                })?;
                teams.add_member(&t.id, &user.id, UserRole::Owner)?;
                t
            };
            Ok((user.id, team.id))
        })?;
        ensure_builtin_pipelines(&mut db)?;
        credits::ensure_init(db.conn(), opts.initial_grant)?;

        let jail = opts
            .workspace_root
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .and_then(|r| WorkspaceJail::new(r).ok());
        let secrets: Arc<dyn SecretStore> = match opts.secrets {
            Some(s) => s,
            None => default_secret_store(data_dir.as_deref()),
        };
        let services = match opts.services {
            Some(s) => s,
            None if opts.live => Services::live(secrets.clone()),
            None => Services::offline(),
        };
        let mut costs = opts.cost_overrides.clone();
        if let Some(d) = &data_dir {
            // Owner-editable price list: {"nyx_check_quality": 5}
            if let Ok(raw) = std::fs::read_to_string(d.join("costs.json")) {
                if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&raw) {
                    for (k, v) in m {
                        if let Some(n) = v.as_i64() {
                            costs.entry(k).or_insert(n);
                        }
                    }
                }
            }
        }
        Ok(Self {
            db: Mutex::new(db),
            services,
            secrets,
            jail,
            limiter: RateLimiter::new(opts.rate_limit.0, opts.rate_limit.1),
            user_id,
            team_id,
            data_dir,
            initial_grant: opts.initial_grant,
            auto_allocate: opts.auto_allocate,
            costs,
            logger: Mutex::new(None),
        })
    }

    /// Install a log sink (arguments are redacted and truncated before they reach it).
    pub fn set_logger(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        *self.logger.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(f));
    }

    fn log(&self, line: &str) {
        if let Some(f) = self
            .logger
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            f(line);
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Db> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Local owner user id.
    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    /// Secret store (BYOK keys, integration tokens).
    pub fn secrets(&self) -> &Arc<dyn SecretStore> {
        &self.secrets
    }

    /// Configured services.
    pub fn services(&self) -> &Services {
        &self.services
    }

    /// Workspace jail, when a workspace root is available.
    pub fn jail(&self) -> Option<&WorkspaceJail> {
        self.jail.as_ref()
    }

    /// Default (local) team id.
    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    /// App data directory when file-backed.
    pub fn data_dir(&self) -> Option<&std::path::Path> {
        self.data_dir.as_deref()
    }

    /// Budget given to an agent the first time it is seen.
    pub fn auto_allocate_amount(&self) -> Credits {
        self.auto_allocate
    }

    /// Credits granted on first run.
    pub fn initial_grant(&self) -> Credits {
        self.initial_grant
    }

    /// Effective price of a tool: owner override, else the catalogue default.
    pub fn price_of(&self, spec: &ToolSpec) -> Credits {
        if let Some(n) = self.costs.get(spec.name) {
            return (*n).max(0);
        }
        match spec.cost {
            Cost::Fixed(n) => n,
            Cost::PerUnit => 1,
            Cost::Free | Cost::Ledger => 0,
        }
    }

    /// Run `f` with the locked database context (used by CLI-only administration).
    pub fn with_cx<T>(
        &self,
        caller: &Caller,
        f: impl FnOnce(&mut Cx<'_>) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self.lock();
        let mut cx = Cx {
            app: self,
            db: &mut guard,
            caller,
        };
        f(&mut cx)
    }

    /// Execute a tool: rate limit, validate, check capabilities, meter, run, redact errors.
    pub fn call_tool(&self, name: &str, args: &Value, caller: &Caller) -> AppResult<Value> {
        let started = std::time::Instant::now();
        let out = self.call_inner(name, args, caller);
        let status = match &out {
            Ok(_) => "ok".to_owned(),
            Err(e) => format!("error={}", e.code),
        };
        let shown = redact_json(args).to_string();
        let shown: String = shown.chars().take(300).collect();
        self.log(&format!(
            "tool={name} agent={} {status} ms={} args={shown}",
            caller.agent_id,
            started.elapsed().as_millis()
        ));
        out
    }

    fn call_inner(&self, name: &str, args: &Value, caller: &Caller) -> AppResult<Value> {
        let spec =
            find(name).ok_or_else(|| AppError::not_found(format!("Unknown tool: {name}")))?;
        if let Decision::Limited { retry_after } = self.limiter.check_now(&caller.agent_id) {
            return Err(AppError::new("rate_limited", "too many requests")
                .with_data(serde_json::json!({"retry_after_ms": retry_after.as_millis() as u64})));
        }
        let empty = Value::Object(serde_json::Map::new());
        let args = if args.is_null() { &empty } else { args };
        schema::validate(&spec.schema, args)
            .map_err(|m| AppError::invalid(format!("Invalid arguments for {name}: {m}")))?;
        match spec.needs {
            Needs::Llm if !self.services.llm_available() => {
                return Err(AppError::not_configured(
                    "no model provider configured (offline). Add a BYOK key with `nyx byok set <provider>`; \
                     live provider transports are plugged in by the host application",
                ))
            }
            Needs::Search if !self.services.search_available() => {
                return Err(AppError::not_configured(
                    "no web search backend configured (offline)",
                ))
            }
            _ => {}
        }
        let price = if spec.cost == Cost::Ledger {
            0
        } else {
            self.price_of(spec)
        };
        let mut guard = self.lock();
        let mut cx = Cx {
            app: self,
            db: &mut guard,
            caller,
        };
        let a = Args(args);
        if price <= 0 || spec.cost == Cost::PerUnit {
            if spec.cost == Cost::PerUnit && price > 0 {
                credits::ensure_agent(cx.conn(), &caller.agent_id, self.auto_allocate)?;
            }
            return (spec.handler)(&mut cx, &a);
        }
        credits::ensure_agent(cx.conn(), &caller.agent_id, self.auto_allocate)?;
        let key = format!("call:{}", uuid::Uuid::new_v4());
        let reserved = credits::reserve(
            cx.conn(),
            &caller.agent_id,
            &key,
            price,
            Some(spec.name),
            Some(credits::CALL_TTL_MS),
            None,
        )?;
        let rid = reserved["reservationId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        match (spec.handler)(&mut cx, &a) {
            Ok(v) => {
                credits::commit(
                    cx.conn(),
                    &caller.agent_id,
                    &format!("{key}:commit"),
                    &rid,
                    price,
                    None,
                )?;
                Ok(v)
            }
            Err(e) => {
                // If release fails the hold simply expires by TTL; the original error wins.
                let _ = credits::release(
                    cx.conn(),
                    &caller.agent_id,
                    &format!("{key}:release"),
                    &rid,
                    Some("operation failed"),
                );
                Err(e)
            }
        }
    }
}
