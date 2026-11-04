//! Users, teams, membership.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::db_err;
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, NewTeam, NewUser, Team, TeamMember, User, UserRole};

/// User persistence.
pub trait UserRepo {
    /// Create a user. Duplicate email yields [`Error::Conflict`].
    fn create(&self, new: &NewUser) -> Result<User>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<User>;
    /// Fetch by email.
    fn find_by_email(&self, email: &str) -> Result<Option<User>>;
    /// All users, oldest first.
    fn list(&self) -> Result<Vec<User>>;
}

/// Team and membership persistence.
pub trait TeamRepo {
    /// Create a team. Duplicate slug yields [`Error::Conflict`].
    fn create(&self, new: &NewTeam) -> Result<Team>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<Team>;
    /// Fetch by slug.
    fn find_by_slug(&self, slug: &str) -> Result<Option<Team>>;
    /// All teams.
    fn list(&self) -> Result<Vec<Team>>;
    /// Add a member. Duplicates yield [`Error::Conflict`].
    fn add_member(&self, team_id: &str, user_id: &str, role: UserRole) -> Result<TeamMember>;
    /// Members of a team, in join order.
    fn members(&self, team_id: &str) -> Result<Vec<TeamMember>>;
    /// Change a role. Demoting the last owner is a [`Error::Conflict`].
    fn set_role(&self, team_id: &str, user_id: &str, role: UserRole) -> Result<()>;
    /// Remove a member. Removing the last owner is a [`Error::Conflict`]. Returns whether a row was removed.
    fn remove_member(&self, team_id: &str, user_id: &str) -> Result<bool>;
}

/// SQLite [`UserRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteUsers<'c>(&'c Connection);
/// SQLite [`TeamRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteTeams<'c>(&'c Connection);

impl<'c> SqliteUsers<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}
impl<'c> SqliteTeams<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn user_row(r: &Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get("id")?,
        email: r.get("email")?,
        name: r.get("name")?,
        avatar_url: r.get("avatar_url")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn team_row(r: &Row<'_>) -> rusqlite::Result<Team> {
    Ok(Team {
        id: r.get("id")?,
        name: r.get("name")?,
        slug: r.get("slug")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn member_row(r: &Row<'_>) -> rusqlite::Result<TeamMember> {
    Ok(TeamMember {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        user_id: r.get("user_id")?,
        role: r.get("role")?,
        joined_at: r.get("joined_at")?,
    })
}

impl UserRepo for SqliteUsers<'_> {
    fn create(&self, new: &NewUser) -> Result<User> {
        if new.email.trim().is_empty() || new.name.trim().is_empty() {
            return Err(Error::Invalid("email and name are required".into()));
        }
        let (id, now) = (new_id(), now_ms());
        self.0
            .execute(
                "INSERT INTO users (id, email, name, avatar_url, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                params![id, new.email, new.name, new.avatar_url, now],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<User> {
        self.0
            .query_row("SELECT * FROM users WHERE id = ?1", [id], user_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("user {id}")))
    }

    fn find_by_email(&self, email: &str) -> Result<Option<User>> {
        Ok(self
            .0
            .query_row("SELECT * FROM users WHERE email = ?1", [email], user_row)
            .optional()?)
    }

    fn list(&self) -> Result<Vec<User>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM users ORDER BY created_at, id")?;
        let rows = s
            .query_map([], user_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }
}

impl TeamRepo for SqliteTeams<'_> {
    fn create(&self, new: &NewTeam) -> Result<Team> {
        if new.name.trim().is_empty() || new.slug.trim().is_empty() {
            return Err(Error::Invalid("name and slug are required".into()));
        }
        let (id, now) = (new_id(), now_ms());
        self.0
            .execute(
                "INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?1,?2,?3,?4,?4)",
                params![id, new.name, new.slug, now],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<Team> {
        self.0
            .query_row("SELECT * FROM teams WHERE id = ?1", [id], team_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("team {id}")))
    }

    fn find_by_slug(&self, slug: &str) -> Result<Option<Team>> {
        Ok(self
            .0
            .query_row("SELECT * FROM teams WHERE slug = ?1", [slug], team_row)
            .optional()?)
    }

    fn list(&self) -> Result<Vec<Team>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM teams ORDER BY created_at, id")?;
        let rows = s
            .query_map([], team_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn add_member(&self, team_id: &str, user_id: &str, role: UserRole) -> Result<TeamMember> {
        let id = new_id();
        self.0
            .execute(
                "INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?1,?2,?3,?4,?5)",
                params![id, team_id, user_id, role, now_ms()],
            )
            .map_err(db_err)?;
        Ok(self.0.query_row(
            "SELECT * FROM team_members WHERE id = ?1",
            [&id],
            member_row,
        )?)
    }

    fn members(&self, team_id: &str) -> Result<Vec<TeamMember>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM team_members WHERE team_id = ?1 ORDER BY joined_at, id")?;
        let rows = s
            .query_map([team_id], member_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn set_role(&self, team_id: &str, user_id: &str, role: UserRole) -> Result<()> {
        let current: UserRole = self
            .0
            .query_row(
                "SELECT role FROM team_members WHERE team_id = ?1 AND user_id = ?2",
                [team_id, user_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("membership {team_id}/{user_id}")))?;
        if current == UserRole::Owner && role != UserRole::Owner && self.owner_count(team_id)? <= 1
        {
            return Err(Error::Conflict(
                "a team must keep at least one owner".into(),
            ));
        }
        self.0.execute(
            "UPDATE team_members SET role = ?3 WHERE team_id = ?1 AND user_id = ?2",
            params![team_id, user_id, role],
        )?;
        Ok(())
    }

    fn remove_member(&self, team_id: &str, user_id: &str) -> Result<bool> {
        let current: Option<UserRole> = self
            .0
            .query_row(
                "SELECT role FROM team_members WHERE team_id = ?1 AND user_id = ?2",
                [team_id, user_id],
                |r| r.get(0),
            )
            .optional()?;
        if current == Some(UserRole::Owner) && self.owner_count(team_id)? <= 1 {
            return Err(Error::Conflict(
                "a team must keep at least one owner".into(),
            ));
        }
        let n = self.0.execute(
            "DELETE FROM team_members WHERE team_id = ?1 AND user_id = ?2",
            [team_id, user_id],
        )?;
        Ok(n > 0)
    }
}

impl SqliteTeams<'_> {
    fn owner_count(&self, team_id: &str) -> Result<i64> {
        Ok(self.0.query_row(
            "SELECT COUNT(*) FROM team_members WHERE team_id = ?1 AND role = 'owner'",
            [team_id],
            |r| r.get(0),
        )?)
    }
}
