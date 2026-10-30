#![allow(
    clippy::assert_is_empty,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    clippy::similar_names,
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    missing_docs
)]
use nyx_core::model::{Document, UserRole};
use nyx_core::model::{NewDocument, NewTeam, NewUser, Team, User};
use nyx_core::store::{
    Db, DocumentRepo, SqliteDocuments, SqliteTeams, SqliteUsers, TeamRepo, UserRepo,
};

pub struct Fixture {
    pub db: Db,
    pub user: User,
    pub team: Team,
}

pub fn fixture() -> Fixture {
    let db = Db::open_in_memory().unwrap();
    let (user, team) = {
        let c = db.conn();
        let user = SqliteUsers::new(c)
            .create(&NewUser {
                email: "a@example.com".into(),
                name: "Ada".into(),
                avatar_url: None,
            })
            .unwrap();
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
        (user, team)
    };
    Fixture { db, user, team }
}

pub fn new_doc(f: &Fixture, title: &str, content: &str) -> Document {
    SqliteDocuments::new(f.db.conn())
        .create(&NewDocument {
            title: title.into(),
            content: content.into(),
            path: String::new(),
            team_id: f.team.id.clone(),
            created_by_id: f.user.id.clone(),
            stage: None,
            lifecycle_id: None,
        })
        .unwrap()
}
