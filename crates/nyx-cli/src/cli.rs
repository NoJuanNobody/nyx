//! Command-line grammar (clap derive). Every subcommand maps to one `nyx-app` tool (see
//! `commands.rs`), so the CLI, the MCP server and the desktop shell share behaviour.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};
use clap_complete::Shell;

/// Nyx: agent-native, open-source spec workspace. Local-first; no account, no server.
///
/// Every command accepts `--json` for machine output. Exit codes: 0 ok, 1 error, 2 usage,
/// 3 not found, 4 conflict (including an unresolved merge), 5 insufficient credits,
/// 6 rate limited, 7 path rejected by the workspace jail, 8 capability not configured.
#[derive(Parser, Debug)]
#[command(name = "nyx", version, propagate_version = true)]
pub struct Cli {
    /// Print machine-readable JSON (results and errors) on stdout.
    #[arg(long, global = true)]
    pub json: bool,
    /// SQLite database file (default: <data dir>/nyx.db; env NYX_DB).
    #[arg(long, global = true, value_name = "PATH")]
    pub db: Option<PathBuf>,
    /// App data directory: profile, default database (env NYX_DATA_DIR).
    #[arg(long, global = true, value_name = "DIR")]
    pub data_dir: Option<PathBuf>,
    /// Workspace root every file path is confined to (default: current directory; env NYX_WORKSPACE).
    #[arg(long, global = true, value_name = "DIR")]
    pub workspace: Option<PathBuf>,
    /// Agent identity credits are metered against (default: "default"; env NYX_AGENT_ID).
    #[arg(long, global = true, value_name = "ID")]
    pub agent: Option<String>,
    /// Team id (default: the local workspace).
    #[arg(long, global = true, value_name = "ID")]
    pub team: Option<String>,
    /// What to do.
    #[command(subcommand)]
    pub cmd: Cmd,
}

/// Top-level commands.
#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Run the MCP server on stdio (same server as the `nyx-mcp` binary).
    Mcp,
    /// Documents.
    #[command(subcommand)]
    Doc(DocCmd),
    /// Teams.
    #[command(subcommand)]
    Team(TeamCmd),
    /// Document versions.
    #[command(subcommand)]
    Version(VersionCmd),
    /// Branches: fork, review, diff, sync.
    #[command(subcommand)]
    Branch(BranchCmd),
    /// Diff versions or files.
    #[command(subcommand)]
    Diff(DiffCmd),
    /// Three-way merge an approved branch into its document.
    Merge(MergeArgs),
    /// Named captures of documents.
    #[command(subcommand)]
    Snapshot(SnapshotCmd),
    /// Show the folder and document tree.
    Tree {
        /// Only this folder.
        path: Option<String>,
    },
    /// Folders.
    #[command(subcommand)]
    Folder(FolderCmd),
    /// Lifecycle pipelines.
    #[command(subcommand)]
    Pipeline(PipelineCmd),
    /// Document templates.
    #[command(subcommand)]
    Template(TemplateCmd),
    /// Export a document (markdown, txt, pdf, docx, latex, jupyter).
    Export(ExportArgs),
    /// Zip several documents in several formats.
    Bundle(BundleArgs),
    /// Tickets, stage gate and sprint readiness.
    #[command(subcommand)]
    Ticket(TicketCmd),
    /// Index a workspace folder into code chunks (metered per embedded chunk).
    Scan(ScanArgs),
    /// Spec versus code drift.
    #[command(subcommand)]
    Drift(DriftCmd),
    /// Search document content.
    Search(SearchArgs),
    /// Search indexed code.
    CodeSearch {
        /// Query text.
        query: String,
        /// Number of hits.
        #[arg(long, default_value_t = 5)]
        top_k: u32,
    },
    /// Chunk and embed documents for search.
    Index {
        /// Re-embed documents that are already indexed.
        #[arg(long)]
        force: bool,
    },
    /// Impact graph between specs, files and tickets.
    #[command(subcommand)]
    Impact(ImpactCmd),
    /// Audit trail.
    #[command(subcommand)]
    Audit(AuditCmd),
    /// Notification inbox.
    Notifications {
        /// Only unread.
        #[arg(long)]
        unread: bool,
        /// Maximum entries.
        #[arg(long, default_value_t = 20)]
        limit: u32,
        /// Mark everything read after listing.
        #[arg(long)]
        mark_read: bool,
    },
    /// Approvals.
    #[command(subcommand)]
    Approval(ApprovalCmd),
    /// Integration configuration and credentials.
    #[command(subcommand)]
    Integration(IntegrationCmd),
    /// Bring-your-own-key model provider credentials (stored in the OS keychain).
    #[command(subcommand)]
    Byok(ByokCmd),
    /// Local profile.
    #[command(subcommand)]
    Profile(ProfileCmd),
    /// Credit metering: agent-native utility tokens (never sold).
    #[command(subcommand)]
    Credits(CreditsCmd),
    /// AI quality check of a spec file (needs a model provider).
    Quality {
        /// File inside the workspace (`-` for stdin).
        file: String,
    },
    /// Scan a file for secrets before it goes into a document.
    Secrets {
        /// File inside the workspace (`-` for stdin).
        file: String,
    },
    /// Local identity, team, agent and configured services.
    Whoami,
    /// List every tool (the MCP catalogue) with its credit class.
    Tools,
    /// Call any tool directly by name with a JSON object of arguments.
    Tool {
        /// Tool name, e.g. nyx_search_docs.
        name: String,
        /// Arguments as a JSON object.
        #[arg(default_value = "{}")]
        args: String,
    },
    /// Print shell completions.
    Completions {
        /// Target shell.
        shell: Shell,
    },
}

/// Content source shared by commands that take text.
#[derive(Args, Debug, Default, Clone)]
pub struct Body {
    /// Text content.
    #[arg(long, conflicts_with = "file")]
    pub content: Option<String>,
    /// Read the content from a workspace file (`-` for stdin).
    #[arg(long, value_name = "PATH")]
    pub file: Option<String>,
}

/// `nyx doc ...`
#[derive(Subcommand, Debug)]
pub enum DocCmd {
    /// List the team's live documents.
    List,
    /// Print a document.
    Show {
        /// Document id.
        id: String,
    },
    /// Create a document.
    Create {
        /// Title.
        #[arg(long)]
        title: String,
        /// Folder path.
        #[arg(long, default_value = "/")]
        path: String,
        /// Content.
        #[command(flatten)]
        body: Body,
    },
    /// Change title and/or content (content creates a new version).
    Update {
        /// Document id.
        id: String,
        /// New title.
        #[arg(long)]
        title: Option<String>,
        /// New content.
        #[command(flatten)]
        body: Body,
    },
    /// Delete (soft).
    Delete {
        /// Document id.
        id: String,
    },
    /// Undo a delete.
    Restore {
        /// Document id.
        id: String,
    },
    /// Move to a lifecycle stage.
    Stage {
        /// Document id.
        id: String,
        /// Stage slug (omit to clear).
        stage: Option<String>,
        /// Pipeline slug.
        #[arg(long)]
        pipeline: Option<String>,
        /// Forbid skipping stages.
        #[arg(long)]
        sequential: bool,
    },
    /// Move into a folder.
    Move {
        /// Document id.
        id: String,
        /// Destination folder.
        to: String,
    },
}

/// `nyx team ...`
#[derive(Subcommand, Debug)]
pub enum TeamCmd {
    /// List teams.
    List,
    /// Show one team.
    Show {
        /// Team id.
        id: String,
    },
    /// Create a team.
    Create {
        /// Display name.
        name: String,
        /// Slug (a-z, 0-9, -).
        slug: String,
    },
}

/// `nyx version ...`
#[derive(Subcommand, Debug)]
pub enum VersionCmd {
    /// Version history, newest first.
    List {
        /// Document id.
        doc: String,
    },
    /// One version with content.
    Show {
        /// Version id (or use --doc).
        id: Option<String>,
        /// Document id (with --number; latest if omitted).
        #[arg(long)]
        doc: Option<String>,
        /// Version number.
        #[arg(long)]
        number: Option<u32>,
    },
    /// Record a version.
    Create {
        /// Document id.
        doc: String,
        /// Message.
        #[arg(long, short)]
        message: Option<String>,
        /// New content (default: the current content).
        #[command(flatten)]
        body: Body,
    },
    /// Make an old version the head again.
    Restore {
        /// Document id.
        doc: String,
        /// Version id.
        version_id: String,
    },
}

/// `nyx branch ...`
#[derive(Subcommand, Debug)]
pub enum BranchCmd {
    /// Fork a branch.
    Create {
        /// Document id.
        doc: String,
        /// Branch name.
        name: String,
        /// Fork from this version id (default: latest).
        #[arg(long)]
        base: Option<String>,
    },
    /// List branches.
    List {
        /// Document id.
        doc: String,
    },
    /// Show a branch with content.
    Show {
        /// Branch id.
        id: String,
    },
    /// Replace branch content.
    Edit {
        /// Branch id.
        id: String,
        /// New content.
        #[command(flatten)]
        body: Body,
    },
    /// Submit for review.
    Submit {
        /// Branch id.
        id: String,
    },
    /// Approve.
    Approve {
        /// Branch id.
        id: String,
    },
    /// Reject.
    Reject {
        /// Branch id.
        id: String,
    },
    /// Back to draft.
    Reopen {
        /// Branch id.
        id: String,
    },
    /// Diff a branch.
    Diff {
        /// Branch id.
        id: String,
        /// Compare with the head instead of the fork point.
        #[arg(long)]
        head: bool,
    },
    /// Fold head changes into the branch.
    Sync {
        /// Branch id.
        id: String,
        /// Settle every conflict the same way.
        #[arg(long, value_enum)]
        resolve: Option<Resolve>,
    },
}

/// How to settle conflicts.
#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum Resolve {
    /// Keep the head side.
    Ours,
    /// Keep the branch side.
    Theirs,
    /// Revert to the common ancestor.
    Base,
    /// Both, head first.
    Both,
}

impl Resolve {
    /// Wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ours => "ours",
            Self::Theirs => "theirs",
            Self::Base => "base",
            Self::Both => "both",
        }
    }
}

/// Output format of diffs.
#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum DiffFormat {
    /// Hunks with line numbers and stats.
    Lines,
    /// Word level.
    Words,
    /// Unified text.
    Unified,
}

impl DiffFormat {
    /// Wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lines => "lines",
            Self::Words => "words",
            Self::Unified => "unified",
        }
    }
}

/// `nyx diff ...`
#[derive(Subcommand, Debug)]
pub enum DiffCmd {
    /// Two document versions.
    Versions {
        /// Older version id.
        a: String,
        /// Newer version id.
        b: String,
        /// Format.
        #[arg(long, value_enum, default_value = "lines")]
        format: DiffFormat,
    },
    /// Two workspace files.
    Files {
        /// Old file.
        old: String,
        /// New file.
        new: String,
        /// Format.
        #[arg(long, value_enum, default_value = "unified")]
        format: DiffFormat,
    },
    /// A branch against its fork point or head.
    Branch {
        /// Branch id.
        id: String,
        /// Compare with the head.
        #[arg(long)]
        head: bool,
    },
    /// A snapshot against the current document.
    Snapshot {
        /// Snapshot id.
        id: String,
    },
}

/// `nyx merge`
#[derive(Args, Debug)]
pub struct MergeArgs {
    /// Branch id (must be approved).
    pub branch: String,
    /// Plan only; write nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Settle every conflict the same way.
    #[arg(long, value_enum, conflicts_with = "resolutions")]
    pub resolve: Option<Resolve>,
    /// JSON file with one resolution per conflict: [{"choose":"custom","text":"..."}].
    #[arg(long, value_name = "PATH")]
    pub resolutions: Option<String>,
}

/// `nyx snapshot ...`
#[derive(Subcommand, Debug)]
pub enum SnapshotCmd {
    /// Capture documents.
    Create {
        /// Snapshot name.
        name: String,
        /// Document ids.
        #[arg(required = true)]
        docs: Vec<String>,
    },
    /// List snapshots (of a document, or the whole team).
    List {
        /// Document id.
        doc: Option<String>,
    },
    /// Restore (appends a new version).
    Restore {
        /// Snapshot id.
        id: String,
    },
}

/// `nyx folder ...`
#[derive(Subcommand, Debug)]
pub enum FolderCmd {
    /// Create a folder.
    Create {
        /// Folder name.
        name: String,
        /// Parent folder.
        #[arg(long, default_value = "/")]
        parent: String,
    },
    /// Rename.
    Rename {
        /// Folder path.
        path: String,
        /// New name.
        name: String,
    },
    /// Move under another folder.
    Move {
        /// Folder path.
        path: String,
        /// New parent.
        to: String,
    },
    /// Delete (refuses a non-empty folder unless --cascade).
    Delete {
        /// Folder path.
        path: String,
        /// Also soft-delete the documents inside.
        #[arg(long)]
        cascade: bool,
    },
}

/// `nyx pipeline ...`
#[derive(Subcommand, Debug)]
pub enum PipelineCmd {
    /// List pipelines.
    List,
    /// Show one.
    Show {
        /// Pipeline slug.
        slug: String,
    },
}

/// `nyx template ...`
#[derive(Subcommand, Debug)]
pub enum TemplateCmd {
    /// List templates.
    List {
        /// Pipeline slug.
        #[arg(long)]
        pipeline: Option<String>,
        /// Stage slug.
        #[arg(long)]
        stage: Option<String>,
    },
    /// Create a document from a template.
    New {
        /// Pipeline slug.
        pipeline: String,
        /// Stage slug.
        stage: String,
        /// Template name.
        template: String,
        /// Document title.
        #[arg(long)]
        title: Option<String>,
        /// Folder path.
        #[arg(long)]
        path: Option<String>,
        /// Template variable, repeatable: --var name=value.
        #[arg(long = "var", value_name = "NAME=VALUE")]
        vars: Vec<String>,
    },
    /// Compare a document with a template's sections.
    Check {
        /// Document id.
        doc: String,
        /// Pipeline slug.
        pipeline: String,
        /// Stage slug.
        stage: String,
        /// Template name.
        template: String,
    },
}

/// Export formats.
#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum Format {
    /// Markdown.
    #[value(alias = "md")]
    Markdown,
    /// Plain text.
    Txt,
    /// PDF.
    Pdf,
    /// Word.
    Docx,
    /// LaTeX.
    #[value(alias = "tex")]
    Latex,
    /// Jupyter notebook.
    #[value(alias = "ipynb")]
    Jupyter,
}

impl Format {
    /// Wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Txt => "txt",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Latex => "latex",
            Self::Jupyter => "jupyter",
        }
    }
}

/// `nyx export`
#[derive(Args, Debug)]
pub struct ExportArgs {
    /// Document id.
    pub doc: String,
    /// Format.
    #[arg(long, short, value_enum, default_value = "markdown")]
    pub format: Format,
    /// Write to this workspace path instead of stdout.
    #[arg(long, short, value_name = "PATH")]
    pub out: Option<String>,
    /// LaTeX theme: ieee, acm, apa, plain.
    #[arg(long)]
    pub latex_theme: Option<String>,
}

/// `nyx bundle`
#[derive(Args, Debug)]
pub struct BundleArgs {
    /// Document ids.
    #[arg(required = true)]
    pub docs: Vec<String>,
    /// Formats to include.
    #[arg(long, short, value_enum, required = true, num_args = 1..)]
    pub formats: Vec<Format>,
    /// Zip path inside the workspace.
    #[arg(long, short, value_name = "PATH")]
    pub out: String,
}

/// `nyx ticket ...`
#[derive(Subcommand, Debug)]
pub enum TicketCmd {
    /// Create a ticket in GitHub or Jira (metered).
    Create {
        /// Document id.
        doc: String,
        /// github or jira.
        #[arg(long)]
        provider: String,
        /// Title.
        #[arg(long)]
        title: String,
        /// Body text.
        #[arg(long, conflicts_with = "body_file")]
        body: Option<String>,
        /// Body from a workspace file.
        #[arg(long)]
        body_file: Option<String>,
        /// owner/repo or Jira project key (default: integration config).
        #[arg(long)]
        destination: Option<String>,
    },
    /// Tickets of a document.
    List {
        /// Document id.
        doc: String,
    },
    /// Set the local status.
    Status {
        /// Ticket id.
        id: String,
        /// open, in_progress or closed.
        status: String,
    },
    /// Stage gate: may the document move to this stage?
    Gate {
        /// Document id.
        doc: String,
        /// Target stage.
        stage: String,
    },
    /// Sprint readiness over documents and tickets.
    Readiness {
        /// Document ids (default: all).
        docs: Vec<String>,
    },
}

/// `nyx scan`
#[derive(Args, Debug)]
pub struct ScanArgs {
    /// Folder inside the workspace.
    #[arg(default_value = ".")]
    pub path: String,
    /// Repository label.
    #[arg(long)]
    pub repo_name: Option<String>,
    /// Count only; index nothing.
    #[arg(long)]
    pub plan: bool,
    /// Re-embed everything.
    #[arg(long)]
    pub force: bool,
    /// File cap.
    #[arg(long)]
    pub max_files: Option<u32>,
}

/// `nyx drift ...`
#[derive(Subcommand, Debug)]
pub enum DriftCmd {
    /// Compare a spec file with a code file (needs a model provider).
    Detect {
        /// Spec file.
        spec: String,
        /// Code file.
        code: String,
    },
    /// Judge specs against changed workspace files (needs a model provider).
    Check {
        /// Changed files.
        #[arg(required = true)]
        files: Vec<String>,
    },
    /// Stored drift findings.
    List {
        /// Document id (default: open findings of the team).
        doc: Option<String>,
    },
    /// Mark a finding.
    Resolve {
        /// Drift id.
        id: String,
        /// open, resolved or dismissed.
        #[arg(default_value = "resolved")]
        status: String,
    },
}

/// Search mode.
#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum Mode {
    /// Embedding similarity.
    Semantic,
    /// Term coverage.
    Keyword,
    /// Blend.
    Hybrid,
}

/// `nyx search`
#[derive(Args, Debug)]
pub struct SearchArgs {
    /// Query text.
    pub query: String,
    /// Ranking mode.
    #[arg(long, value_enum, default_value = "hybrid")]
    pub mode: Mode,
    /// Number of hits.
    #[arg(long, default_value_t = 5)]
    pub top_k: u32,
}

/// Graph node reference: KIND:REF, e.g. spec:<id>, file:src/a.rs, ticket:<id>.
#[derive(Args, Debug)]
pub struct Edge {
    /// Source node (KIND:REF).
    pub src: String,
    /// Target node (KIND:REF).
    pub dst: String,
    /// Relation label.
    #[arg(long, default_value = "references")]
    pub relation: String,
}

/// `nyx impact ...`
#[derive(Subcommand, Debug)]
pub enum ImpactCmd {
    /// Add an edge.
    Link {
        /// Edge.
        #[command(flatten)]
        edge: Edge,
        /// Strength in (0, 1].
        #[arg(long, default_value_t = 1.0)]
        weight: f64,
    },
    /// Remove an edge.
    Unlink {
        /// Edge.
        #[command(flatten)]
        edge: Edge,
    },
    /// What does a change to this node affect?
    Show {
        /// Node (KIND:REF).
        node: String,
        /// Traversal depth.
        #[arg(long, default_value_t = 3)]
        depth: u32,
    },
}

/// `nyx audit ...`
#[derive(Subcommand, Debug)]
pub enum AuditCmd {
    /// Query the trail.
    Log {
        /// Document id.
        #[arg(long)]
        doc: Option<String>,
        /// Event type, repeatable.
        #[arg(long = "type")]
        types: Vec<String>,
        /// Substring of the metadata.
        #[arg(long)]
        text: Option<String>,
        /// Maximum entries.
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// Export the trail as json, jsonl or csv.
    Export {
        /// Format.
        #[arg(long, default_value = "json")]
        format: String,
        /// Document id.
        #[arg(long)]
        doc: Option<String>,
    },
    /// Traceability lineage of a document.
    Trace {
        /// Document id.
        doc: String,
    },
}

/// `nyx approval ...`
#[derive(Subcommand, Debug)]
pub enum ApprovalCmd {
    /// Request approval.
    Request {
        /// Action label, e.g. merge.
        action: String,
        /// Resource id.
        resource: String,
    },
    /// Approve or reject.
    Review {
        /// Approval id.
        id: String,
        /// approve or reject.
        decision: String,
        /// Reason.
        #[arg(long)]
        reason: Option<String>,
    },
    /// List approvals.
    List {
        /// pending, approved, rejected or expired.
        #[arg(long)]
        status: Option<String>,
    },
}

/// `nyx integration ...`
#[derive(Subcommand, Debug)]
pub enum IntegrationCmd {
    /// List (credentials redacted).
    List,
    /// Set non-secret configuration, e.g. '{"repo":"owner/name"}'.
    Set {
        /// github, gitlab, bitbucket, jira or confluence.
        kind: String,
        /// JSON object.
        config: String,
    },
    /// Remove by id.
    Remove {
        /// Integration id.
        id: String,
    },
    /// Store a credential in the OS keychain (read from stdin; never an argument).
    Secret {
        /// Provider slug, e.g. github or jira.
        provider: String,
    },
}

/// `nyx byok ...`
#[derive(Subcommand, Debug)]
pub enum ByokCmd {
    /// Store or replace a model provider key (read from stdin).
    Set {
        /// anthropic, openai, openrouter, ollama or openai-compatible.
        provider: String,
    },
    /// Show whether a key is configured (last four characters only).
    Status {
        /// Provider.
        provider: String,
    },
    /// Delete a key.
    Remove {
        /// Provider.
        provider: String,
    },
}

/// `nyx profile ...`
#[derive(Subcommand, Debug)]
pub enum ProfileCmd {
    /// Show the local profile.
    Show,
    /// Change the display name.
    SetName {
        /// New display name.
        name: String,
    },
}

/// `nyx credits ...`
#[derive(Subcommand, Debug)]
pub enum CreditsCmd {
    /// Spendable balance of an agent.
    Balance,
    /// Hold credits for an operation.
    Reserve {
        /// Credits to hold.
        amount: i64,
        /// Task label.
        #[arg(long)]
        task_type: Option<String>,
        /// Hold expiry in ms.
        #[arg(long)]
        ttl_ms: Option<i64>,
        /// Note.
        #[arg(long)]
        memo: Option<String>,
        /// Retry-safe key (default: generated).
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Settle a reservation.
    Commit {
        /// Reservation id.
        reservation_id: String,
        /// Actual cost (<= reserved).
        actual: i64,
        /// Note.
        #[arg(long)]
        memo: Option<String>,
        /// Retry-safe key.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Cancel a reservation.
    Release {
        /// Reservation id.
        reservation_id: String,
        /// Note.
        #[arg(long)]
        memo: Option<String>,
        /// Retry-safe key.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Reserve and commit in one step.
    Spend {
        /// Credits.
        amount: i64,
        /// Task label.
        #[arg(long)]
        task_type: Option<String>,
        /// Note.
        #[arg(long)]
        memo: Option<String>,
        /// Retry-safe key.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Ledger history (newest first).
    #[command(alias = "usage")]
    History {
        /// Maximum entries.
        #[arg(long, default_value_t = 50)]
        limit: u32,
        /// Every agent instead of just this one.
        #[arg(long)]
        all: bool,
    },
    /// Verify the ledger hash chain.
    Verify,
    /// Owner action: add credits to the pool.
    Grant {
        /// Credits.
        amount: i64,
        /// Note.
        #[arg(long)]
        memo: Option<String>,
        /// Retry-safe key.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Owner action: move credits from the pool to an agent budget.
    Allocate {
        /// Agent id.
        agent: String,
        /// Credits.
        amount: i64,
        /// Retry-safe key.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Owner action: move credits from an agent budget back to the pool.
    Deallocate {
        /// Agent id.
        agent: String,
        /// Credits.
        amount: i64,
        /// Retry-safe key.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
}
