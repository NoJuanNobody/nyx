//! Slack workspace link persistence (`slack_connections`, migration 0171).
//!
//! Replaces the Drizzle `slackConnections` table. Unlike the TS row, the bot token is NOT stored
//! here: [`connect`] / [`connect_with_token`] write it to the [`SecretStore`]
//! (`Provider::Slack` access token; one Slack workspace per profile). This table keeps only the
//! non-secret settings: workspace id, trigger emoji and monitored channels.

use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use secrecy::SecretString;

use super::api::bot_token_key;
use super::events::RoutingRules;
use super::oauth::SlackInstall;
use crate::integrations::{IntegrationError, Result};
use crate::model::{new_id, now_ms};
use crate::profile::SecretStore;

/// Default trigger emoji (TS column default).
pub const DEFAULT_TRIGGER_EMOJI: &str = "nyx";

/// A linked Slack workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlackConnection {
    /// Row id.
    pub id: String,
    /// Nyx team.
    pub team_id: String,
    /// Slack workspace id.
    pub slack_team_id: String,
    /// Trigger emoji (no colons).
    pub trigger_emoji: String,
    /// Monitored channel ids.
    pub monitored_channels: Vec<String>,
    /// Creation time, unix ms.
    pub created_at: i64,
}

impl SlackConnection {
    /// Routing rules for [`super::events::intake_for_event`].
    #[must_use]
    pub fn rules(&self) -> RoutingRules {
        RoutingRules {
            trigger_emoji: self.trigger_emoji.clone(),
            monitored_channels: self.monitored_channels.clone(),
        }
    }
}

/// Partial settings update (`PATCH /slack/connection`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SettingsUpdate {
    /// New trigger emoji (colons are stripped).
    pub trigger_emoji: Option<String>,
    /// Replacement channel list.
    pub monitored_channels: Option<Vec<String>>,
}

fn emoji_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-z0-9_+\-]{1,100}$").unwrap_or_else(|_| unreachable!()))
}
fn channel_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[CGD][A-Z0-9]{2,30}$").unwrap_or_else(|_| unreachable!()))
}

/// Normalise an emoji name: trim, strip surrounding colons, lowercase.
pub fn normalize_emoji(e: &str) -> Result<String> {
    let n = e.trim().trim_matches(':').to_ascii_lowercase();
    if emoji_re().is_match(&n) {
        Ok(n)
    } else {
        Err(IntegrationError::Invalid(format!("bad emoji name: {e:?}")))
    }
}

fn check_channels(ch: &[String]) -> Result<()> {
    match ch.iter().find(|c| !channel_re().is_match(c)) {
        Some(bad) => Err(IntegrationError::Invalid(format!(
            "bad Slack channel id: {bad:?}"
        ))),
        None => Ok(()),
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<SlackConnection> {
    let raw: String = r.get("monitored_channels")?;
    Ok(SlackConnection {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        slack_team_id: r.get("slack_team_id")?,
        trigger_emoji: r.get("trigger_emoji")?,
        monitored_channels: serde_json::from_str(&raw).unwrap_or_default(),
        created_at: r.get("created_at")?,
    })
}

/// Repository over a SQLite connection (or transaction).
#[derive(Debug, Clone, Copy)]
pub struct SqliteSlackConnections<'c>(&'c Connection);

impl<'c> SqliteSlackConnections<'c> {
    /// Wrap a connection.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Link a workspace to a team, or re-point an existing link (keeping its settings), like the
    /// TS callback's upsert.
    pub fn upsert(&self, team_id: &str, slack_team_id: &str) -> Result<SlackConnection> {
        if let Some(existing) = self.get_by_team(team_id)? {
            self.0
                .execute(
                    "UPDATE slack_connections SET slack_team_id = ?2 WHERE id = ?1",
                    params![existing.id, slack_team_id],
                )
                .map_err(crate::Error::from)?;
        } else {
            self.0
                .execute(
                    "INSERT INTO slack_connections (id, team_id, slack_team_id, trigger_emoji, monitored_channels, created_at)
                     VALUES (?1, ?2, ?3, ?4, '[]', ?5)",
                    params![new_id(), team_id, slack_team_id, DEFAULT_TRIGGER_EMOJI, now_ms()],
                )
                .map_err(crate::Error::from)?;
        }
        self.get_by_team(team_id)?
            .ok_or_else(|| IntegrationError::NotFound(format!("slack connection for {team_id}")))
    }

    /// Connection of a Nyx team.
    pub fn get_by_team(&self, team_id: &str) -> Result<Option<SlackConnection>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM slack_connections WHERE team_id = ?1",
                [team_id],
                row,
            )
            .optional()
            .map_err(crate::Error::from)?)
    }

    /// First connection for a Slack workspace id (used to route inbound events).
    pub fn find_by_slack_team(&self, slack_team_id: &str) -> Result<Option<SlackConnection>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM slack_connections WHERE slack_team_id = ?1 ORDER BY created_at, id LIMIT 1",
                [slack_team_id],
                row,
            )
            .optional()
            .map_err(crate::Error::from)?)
    }

    /// Update settings; at least one field is required (the TS answered 400 otherwise).
    pub fn update_settings(&self, team_id: &str, u: &SettingsUpdate) -> Result<SlackConnection> {
        if u.trigger_emoji.is_none() && u.monitored_channels.is_none() {
            return Err(IntegrationError::Invalid("No fields to update".into()));
        }
        let existing = self
            .get_by_team(team_id)?
            .ok_or_else(|| IntegrationError::NotFound(format!("slack connection for {team_id}")))?;
        let emoji = match &u.trigger_emoji {
            Some(e) => normalize_emoji(e)?,
            None => existing.trigger_emoji,
        };
        let channels = match &u.monitored_channels {
            Some(c) => {
                check_channels(c)?;
                c.clone()
            }
            None => existing.monitored_channels,
        };
        self.0
            .execute(
                "UPDATE slack_connections SET trigger_emoji = ?2, monitored_channels = ?3 WHERE id = ?1",
                params![
                    existing.id,
                    emoji,
                    serde_json::to_string(&channels).map_err(crate::Error::from)?
                ],
            )
            .map_err(crate::Error::from)?;
        self.get_by_team(team_id)?
            .ok_or_else(|| IntegrationError::NotFound(format!("slack connection for {team_id}")))
    }

    /// Remove the link. Returns whether a row existed.
    pub fn delete(&self, team_id: &str) -> Result<bool> {
        Ok(self
            .0
            .execute(
                "DELETE FROM slack_connections WHERE team_id = ?1",
                [team_id],
            )
            .map_err(crate::Error::from)?
            > 0)
    }
}

/// Finish an install: bot token to the secret store, workspace link to SQLite.
pub fn connect(
    secrets: &dyn SecretStore,
    repo: &SqliteSlackConnections<'_>,
    team_id: &str,
    install: &SlackInstall,
) -> Result<SlackConnection> {
    use secrecy::ExposeSecret;
    connect_with_token(
        secrets,
        repo,
        team_id,
        &install.slack_team_id,
        SecretString::from(install.bot_token.expose_secret().to_owned()),
    )
}

/// Link a workspace with a bot token obtained out of band (manual `xoxb-...` entry, verified by the
/// caller with `auth.test` to learn `slack_team_id`).
pub fn connect_with_token(
    secrets: &dyn SecretStore,
    repo: &SqliteSlackConnections<'_>,
    team_id: &str,
    slack_team_id: &str,
    bot_token: SecretString,
) -> Result<SlackConnection> {
    secrets
        .set(&bot_token_key(), bot_token)
        .map_err(|e| IntegrationError::Secrets(e.to_string()))?;
    repo.upsert(team_id, slack_team_id)
}

/// Disconnect: remove the link and, if no other link remains, the bot token.
pub fn disconnect(
    secrets: &dyn SecretStore,
    repo: &SqliteSlackConnections<'_>,
    team_id: &str,
) -> Result<bool> {
    let removed = repo.delete(team_id)?;
    if removed {
        secrets
            .delete(&bot_token_key())
            .map_err(|e| IntegrationError::Secrets(e.to_string()))?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret;

    use super::*;
    use crate::model::NewTeam;
    use crate::profile::MemorySecretStore;
    use crate::store::{Db, SqliteTeams, TeamRepo};

    fn team(db: &Db, slug: &str) -> String {
        SqliteTeams::new(db.conn())
            .create(&NewTeam {
                name: slug.into(),
                slug: slug.into(),
            })
            .unwrap()
            .id
    }

    #[test]
    fn upsert_keeps_settings_and_defaults() {
        let db = Db::open_in_memory().unwrap();
        let t = team(&db, "a");
        let repo = SqliteSlackConnections::new(db.conn());
        let c = repo.upsert(&t, "T1").unwrap();
        assert_eq!(c.trigger_emoji, "nyx");
        assert!(c.monitored_channels.is_empty());
        repo.update_settings(
            &t,
            &SettingsUpdate {
                trigger_emoji: Some(":Rocket:".into()),
                monitored_channels: Some(vec!["C123".into(), "G456".into()]),
            },
        )
        .unwrap();
        let c2 = repo.upsert(&t, "T2").unwrap();
        assert_eq!(c2.id, c.id);
        assert_eq!(c2.slack_team_id, "T2");
        assert_eq!(c2.trigger_emoji, "rocket");
        assert_eq!(c2.monitored_channels, ["C123", "G456"]);
        let rules = c2.rules();
        assert_eq!(rules.trigger_emoji, "rocket");
    }

    #[test]
    fn lookup_update_delete() {
        let db = Db::open_in_memory().unwrap();
        let (a, b) = (team(&db, "a"), team(&db, "b"));
        let repo = SqliteSlackConnections::new(db.conn());
        repo.upsert(&a, "T1").unwrap();
        assert_eq!(repo.find_by_slack_team("T1").unwrap().unwrap().team_id, a);
        assert!(repo.find_by_slack_team("nope").unwrap().is_none());
        assert!(repo.get_by_team(&b).unwrap().is_none());
        assert!(matches!(
            repo.update_settings(&a, &SettingsUpdate::default()),
            Err(IntegrationError::Invalid(_))
        ));
        assert!(matches!(
            repo.update_settings(
                &b,
                &SettingsUpdate {
                    trigger_emoji: Some("x".into()),
                    ..SettingsUpdate::default()
                }
            ),
            Err(IntegrationError::NotFound(_))
        ));
        assert!(repo
            .update_settings(
                &a,
                &SettingsUpdate {
                    trigger_emoji: Some("bad emoji!".into()),
                    ..SettingsUpdate::default()
                }
            )
            .is_err());
        assert!(repo
            .update_settings(
                &a,
                &SettingsUpdate {
                    monitored_channels: Some(vec!["general".into()]),
                    ..SettingsUpdate::default()
                }
            )
            .is_err());
        assert!(repo.delete(&a).unwrap());
        assert!(!repo.delete(&a).unwrap());
    }

    #[test]
    fn token_goes_to_secret_store_only() {
        let db = Db::open_in_memory().unwrap();
        let t = team(&db, "a");
        let repo = SqliteSlackConnections::new(db.conn());
        let secrets = MemorySecretStore::new();
        let install = SlackInstall {
            bot_token: SecretString::from("xoxb-very-secret".to_owned()),
            slack_team_id: "T1".into(),
            team_name: "Acme".into(),
            bot_user_id: None,
            scopes: vec![],
        };
        connect(&secrets, &repo, &t, &install).unwrap();
        assert_eq!(
            secrets
                .get(&bot_token_key())
                .unwrap()
                .unwrap()
                .expose_secret(),
            "xoxb-very-secret"
        );
        let dump: String = db
            .conn()
            .query_row(
                "SELECT group_concat(id||team_id||slack_team_id||trigger_emoji||monitored_channels) FROM slack_connections",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!dump.contains("xoxb"));
        assert!(disconnect(&secrets, &repo, &t).unwrap());
        assert!(secrets.get(&bot_token_key()).unwrap().is_none());
        assert!(!disconnect(&secrets, &repo, &t).unwrap());
    }

    #[test]
    fn emoji_normalisation() {
        assert_eq!(normalize_emoji(" :Thumbsup: ").unwrap(), "thumbsup");
        assert_eq!(normalize_emoji("+1").unwrap(), "+1");
        assert!(normalize_emoji("").is_err());
        assert!(normalize_emoji("a b").is_err());
    }
}
