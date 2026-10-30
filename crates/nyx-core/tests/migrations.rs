#![allow(
    clippy::assert_is_empty,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    clippy::similar_names,
    clippy::unwrap_used,
    clippy::too_many_lines,
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
        version: 100_000,
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

// ---------------------------------------------------------------- 180: tickets gain 'linear'

fn count(c: &Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn migration_180_widens_ticket_provider_and_keeps_data_and_references() {
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    let before: Vec<Migration> = CORE_MIGRATIONS
        .iter()
        .copied()
        .filter(|m| m.version < 180)
        .collect();
    migrate(&mut c, &before).unwrap();

    // Pre-180: 'linear' is refused, and there is data hanging off tickets(id).
    c.execute_batch(
        "INSERT INTO users VALUES ('u1','u@x.io','U',NULL,1,1);
         INSERT INTO teams VALUES ('t1','T','t',1,1);
         INSERT INTO documents (id,title,team_id,created_by_id,created_at,updated_at)
           VALUES ('d1','Spec','t1','u1',1,1);
         INSERT INTO tickets VALUES ('k1','d1','github','12','https://github.com/a/b/issues/12',
           'Old','body','in_progress','{\"x\":1}','u1',5,6);
         INSERT INTO tickets VALUES ('k2','d1','jira','P-1','https://a.atlassian.net/browse/P-1',
           'Jira','','closed',NULL,'u1',7,8);
         INSERT INTO audit_trail (id,team_id,event_type,actor_id,document_id,ticket_id,metadata,created_at)
           VALUES ('a1','t1','ticket_created','u1','d1','k1','{}',9);
         INSERT INTO ticket_drafts (id,batch_id,document_id,title,body,labels,dedupe_key,status,
             external_provider,external_id,external_url,destination_key,ticket_id,created_by_id,
             created_at,updated_at)
           VALUES ('dr1','b','d1','On GH','','[]','k1','posted','github','12',
             'https://github.com/a/b/issues/12','github:a/b','k1','u1',1,1);
         INSERT INTO ticket_drafts (id,batch_id,document_id,title,body,labels,dedupe_key,status,
             external_provider,external_id,external_url,destination_key,ticket_id,created_by_id,
             created_at,updated_at)
           VALUES ('dr2','b','d1','On Linear','Do it','[\"bug\"]','k2','posted','linear','ENG-42',
             'https://linear.app/acme/issue/ENG-42/on-linear','linear:team',NULL,'u1',1,3);
         INSERT INTO ticket_drafts (id,batch_id,document_id,title,dedupe_key,status,created_by_id,
             created_at,updated_at)
           VALUES ('dr3','b','d1','Not posted','k3','draft','u1',1,1);",
    )
    .unwrap();
    assert!(c
        .execute(
            "INSERT INTO tickets VALUES ('x','d1','linear','L-1','u','t','','open',NULL,'u1',1,1)",
            []
        )
        .is_err());

    assert_eq!(migrate(&mut c, CORE_MIGRATIONS).unwrap(), vec![180]);

    // Existing rows survive unchanged.
    let (status, insights, created, updated): (String, String, i64, i64) = c
        .query_row(
            "SELECT status, claude_insights, created_at, updated_at FROM tickets WHERE id='k1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (status.as_str(), insights.as_str(), created, updated),
        ("in_progress", "{\"x\":1}", 5, 6)
    );
    assert_eq!(
        count(&c, "SELECT COUNT(*) FROM tickets WHERE provider<>'linear'"),
        2
    );

    // References still resolve and the foreign keys are intact.
    assert_eq!(
        count(&c, "SELECT COUNT(*) FROM audit_trail WHERE ticket_id='k1'"),
        1
    );
    c.pragma_update(None, "foreign_keys", true).unwrap();
    let violations: i64 = c
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
    assert!(
        c.execute("DELETE FROM tickets WHERE id='k1'", []).is_err(),
        "audit_trail/ticket_drafts still reference tickets(id)"
    );

    // 'linear' is now accepted; unknown providers are still refused; the index is back.
    c.execute(
        "INSERT INTO tickets VALUES ('x','d1','linear','L-1','u','t','','open',NULL,'u1',1,1)",
        [],
    )
    .unwrap();
    assert!(c
        .execute(
            "INSERT INTO tickets VALUES ('y','d1','asana','L-1','u','t','','open',NULL,'u1',1,1)",
            []
        )
        .is_err());
    assert_eq!(
        count(
            &c,
            "SELECT COUNT(*) FROM sqlite_master WHERE name='tickets_document_idx'"
        ),
        1
    );

    // Backfill: the posted Linear draft got a board row and a link; nothing else did.
    let (tid, ext_id, title, body, st): (String, String, String, String, String) = c
        .query_row(
            "SELECT t.id, t.external_id, t.title, t.body, t.status FROM ticket_drafts d
             JOIN tickets t ON t.id = d.ticket_id WHERE d.id='dr2'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(tid.len(), 36, "uuid-shaped id: {tid}");
    assert_eq!(
        (ext_id.as_str(), title.as_str(), body.as_str(), st.as_str()),
        ("ENG-42", "On Linear", "Do it", "open")
    );
    let ins: String = c
        .query_row(
            "SELECT claude_insights FROM tickets WHERE id=?1",
            [&tid],
            |r| r.get(0),
        )
        .unwrap();
    assert!(ins.contains("\"draftId\":\"dr2\"") && ins.contains("\"bug\""));
    assert_eq!(
        count(
            &c,
            "SELECT COUNT(*) FROM ticket_drafts WHERE id='dr3' AND ticket_id IS NULL"
        ),
        1
    );
    assert_eq!(
        count(
            &c,
            "SELECT COUNT(*) FROM ticket_drafts WHERE id='dr1' AND ticket_id='k1'"
        ),
        1
    );
    assert_eq!(count(&c, "SELECT COUNT(*) FROM tickets"), 4);
}

#[test]
fn migration_180_on_an_empty_tickets_table_is_clean() {
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    assert_eq!(migrate(&mut c, CORE_MIGRATIONS).unwrap().last(), Some(&180));
    assert_eq!(count(&c, "SELECT COUNT(*) FROM tickets"), 0);
    assert_eq!(
        count(&c, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
        0
    );
}
