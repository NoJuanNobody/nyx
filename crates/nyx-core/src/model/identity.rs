//! Users, teams, membership. Drizzle: `users`, `teams`, `team_members`.
//! Dropped: `users.clerk_id` (hosted auth), `teams.default_model` / `fast_model` (in-app LLM prefs).

use serde::{Deserialize, Serialize};

use super::{string_enum, Id, Timestamp};

string_enum! {
    /// Team role. Drizzle enum `user_role`.
    UserRole {
        /// Owner.
        Owner => "owner",
        /// Admin.
        Admin => "admin",
        /// Developer.
        Developer => "developer",
        /// Editor.
        Editor => "editor",
        /// Read-only (default).
        Viewer => "viewer",
    }
}

/// A person. In the single-user desktop app there is usually exactly one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    /// Id.
    pub id: Id,
    /// Unique email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// Avatar URL.
    pub avatar_url: Option<String>,
    /// Creation time.
    pub created_at: Timestamp,
    /// Last update time.
    pub updated_at: Timestamp,
}

/// Input for creating a user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewUser {
    /// Unique email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// Avatar URL.
    pub avatar_url: Option<String>,
}

/// A team (workspace).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Team {
    /// Id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Unique slug.
    pub slug: String,
    /// Creation time.
    pub created_at: Timestamp,
    /// Last update time.
    pub updated_at: Timestamp,
}

/// Input for creating a team.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewTeam {
    /// Name.
    pub name: String,
    /// Unique slug.
    pub slug: String,
}

/// Membership of a user in a team.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamMember {
    /// Id.
    pub id: Id,
    /// Team.
    pub team_id: Id,
    /// User.
    pub user_id: Id,
    /// Role.
    pub role: UserRole,
    /// Join time.
    pub joined_at: Timestamp,
}
