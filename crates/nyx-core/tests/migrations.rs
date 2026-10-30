#![allow(
    clippy::assert_is_empty,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    clippy::similar_names,
    clippy::unwrap_used,
    clippy::expect_used,
    missing_docs
)]
use nyx_core::store::migrate::{current_version, migrate};
use nyx_core::store::{Db, Migration, CORE_MIGRATIONS};
use nyx_core::Error;
use rusqlite::Connection;

fn tables(c: &Connection) -> Vec<String> {
    let mut s = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
    s.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn all_core_migrations_apply_cleanly_to_a_fresh_db() {
    let db = Db::open_in_memory().unwrap();
    assert_eq!(
        current_version(db.conn()).unwrap(),
        CORE_MIGRATIONS.last().unwrap().version
    );
    let t = tables(db.conn());
    for expected in [
        "users",
        "teams",
        "team_members",
        "lifecycles",
        "lifecycle_stages",
        "integrations",
        "documents",
        "document_versions",
        "document_branches",
        "snapshots",
        "tickets",
        "audit_trail",
        "doc_chunks",
        "code_chunks",
        "credit_entries",
        "credit_postings",
        "schema_migrations",
    ] {
        assert!(
            t.contains(&expected.to_string()),
            "missing table {expected}: {t:?}"
        );
    }
    for dropped in [
        "agent_sessions",
        "subscriptions",
        "stripe_events",
        "chat_messages",
        "credit_balances",
    ] {
        assert!(
            !t.contains(&dropped.to_string()),
            "{dropped} must not exist"
        );
    }
}

#[test]
fn migrations_are_idempotent() {
    let mut c = Connection::open_in_memory().unwrap();
    let first = migrate(&mut c, CORE_MIGRATIONS).unwrap();
    assert_eq!(first.len(), CORE_MIGRATIONS.len());
    assert!(migrate(&mut c, CORE_MIGRATIONS).unwrap().is_empty());
}

#[test]
fn versions_must_be_strictly_increasing() {
    let mut c = Connection::open_in_memory().unwrap();
    let bad = [
        Migration {
            version: 2,
            name: "b",
            sql: "CREATE TABLE b(x)",
        },
        Migration {
            version: 1,
            name: "a",
            sql: "CREATE TABLE a(x)",
        },
    ];
    assert!(matches!(migrate(&mut c, &bad), Err(Error::Migration(_))));
}

#[test]
fn edited_applied_migration_is_rejected() {
    let mut c = Connection::open_in_memory().unwrap();
    migrate(
        &mut c,
        &[Migration {
            version: 1,
            name: "a",
            sql: "CREATE TABLE a(x)",
        }],
    )
    .unwrap();
    let err = migrate(
        &mut c,
        &[Migration {
            version: 1,
            name: "a",
            sql: "CREATE TABLE a(x, y)",
        }],
    )
    .unwrap_err();
    assert!(err.to_string().contains("edited"), "{err}");
}

#[test]
fn database_newer_than_binary_is_rejected() {
    let mut c = Connection::open_in_memory().unwrap();
    migrate(
        &mut c,
        &[
            Migration {
                version: 1,
                name: "a",
                sql: "CREATE TABLE a(x)",
            },
            Migration {
                version: 2,
                name: "b",
                sql: "CREATE TABLE b(x)",
            },
        ],
    )
    .unwrap();
    let err = migrate(
        &mut c,
        &[Migration {
            version: 1,
            name: "a",
            sql: "CREATE TABLE a(x)",
        }],
    )
    .unwrap_err();
    assert!(err.to_string().contains("unknown"), "{err}");
}

#[test]
fn failing_migration_rolls_back_and_is_not_recorded() {
    let mut c = Connection::open_in_memory().unwrap();
    let ms = [Migration {
        version: 1,
        name: "boom",
        sql: "CREATE TABLE ok(x); CREATE TABLE ok(x);",
    }];
    assert!(matches!(migrate(&mut c, &ms), Err(Error::Migration(_))));
    assert_eq!(current_version(&c).unwrap(), 0);
    assert!(!tables(&c).contains(&"ok".to_string()));
}

#[test]
fn new_migrations_apply_on_top_of_existing_db() {
    let mut c = Connection::open_in_memory().unwrap();
    let v1 = [Migration {
        version: 1,
        name: "a",
        sql: "CREATE TABLE a(x)",
    }];
    migrate(&mut c, &v1).unwrap();
    let v2 = [
        v1[0],
        Migration {
            version: 2,
            name: "b",
            sql: "CREATE TABLE b(x)",
        },
    ];
    assert_eq!(migrate(&mut c, &v2).unwrap(), vec![2]);
}

#[test]
fn extra_migrations_extend_core_and_foreign_keys_are_on() {
    let db = Db::open_in_memory_with(&[Migration {
        version: 100,
        name: "extra",
        sql: "CREATE TABLE extra(id TEXT PRIMARY KEY)",
    }])
    .unwrap();
    assert!(tables(db.conn()).contains(&"extra".to_string()));
    let fk: i64 = db
        .conn()
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
}

#[test]
fn file_database_reopens_without_reapplying() {
    let dir = std::env::temp_dir().join(format!("nyx-core-test-{}", nyx_core::model::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("nyx.db");
    {
        let db = Db::open(&path).unwrap();
        db.conn()
            .execute(
                "INSERT INTO teams (id,name,slug,created_at,updated_at) VALUES ('t','T','t',1,1)",
                [],
            )
            .unwrap();
    }
    let db = Db::open(&path).unwrap();
    let n: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM teams", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    std::fs::remove_dir_all(dir).unwrap();
}
