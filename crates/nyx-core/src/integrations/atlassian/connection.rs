//! Atlassian connection lifecycle: metadata in `store::integrations`, tokens in the secret store.
//!
//! Replaces the TS `atlassian_connections` table. The integration row (type `jira`) holds
//! [`AtlassianMeta`] as its `config` JSON: cloud id, site URL, scopes, token expiry, status,
//! webhook id, preferences. **No token is ever written to SQLite**: access and refresh tokens live
//! under `Provider::Jira` in the [`SecretStore`]. One Atlassian connection per profile (the TS
//! service allowed one per user); it serves both Jira and Confluence.
//!
//! Ports `storeConnection`, `getValidToken` (5 minute refresh buffer, status `token_expired` on a
//! dead refresh token), `getConnectionStatus`, `disconnect` and the preferences route.

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::jira::{delete_webhook_request, JiraAuth};
use super::oauth::{
    parse_token_response, refresh_request, revoke_request, AccessibleResource, OAuthClient,
    TokenSet,
};
use crate::integrations::http::Http;
use crate::integrations::oauth::needs_refresh;
use crate::integrations::{IntegrationError, Result};
use crate::model::{Integration, IntegrationType, NewIntegration};
use crate::profile::{Provider, SecretKey, SecretStore};
use crate::store::IntegrationRepo;

/// Connection health.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    /// Tokens usable.
    Connected,
    /// Refresh token rejected; the user must re-authorise.
    TokenExpired,
}

/// Non-secret connection metadata stored as the integration's `config`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AtlassianMeta {
    /// Cloud id.
    pub cloud_id: String,
    /// Site URL.
    pub site_url: String,
    /// Granted scopes.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// Access token expiry, unix ms.
    pub token_expires_at_ms: i64,
    /// Health.
    pub status: ConnectionStatus,
    /// Registered Jira webhook id, for cleanup on disconnect.
    #[serde(default)]
    pub webhook_id: Option<String>,
    /// User sync preferences (opaque JSON).
    #[serde(default)]
    pub preferences: Value,
}

/// Secret key of the access token.
#[must_use]
pub fn access_token_key() -> SecretKey {
    SecretKey::new(Provider::Jira, crate::profile::SecretKind::AccessToken)
}
/// Secret key of the refresh token.
#[must_use]
pub fn refresh_token_key() -> SecretKey {
    SecretKey::new(Provider::Jira, crate::profile::SecretKind::RefreshToken)
}
/// Secret key of the OAuth app's client secret (bring your own Atlassian OAuth app).
#[must_use]
pub fn client_secret_key() -> SecretKey {
    SecretKey::api_key(Provider::Jira)
}
/// Secret key of the Jira webhook HMAC secret.
#[must_use]
pub fn webhook_secret_key() -> SecretKey {
    SecretKey::api_key(Provider::Other("jira-webhook".into()))
}

fn secrets_err(e: crate::Error) -> IntegrationError {
    IntegrationError::Secrets(e.to_string())
}

/// Everything needed to call Jira or Confluence right now.
#[derive(Debug)]
pub struct Session {
    access_token: SecretString,
    /// Cloud id.
    pub cloud_id: String,
    /// Site URL (for browse links).
    pub site_url: String,
}

impl Session {
    /// Auth for [`super::jira::JiraClient`] and [`super::confluence::ConfluenceClient`].
    pub fn auth(&self) -> Result<JiraAuth> {
        JiraAuth::oauth(
            SecretString::from(self.access_token.expose_secret().to_owned()),
            &self.cloud_id,
        )
    }
}

fn meta_of(i: &Integration) -> Result<AtlassianMeta> {
    serde_json::from_value(i.config.clone())
        .map_err(|e| IntegrationError::Parse(format!("integration config: {e}")))
}

fn save_meta(repo: &dyn IntegrationRepo, id: &str, meta: &AtlassianMeta) -> Result<Integration> {
    Ok(repo.update_config(id, &serde_json::to_value(meta).map_err(crate::Error::from)?)?)
}

/// The team's Atlassian integration row, if any.
pub fn find(
    repo: &dyn IntegrationRepo,
    team_id: &str,
) -> Result<Option<(Integration, AtlassianMeta)>> {
    repo.list(team_id)?
        .into_iter()
        .find(|i| i.r#type == IntegrationType::Jira)
        .map(|i| meta_of(&i).map(|m| (i, m)))
        .transpose()
}

/// Store a fresh connection after [`super::oauth::complete_authorization`]: writes tokens to the
/// secret store and creates (or replaces the config of) the team's integration row.
pub fn connect(
    secrets: &dyn SecretStore,
    repo: &dyn IntegrationRepo,
    team_id: &str,
    tokens: &TokenSet,
    site: &AccessibleResource,
    now_ms: i64,
) -> Result<Integration> {
    let refresh = tokens.refresh_token.as_ref().ok_or_else(|| {
        IntegrationError::OAuth("no refresh token returned (offline_access scope missing?)".into())
    })?;
    secrets
        .set(
            &access_token_key(),
            SecretString::from(tokens.access_token.expose_secret().to_owned()),
        )
        .map_err(secrets_err)?;
    secrets
        .set(
            &refresh_token_key(),
            SecretString::from(refresh.expose_secret().to_owned()),
        )
        .map_err(secrets_err)?;
    let meta = AtlassianMeta {
        cloud_id: site.id.clone(),
        site_url: site.url.clone(),
        scopes: tokens.scopes.clone(),
        token_expires_at_ms: tokens.expires_at_ms(now_ms),
        status: ConnectionStatus::Connected,
        webhook_id: None,
        preferences: Value::Object(serde_json::Map::new()),
    };
    match find(repo, team_id)? {
        Some((existing, old)) => save_meta(
            repo,
            &existing.id,
            &AtlassianMeta {
                preferences: old.preferences,
                ..meta
            },
        ),
        None => Ok(repo.create(&NewIntegration {
            team_id: team_id.to_owned(),
            r#type: IntegrationType::Jira,
            config: serde_json::to_value(&meta).map_err(crate::Error::from)?,
        })?),
    }
}

/// Return a usable session, refreshing the access token when it expires within 5 minutes.
///
/// A rejected refresh token marks the connection [`ConnectionStatus::TokenExpired`] and returns
/// [`IntegrationError::TokenExpired`]. Refresh tokens rotate: the new one is stored.
pub fn valid_session(
    http: &Http,
    secrets: &dyn SecretStore,
    repo: &dyn IntegrationRepo,
    client: &OAuthClient,
    integration_id: &str,
    now_ms: i64,
) -> Result<Session> {
    let integration = repo.get(integration_id)?;
    let mut meta = meta_of(&integration)?;
    if meta.status == ConnectionStatus::TokenExpired {
        return Err(IntegrationError::TokenExpired(super::oauth::PROVIDER));
    }
    let mut access = secrets
        .get(&access_token_key())
        .map_err(secrets_err)?
        .ok_or(IntegrationError::MissingCredential("Atlassian"))?;
    if needs_refresh(meta.token_expires_at_ms, now_ms) {
        let refresh = secrets
            .get(&refresh_token_key())
            .map_err(secrets_err)?
            .ok_or(IntegrationError::MissingCredential("Atlassian refresh"))?;
        let resp = http.send(&refresh_request(client, refresh.expose_secret()))?;
        match parse_token_response(&resp, true) {
            Ok(t) => {
                secrets
                    .set(
                        &access_token_key(),
                        SecretString::from(t.access_token.expose_secret().to_owned()),
                    )
                    .map_err(secrets_err)?;
                if let Some(r) = &t.refresh_token {
                    secrets
                        .set(
                            &refresh_token_key(),
                            SecretString::from(r.expose_secret().to_owned()),
                        )
                        .map_err(secrets_err)?;
                }
                meta.token_expires_at_ms = t.expires_at_ms(now_ms);
                save_meta(repo, integration_id, &meta)?;
                access = SecretString::from(t.access_token.expose_secret().to_owned());
            }
            Err(IntegrationError::TokenExpired(p)) => {
                meta.status = ConnectionStatus::TokenExpired;
                save_meta(repo, integration_id, &meta)?;
                return Err(IntegrationError::TokenExpired(p));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(Session {
        access_token: access,
        cloud_id: meta.cloud_id,
        site_url: meta.site_url,
    })
}

/// Record the registered Jira webhook id.
pub fn set_webhook_id(
    repo: &dyn IntegrationRepo,
    integration_id: &str,
    webhook_id: Option<String>,
) -> Result<()> {
    let mut meta = meta_of(&repo.get(integration_id)?)?;
    meta.webhook_id = webhook_id;
    save_meta(repo, integration_id, &meta).map(|_| ())
}

/// Replace the sync preferences (port of `PUT /atlassian/preferences`).
pub fn set_preferences(
    repo: &dyn IntegrationRepo,
    integration_id: &str,
    preferences: Value,
) -> Result<()> {
    let mut meta = meta_of(&repo.get(integration_id)?)?;
    meta.preferences = preferences;
    save_meta(repo, integration_id, &meta).map(|_| ())
}

/// Disconnect: best-effort webhook delete and token revocation, then forget tokens and metadata.
/// Network failures during cleanup are ignored (as in the TS); store failures are returned.
pub fn disconnect(
    http: &Http,
    secrets: &dyn SecretStore,
    repo: &dyn IntegrationRepo,
    client_id: &str,
    integration_id: &str,
) -> Result<bool> {
    let integration = repo.get(integration_id)?;
    if let (Ok(meta), Ok(Some(access))) = (meta_of(&integration), secrets.get(&access_token_key()))
    {
        if let Some(Ok(id)) = meta.webhook_id.as_deref().map(str::parse::<u64>) {
            if let Ok(auth) = JiraAuth::oauth(
                SecretString::from(access.expose_secret().to_owned()),
                &meta.cloud_id,
            ) {
                let _ = http.send(&delete_webhook_request(&auth, &[id]));
            }
        }
        let _ = http.send(&revoke_request(client_id, access.expose_secret()));
    }
    for k in [access_token_key(), refresh_token_key()] {
        secrets.delete(&k).map_err(secrets_err)?;
    }
    Ok(repo.delete(integration_id)?)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::git_provider::FakeTransport;
    use crate::integrations::http::{RecordingSleeper, RetryPolicy};
    use crate::model::NewTeam;
    use crate::profile::MemorySecretStore;
    use crate::store::{Db, SqliteIntegrations, SqliteTeams, TeamRepo};

    fn http(t: &Arc<FakeTransport>) -> Http {
        Http::new(t.clone())
            .with_sleeper(Arc::new(RecordingSleeper::new()))
            .with_policy(RetryPolicy::none())
    }
    fn client() -> OAuthClient {
        OAuthClient {
            client_id: "cid".into(),
            client_secret: Some(SecretString::from("cs".to_owned())),
        }
    }
    fn tokens(access: &str, refresh: &str) -> TokenSet {
        TokenSet {
            access_token: SecretString::from(access.to_owned()),
            refresh_token: Some(SecretString::from(refresh.to_owned())),
            expires_in_secs: 3600,
            scopes: vec!["read:jira-work".into()],
        }
    }
    fn site() -> AccessibleResource {
        AccessibleResource {
            id: "cloud-1".into(),
            url: "https://acme.atlassian.net".into(),
            name: "acme".into(),
            scopes: vec![],
        }
    }
    fn setup() -> (Db, String) {
        let db = Db::open_in_memory().unwrap();
        let team = SqliteTeams::new(db.conn())
            .create(&NewTeam {
                name: "T".into(),
                slug: "t".into(),
            })
            .unwrap();
        (db, team.id)
    }
    const NEW_TOKENS: &str = r#"{"access_token":"at-2","refresh_token":"rt-2","expires_in":3600,"scope":"read:jira-work"}"#;

    #[test]
    fn connect_stores_tokens_in_secrets_not_sqlite() {
        let (db, team) = setup();
        let repo = SqliteIntegrations::new(db.conn());
        let secrets = MemorySecretStore::new();
        let i = connect(
            &secrets,
            &repo,
            &team,
            &tokens("at-1", "rt-1"),
            &site(),
            1_000,
        )
        .unwrap();
        assert_eq!(i.r#type, IntegrationType::Jira);
        let cfg = i.config.to_string();
        assert!(!cfg.contains("at-1") && !cfg.contains("rt-1"));
        let meta = meta_of(&i).unwrap();
        assert_eq!(meta.cloud_id, "cloud-1");
        assert_eq!(meta.token_expires_at_ms, 1_000 + 3_600_000);
        assert_eq!(
            secrets
                .get(&access_token_key())
                .unwrap()
                .unwrap()
                .expose_secret(),
            "at-1"
        );
        // Raw DB dump must not contain the tokens either.
        let dump: String = db
            .conn()
            .query_row("SELECT config FROM integrations", [], |r| r.get(0))
            .unwrap();
        assert!(!dump.contains("at-1"));
        // Reconnect updates in place and keeps preferences.
        set_preferences(&repo, &i.id, serde_json::json!({"sync": true})).unwrap();
        let again = connect(
            &secrets,
            &repo,
            &team,
            &tokens("at-9", "rt-9"),
            &site(),
            2_000,
        )
        .unwrap();
        assert_eq!(again.id, i.id);
        assert_eq!(meta_of(&again).unwrap().preferences["sync"], true);
        assert_eq!(repo.list(&team).unwrap().len(), 1);
    }

    #[test]
    fn connect_requires_refresh_token() {
        let (db, team) = setup();
        let mut t = tokens("a", "r");
        t.refresh_token = None;
        let e = connect(
            &MemorySecretStore::new(),
            &SqliteIntegrations::new(db.conn()),
            &team,
            &t,
            &site(),
            0,
        )
        .unwrap_err();
        assert!(matches!(e, IntegrationError::OAuth(_)));
    }

    #[test]
    fn fresh_token_is_returned_without_network() {
        let (db, team) = setup();
        let repo = SqliteIntegrations::new(db.conn());
        let secrets = MemorySecretStore::new();
        let i = connect(&secrets, &repo, &team, &tokens("at-1", "rt-1"), &site(), 0).unwrap();
        let t = Arc::new(FakeTransport::new());
        let s = valid_session(&http(&t), &secrets, &repo, &client(), &i.id, 1_000).unwrap();
        assert_eq!(s.cloud_id, "cloud-1");
        assert_eq!(s.auth().unwrap().authorization(), "Bearer at-1");
        assert!(t.requests().is_empty());
    }

    #[test]
    fn expiring_token_is_refreshed_and_rotated() {
        let (db, team) = setup();
        let repo = SqliteIntegrations::new(db.conn());
        let secrets = MemorySecretStore::new();
        let i = connect(&secrets, &repo, &team, &tokens("at-1", "rt-1"), &site(), 0).unwrap();
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], NEW_TOKENS);
        let now = 3_600_000 - 60_000; // 1 minute before expiry
        let s = valid_session(&http(&t), &secrets, &repo, &client(), &i.id, now).unwrap();
        assert_eq!(s.auth().unwrap().authorization(), "Bearer at-2");
        assert_eq!(
            secrets
                .get(&refresh_token_key())
                .unwrap()
                .unwrap()
                .expose_secret(),
            "rt-2"
        );
        let body: Value = serde_json::from_str(&t.requests()[0].body_text().unwrap()).unwrap();
        assert_eq!(body["refresh_token"], "rt-1");
        assert_eq!(
            meta_of(&repo.get(&i.id).unwrap())
                .unwrap()
                .token_expires_at_ms,
            now + 3_600_000
        );
    }

    #[test]
    fn dead_refresh_token_marks_connection_expired() {
        let (db, team) = setup();
        let repo = SqliteIntegrations::new(db.conn());
        let secrets = MemorySecretStore::new();
        let i = connect(&secrets, &repo, &team, &tokens("at-1", "rt-1"), &site(), 0).unwrap();
        let t = Arc::new(FakeTransport::new());
        t.push_json(400, &[], r#"{"error":"invalid_grant"}"#);
        let e = valid_session(&http(&t), &secrets, &repo, &client(), &i.id, 3_600_000).unwrap_err();
        assert!(matches!(e, IntegrationError::TokenExpired(_)));
        assert_eq!(
            meta_of(&repo.get(&i.id).unwrap()).unwrap().status,
            ConnectionStatus::TokenExpired
        );
        // Subsequent calls fail fast without network.
        let before = t.requests().len();
        assert!(valid_session(&http(&t), &secrets, &repo, &client(), &i.id, 3_600_000).is_err());
        assert_eq!(t.requests().len(), before);
    }

    #[test]
    fn transient_refresh_failure_keeps_connection() {
        let (db, team) = setup();
        let repo = SqliteIntegrations::new(db.conn());
        let secrets = MemorySecretStore::new();
        let i = connect(&secrets, &repo, &team, &tokens("at-1", "rt-1"), &site(), 0).unwrap();
        let t = Arc::new(FakeTransport::new());
        t.push_json(503, &[], "");
        assert!(valid_session(&http(&t), &secrets, &repo, &client(), &i.id, 3_600_000).is_err());
        assert_eq!(
            meta_of(&repo.get(&i.id).unwrap()).unwrap().status,
            ConnectionStatus::Connected
        );
    }

    #[test]
    fn missing_secret_reports_missing_credential() {
        let (db, team) = setup();
        let repo = SqliteIntegrations::new(db.conn());
        let i = connect(
            &MemorySecretStore::new(),
            &repo,
            &team,
            &tokens("a", "r"),
            &site(),
            0,
        )
        .unwrap();
        let t = Arc::new(FakeTransport::new());
        let e = valid_session(
            &http(&t),
            &MemorySecretStore::new(),
            &repo,
            &client(),
            &i.id,
            0,
        )
        .unwrap_err();
        assert!(matches!(e, IntegrationError::MissingCredential(_)));
    }

    #[test]
    fn disconnect_cleans_up_best_effort() {
        let (db, team) = setup();
        let repo = SqliteIntegrations::new(db.conn());
        let secrets = MemorySecretStore::new();
        let i = connect(&secrets, &repo, &team, &tokens("at-1", "rt-1"), &site(), 0).unwrap();
        set_webhook_id(&repo, &i.id, Some("42".into())).unwrap();
        let t = Arc::new(FakeTransport::new());
        t.push_error("network down"); // webhook delete fails: ignored
        t.push_json(200, &[], "");
        assert!(disconnect(&http(&t), &secrets, &repo, "cid", &i.id).unwrap());
        let reqs = t.requests();
        assert!(reqs[0].url.ends_with("/rest/api/3/webhook"));
        assert!(reqs[1].url.ends_with("/oauth/revoke"));
        assert!(secrets.get(&access_token_key()).unwrap().is_none());
        assert!(secrets.get(&refresh_token_key()).unwrap().is_none());
        assert!(find(&repo, &team).unwrap().is_none());
    }
}
