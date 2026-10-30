#![allow(
    clippy::assert_is_empty,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    clippy::similar_names,
    clippy::unwrap_used,
    clippy::expect_used,
    missing_docs
)]
mod common;

use common::{fixture, new_doc};
use nyx_core::model::*;
use nyx_core::store::*;
use nyx_core::Error;
use serde_json::json;

#[test]
fn users_and_teams_enforce_uniqueness_and_owner_rule() {
    let f = fixture();
    let c = f.db.conn();
    let users = SqliteUsers::new(c);
    let teams = SqliteTeams::new(c);

    let dup = users.create(&NewUser {
        email: "a@example.com".into(),
        name: "X".into(),
        avatar_url: None,
    });
    assert!(matches!(dup, Err(Error::Conflict(_))));
    assert_eq!(
        users.find_by_email("a@example.com").unwrap().unwrap().id,
        f.user.id
    );
    assert!(matches!(users.get("nope"), Err(Error::NotFound(_))));
    assert!(matches!(
        teams.create(&NewTeam {
            name: "Dup".into(),
            slug: "core".into()
        }),
        Err(Error::Conflict(_))
    ));

    // duplicate membership
    assert!(matches!(
        teams.add_member(&f.team.id, &f.user.id, UserRole::Viewer),
        Err(Error::Conflict(_))
    ));
    // last owner is protected
    assert!(matches!(
        teams.set_role(&f.team.id, &f.user.id, UserRole::Admin),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        teams.remove_member(&f.team.id, &f.user.id),
        Err(Error::Conflict(_))
    ));

    let u2 = users
        .create(&NewUser {
            email: "b@example.com".into(),
            name: "Bo".into(),
            avatar_url: Some("x".into()),
        })
        .unwrap();
    teams
        .add_member(&f.team.id, &u2.id, UserRole::Editor)
        .unwrap();
    teams.set_role(&f.team.id, &u2.id, UserRole::Owner).unwrap();
    teams
        .set_role(&f.team.id, &f.user.id, UserRole::Admin)
        .unwrap();
    assert_eq!(teams.members(&f.team.id).unwrap().len(), 2);
    assert!(teams.remove_member(&f.team.id, &f.user.id).unwrap());
    assert!(!teams.remove_member(&f.team.id, &f.user.id).unwrap());
}

#[test]
fn foreign_keys_are_enforced() {
    let f = fixture();
    let r = SqliteDocuments::new(f.db.conn()).create(&NewDocument {
        title: "x".into(),
        content: String::new(),
        path: "/".into(),
        team_id: "missing".into(),
        created_by_id: f.user.id.clone(),
        stage: None,
        lifecycle_id: None,
    });
    assert!(matches!(r, Err(Error::Invalid(_))), "{r:?}");
}

#[test]
fn lifecycle_stages_roundtrip_and_single_default() {
    let f = fixture();
    let lc = SqliteLifecycles::new(f.db.conn());
    let a = lc
        .create(&NewLifecycle {
            is_default: true,
            ..NewLifecycle::new("standard", "Standard")
        })
        .unwrap();
    assert!(a.is_default);
    let b = lc
        .create(&NewLifecycle {
            is_default: true,
            ..NewLifecycle::new("lean", "Lean")
        })
        .unwrap();
    assert_eq!(lc.default_lifecycle().unwrap().unwrap().id, b.id);
    assert!(!lc.get(&a.id).unwrap().is_default);
    assert!(matches!(
        lc.create(&NewLifecycle::new("lean", "Again")),
        Err(Error::Conflict(_))
    ));

    let mut s2 = LifecycleStage::draft(&a.id, "definition", "Definition", 2);
    s2.docs = vec!["PRD".into(), "Brief".into()];
    let s1 = LifecycleStage::draft(&a.id, "conception", "Conception", 1);
    lc.add_stage(&s2).unwrap();
    lc.add_stage(&s1).unwrap();
    assert!(matches!(lc.add_stage(&s1), Err(Error::Conflict(_))));
    let stages = lc.stages(&a.id).unwrap();
    assert_eq!(
        stages.iter().map(|s| s.slug.as_str()).collect::<Vec<_>>(),
        ["conception", "definition"]
    );
    assert_eq!(stages[1].docs, vec!["PRD", "Brief"]);
    assert_eq!(stages[0].hex, "#888888");

    // cascade
    assert!(lc.delete(&a.id).unwrap());
    assert!(lc.stages(&a.id).unwrap().is_empty());
}

#[test]
fn documents_crud_soft_delete_and_stage() {
    let f = fixture();
    let docs = SqliteDocuments::new(f.db.conn());
    let d = new_doc(&f, "Spec", "v1");
    assert_eq!(d.path, "/");
    assert_eq!(docs.versions(&d.id).unwrap().len(), 1);

    let d = docs
        .update_meta(&d.id, Some("Spec 2"), Some("/specs"))
        .unwrap();
    assert_eq!((d.title.as_str(), d.path.as_str()), ("Spec 2", "/specs"));
    assert!(matches!(
        docs.update_meta(&d.id, Some("  "), None),
        Err(Error::Invalid(_))
    ));

    let d = docs.set_stage(&d.id, Some("definition"), None).unwrap();
    assert_eq!(
        docs.list_by_stage(&f.team.id, "definition").unwrap().len(),
        1
    );
    assert!(docs.list_by_stage(&f.team.id, "other").unwrap().is_empty());

    assert!(docs.soft_delete(&d.id).unwrap());
    assert!(!docs.soft_delete(&d.id).unwrap());
    assert!(docs.list_live(&f.team.id).unwrap().is_empty());
    assert!(docs.get(&d.id).unwrap().deleted_at.is_some());
    assert!(matches!(
        docs.save_content(&d.id, "x", None, &f.user.id),
        Err(Error::Conflict(_))
    ));
    assert!(docs.restore(&d.id).unwrap());
    assert_eq!(docs.list_live(&f.team.id).unwrap().len(), 1);
}

#[test]
fn snapshots_integrations_tickets() {
    let f = fixture();
    let d = new_doc(&f, "Spec", "x");
    let integ = SqliteIntegrations::new(f.db.conn());
    let i = integ
        .create(&NewIntegration {
            team_id: f.team.id.clone(),
            r#type: IntegrationType::Github,
            config: json!({"repo":"a/b"}),
        })
        .unwrap();
    assert_eq!(i.config["repo"], "a/b");
    let i = integ.update_config(&i.id, &json!({"repo":"c/d"})).unwrap();
    assert_eq!(i.config["repo"], "c/d");
    assert_eq!(integ.list(&f.team.id).unwrap().len(), 1);

    let snaps = SqliteSnapshots::new(f.db.conn());
    let s = snaps
        .create(&NewSnapshot {
            document_id: d.id.clone(),
            integration_id: Some(i.id.clone()),
            external_ref: "abc123".into(),
            content: "code".into(),
        })
        .unwrap();
    assert_eq!(snaps.latest(&d.id).unwrap().unwrap().id, s.id);
    // referenced integration cannot be deleted
    assert!(matches!(integ.delete(&i.id), Err(Error::Invalid(_))));
    let bad = snaps.create(&NewSnapshot {
        document_id: d.id.clone(),
        integration_id: Some("nope".into()),
        external_ref: "r".into(),
        content: String::new(),
    });
    assert!(matches!(bad, Err(Error::Invalid(_))));

    let tickets = SqliteTickets::new(f.db.conn());
    let t = tickets
        .create(&NewTicket {
            document_id: d.id.clone(),
            provider: TicketProvider::Github,
            external_id: "42".into(),
            external_url: "https://github.com/a/b/issues/42".into(),
            title: "Fix".into(),
            body: String::new(),
            insights: Some(json!({"risk":"low"})),
            created_by_id: f.user.id.clone(),
        })
        .unwrap();
    assert_eq!(t.status, TicketStatus::Open);
    assert_eq!(t.insights.as_ref().unwrap()["risk"], "low");
    let t = tickets.set_status(&t.id, TicketStatus::InProgress).unwrap();
    assert_eq!(t.status, TicketStatus::InProgress);
    let t = tickets.update(&t.id, Some("Fix it"), None, None).unwrap();
    assert_eq!((t.title.as_str(), t.insights.is_some()), ("Fix it", true));
    assert_eq!(
        tickets
            .find_external(TicketProvider::Github, "42")
            .unwrap()
            .unwrap()
            .id,
        t.id
    );
    assert!(tickets
        .find_external(TicketProvider::Jira, "42")
        .unwrap()
        .is_none());
    assert_eq!(tickets.list_by_document(&d.id).unwrap().len(), 1);
}

#[test]
fn audit_log_is_append_only_and_ordered() {
    let f = fixture();
    let d = new_doc(&f, "Spec", "x");
    let audit = SqliteAudit::new(f.db.conn());
    let mut e1 = NewAuditEvent::new(&f.team.id, AuditEventType::DocEdit);
    e1.document_id = Some(d.id.clone());
    e1.actor_id = Some(f.user.id.clone());
    e1.metadata = json!({"version": 2});
    let a = audit.append(&e1).unwrap();
    let mut e2 = NewAuditEvent::new(&f.team.id, AuditEventType::CodeCommit);
    e2.parent_event_id = Some(a.id.clone());
    e2.commit_sha = Some("deadbeef".into());
    let b = audit.append(&e2).unwrap();

    let list = audit.list_by_team(&f.team.id, 10).unwrap();
    assert_eq!(
        list.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        [b.id.as_str(), a.id.as_str()]
    );
    assert_eq!(audit.list_by_document(&d.id, 10).unwrap().len(), 1);
    assert_eq!(audit.list_by_team(&f.team.id, 1).unwrap().len(), 1);
    assert_eq!(a.metadata["version"], 2);

    let upd =
        f.db.conn()
            .execute("UPDATE audit_trail SET commit_sha='x'", []);
    assert!(upd.unwrap_err().to_string().contains("append-only"));
    let del = f.db.conn().execute("DELETE FROM audit_trail", []);
    assert!(del.unwrap_err().to_string().contains("append-only"));
}

#[test]
fn every_enum_value_is_accepted_by_its_check_constraint() {
    let f = fixture();
    let c = f.db.conn();
    let d = new_doc(&f, "Spec", "x");
    for r in UserRole::ALL {
        let u = SqliteUsers::new(c)
            .create(&NewUser {
                email: format!("{r}@x.io"),
                name: "n".into(),
                avatar_url: None,
            })
            .unwrap();
        SqliteTeams::new(c)
            .add_member(&f.team.id, &u.id, *r)
            .unwrap();
    }
    for t in IntegrationType::ALL {
        SqliteIntegrations::new(c)
            .create(&NewIntegration {
                team_id: f.team.id.clone(),
                r#type: *t,
                config: json!({}),
            })
            .unwrap();
    }
    for p in TicketProvider::ALL {
        for s in TicketStatus::ALL {
            let t = SqliteTickets::new(c)
                .create(&NewTicket {
                    document_id: d.id.clone(),
                    provider: *p,
                    external_id: "1".into(),
                    external_url: "u".into(),
                    title: "t".into(),
                    body: String::new(),
                    insights: None,
                    created_by_id: f.user.id.clone(),
                })
                .unwrap();
            SqliteTickets::new(c).set_status(&t.id, *s).unwrap();
        }
    }
    for e in AuditEventType::ALL {
        SqliteAudit::new(c)
            .append(&NewAuditEvent::new(&f.team.id, *e))
            .unwrap();
    }
    for s in BranchStatus::ALL {
        c.execute("DELETE FROM document_branches", []).unwrap();
        let v = SqliteDocuments::new(c).latest_version(&d.id).unwrap();
        c.execute(
            "INSERT INTO document_branches (id,document_id,name,base_version_id,content,created_by_id,status,created_at) VALUES ('b',?1,'n',?2,'',?3,?4,1)",
            rusqlite::params![d.id, v.id, f.user.id, s],
        )
        .unwrap();
    }
    assert!("bogus".parse::<UserRole>().is_err());
}

#[test]
fn chunks_store_vectors_and_search_by_cosine() {
    let mut f = fixture();
    let d = new_doc(&f, "Spec", "x");
    let (team, doc) = (f.team.id.clone(), d.id.clone());
    let chunk = |idx: i64, v: Option<Vec<f32>>| NewDocChunk {
        doc_id: doc.clone(),
        org_id: team.clone(),
        content: format!("chunk {idx}"),
        embedding: v,
        embedding_model: Some("test-model".into()),
        version: 1,
        chunk_index: idx,
    };
    f.db.transaction(|c| {
        let ch = SqliteChunks::new(c);
        ch.replace_doc_chunks(
            &doc,
            1,
            &[
                chunk(0, Some(vec![1.0, 0.0])),
                chunk(1, Some(vec![0.0, 1.0])),
                chunk(2, Some(vec![0.9, 0.1])),
                chunk(3, None),
            ],
        )?;
        // replacing again is idempotent in count
        let again = ch.replace_doc_chunks(
            &doc,
            1,
            &[
                chunk(0, Some(vec![1.0, 0.0])),
                chunk(1, Some(vec![0.0, 1.0])),
                chunk(2, Some(vec![0.9, 0.1])),
                chunk(3, None),
            ],
        )?;
        assert_eq!(again.len(), 4);
        assert_eq!(again[0].embedding.as_deref(), Some(&[1.0, 0.0][..]));
        assert!(again[3].embedding.is_none());
        let hits = ch.search_doc_chunks(&team, &[1.0, 0.0], 2)?;
        assert_eq!(
            hits.iter().map(|(c, _)| c.chunk_index).collect::<Vec<_>>(),
            [0, 2]
        );
        assert!(hits[0].1 > hits[1].1);
        // other dimension is skipped, not an error
        assert!(ch.search_doc_chunks(&team, &[1.0, 0.0, 0.0], 5)?.is_empty());
        assert!(matches!(
            ch.replace_doc_chunks(&doc, 1, &[chunk(0, Some(vec![f32::NAN]))]),
            Err(Error::Invalid(_))
        ));
        Ok(())
    })
    .unwrap();

    let ch = SqliteChunks::new(f.db.conn());
    for (i, p) in ["a.rs", "b.rs"].iter().enumerate() {
        ch.insert_code_chunk(&NewCodeChunk {
            team_id: team.clone(),
            file_path: (*p).into(),
            content: "fn".into(),
            embedding: Some(vec![i as f32, 1.0]),
            embedding_model: None,
            repo_full_name: "a/b".into(),
            commit_sha: None,
            chunk_index: 0,
        })
        .unwrap();
    }
    assert_eq!(ch.code_chunks(&team, "a/b").unwrap().len(), 2);
    assert_eq!(
        ch.search_code_chunks(&team, &[1.0, 1.0], 1).unwrap()[0]
            .0
            .file_path,
        "b.rs"
    );
    assert_eq!(ch.delete_code_chunks(&team, "a/b").unwrap(), 2);
    // blob/dim CHECK
    let bad = f.db.conn().execute("INSERT INTO code_chunks (id,team_id,file_path,content,embedding,embedding_dim,repo_full_name,chunk_index,created_at) VALUES ('x',?1,'f','c',x'00',2,'r',0,1)", [&team]);
    assert!(bad.is_err());
}

#[test]
fn transaction_rolls_back_on_error() {
    let mut f = fixture();
    let team = f.team.id.clone();
    let user = f.user.id.clone();
    let res: nyx_core::Result<()> = f.db.transaction(|c| {
        SqliteDocuments::new(c).create(&NewDocument {
            title: "tmp".into(),
            content: "x".into(),
            path: "/".into(),
            team_id: team.clone(),
            created_by_id: user.clone(),
            stage: None,
            lifecycle_id: None,
        })?;
        Err(Error::Invalid("abort".into()))
    });
    assert!(res.is_err());
    assert!(SqliteDocuments::new(f.db.conn())
        .list_live(&team)
        .unwrap()
        .is_empty());
}

#[test]
fn embedding_encoding_roundtrips() {
    let v = vec![0.5_f32, -1.25, 3.0];
    assert_eq!(decode_embedding(&encode_embedding(&v)).unwrap(), v);
    assert!(decode_embedding(&[1, 2, 3]).is_err());
    assert!((cosine_similarity(&[1.0, 2.0], &[2.0, 4.0]) - 1.0).abs() < 1e-6);
    assert!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]).abs() < f32::EPSILON);
}
