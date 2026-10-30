//! External integrations. Drizzle: `integrations`.
//! Dropped: Slack/Atlassian OAuth connection tables (hosted-only).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{string_enum, Id, Timestamp};

string_enum! {
    /// Integration type. Drizzle enum `integration_type`.
    IntegrationType {
        /// GitHub.
        Github => "github",
        /// GitLab.
        Gitlab => "gitlab",
        /// Bitbucket.
        Bitbucket => "bitbucket",
        /// Jira.
        Jira => "jira",
        /// Confluence.
        Confluence => "confluence",
    }
}

/// A configured integration for a team.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Integration {
    /// Id.
    pub id: Id,
    /// Team.
    pub team_id: Id,
    /// Type.
    pub r#type: IntegrationType,
    /// Opaque JSON configuration.
    pub config: Value,
    /// Creation time.
    pub created_at: Timestamp,
    /// Last update time.
    pub updated_at: Timestamp,
}

/// Input for creating an integration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewIntegration {
    /// Team.
    pub team_id: Id,
    /// Type.
    pub r#type: IntegrationType,
    /// Configuration.
    pub config: Value,
}
