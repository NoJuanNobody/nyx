//! Product version control: diff, three-way merge, branches, timeline, snapshots, approvals and
//! change proposals, as service functions over the [`store`](crate::store) repositories.
//!
//! Ported from the TypeScript services `version.service.ts`, `branch.service.ts`,
//! `snapshot.service.ts`, `timeline.service.ts`, `approval.service.ts` and
//! `change-proposal.service.ts` (see `docs/rust-core/vcs.md` for the mapping and parity gaps).
//!
//! Conventions:
//! - Services are free functions taking `&Connection` (a `&Transaction` derefs to one). Multi-step
//!   operations wrap themselves in a SQLite savepoint, so they are atomic whether or not the caller
//!   already opened a transaction.
//! - Time-sensitive functions have an `_at(.., now)` twin taking an explicit timestamp for tests.
//! - Anything that talks to the outside (LLM analysis, ticket providers) sits behind a small trait.
//!
//! Modules: [`diff`] (line/word diff), [`merge`] (three-way merge), [`version`], [`branch`],
//! [`timeline`], [`snapshot`], [`approval`], [`proposal`].

pub mod approval;
pub mod branch;
pub mod diff;
pub mod merge;
pub mod proposal;
pub mod snapshot;
pub mod timeline;
pub mod version;

use rusqlite::Connection;

use crate::error::Result;
use crate::model::new_id;

/// Run `f` inside a savepoint: released on `Ok`, rolled back on `Err`. Works with or without an
/// enclosing transaction.
pub(crate) fn atomic<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let name = format!("vcs_{}", new_id().replace('-', ""));
    conn.execute_batch(&format!("SAVEPOINT {name}"))?;
    match f() {
        Ok(v) => {
            conn.execute_batch(&format!("RELEASE {name}"))?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
            Err(e)
        }
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use crate::model::{Document, NewDocument, NewTeam, NewUser, Team, User, UserRole};
    use crate::store::{
        Db, DocumentRepo, SqliteDocuments, SqliteTeams, SqliteUsers, TeamRepo, UserRepo,
    };

    pub struct Fx {
        pub db: Db,
        pub user: User,
        pub other: User,
        pub team: Team,
    }

    pub fn fx() -> Fx {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let mk = |email: &str, name: &str| {
            SqliteUsers::new(c)
                .create(&NewUser {
                    email: email.into(),
                    name: name.into(),
                    avatar_url: None,
                })
                .unwrap()
        };
        let user = mk("a@example.com", "Ada");
        let other = mk("b@example.com", "Bob");
        let teams = SqliteTeams::new(c);
        let team = teams
            .create(&NewTeam {
                name: "Core".into(),
                slug: "core".into(),
            })
            .unwrap();
        teams
            .add_member(&team.id, &user.id, UserRole::Owner)
            .unwrap();
        Fx {
            db,
            user,
            other,
            team,
        }
    }

    pub fn doc(f: &Fx, content: &str) -> Document {
        SqliteDocuments::new(f.db.conn())
            .create(&NewDocument {
                title: "Spec".into(),
                content: content.into(),
                path: String::new(),
                team_id: f.team.id.clone(),
                created_by_id: f.user.id.clone(),
                stage: None,
                lifecycle_id: None,
            })
            .unwrap()
    }
}
