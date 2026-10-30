#![allow(
    clippy::assert_is_empty,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::similar_names,
    dead_code,
    missing_docs
)]
mod common;

use common::{fixture, Fixture};
use nyx_core::model::{NewDocument, NewTeam};
use nyx_core::store::{DocumentRepo, SqliteDocuments, SqliteTeams, TeamRepo};
use nyx_core::tree::{ChildRef, DeletePolicy, NodeKind, Resolved, SqliteTree};
use nyx_core::Error;

fn doc(f: &Fixture, title: &str, path: &str) -> String {
    SqliteDocuments::new(f.db.conn())
        .create(&NewDocument {
            title: title.into(),
            content: String::new(),
            path: path.into(),
            team_id: f.team.id.clone(),
            created_by_id: f.user.id.clone(),
            stage: None,
            lifecycle_id: None,
        })
        .unwrap()
        .id
}

fn names(f: &Fixture, parent: &str) -> Vec<String> {
    SqliteTree::new(f.db.conn())
        .subtree(&f.team.id, parent)
        .unwrap()
        .children
        .iter()
        .map(|c| c.name.clone())
        .collect()
}

#[test]
fn create_requires_parent_and_rejects_duplicates_and_bad_names() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    let a = t.create_folder(team, "/", "A").unwrap();
    assert_eq!(a.path, "/A");
    t.create_folder(team, "/A", "Child").unwrap();
    assert!(matches!(
        t.create_folder(team, "/A", "Child"),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        t.create_folder(team, "/Missing", "X"),
        Err(Error::NotFound(_))
    ));
    for bad in ["", "a/b", "..", "."] {
        assert!(matches!(
            t.create_folder(team, "/", bad),
            Err(Error::Invalid(_))
        ));
    }
    // a different team may reuse the path
    let other = SqliteTeams::new(f.db.conn());
    let team2 = other
        .create(&NewTeam {
            name: "Two".into(),
            slug: "two".into(),
        })
        .unwrap();
    t.create_folder(&team2.id, "/", "A").unwrap();
}

#[test]
fn ensure_folder_path_is_mkdir_p_and_idempotent() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let made = t.ensure_folder_path(&f.team.id, "/x/y/z").unwrap();
    assert_eq!(made.len(), 3);
    assert!(t
        .ensure_folder_path(&f.team.id, "/x/y/z")
        .unwrap()
        .is_empty());
    assert!(t.folder_exists(&f.team.id, "/x/y").unwrap());
    assert!(!t.folder_exists(&f.team.id, "/x/q").unwrap());
}

#[test]
fn implicit_folders_from_document_paths_exist_and_can_be_materialised() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    doc(&f, "Spec", "/specs/api");
    assert!(t.folder_exists(&f.team.id, "/specs").unwrap());
    assert!(t.folder_exists(&f.team.id, "/specs/api").unwrap());
    let made = t.create_folder(&f.team.id, "/", "specs").unwrap();
    assert_eq!(made.path, "/specs");
    assert!(matches!(
        t.create_folder(&f.team.id, "/", "specs"),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn rename_rewrites_descendant_folders_and_documents_segment_aware() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    t.ensure_folder_path(team, "/A/Child").unwrap();
    t.ensure_folder_path(team, "/Apple").unwrap();
    let d1 = doc(&f, "In A", "/A");
    let d2 = doc(&f, "Deep", "/A/Child");
    let d3 = doc(&f, "Apple doc", "/Apple");

    let np = t.rename_folder(team, "/A", "Z").unwrap();
    assert_eq!(np, "/Z");
    let docs = SqliteDocuments::new(f.db.conn());
    assert_eq!(docs.get(&d1).unwrap().path, "/Z");
    assert_eq!(docs.get(&d2).unwrap().path, "/Z/Child");
    assert_eq!(docs.get(&d3).unwrap().path, "/Apple");
    assert!(t.folder_exists(team, "/Z/Child").unwrap());
    assert!(!t.folder_exists(team, "/A").unwrap());
    assert!(t.folder_exists(team, "/Apple").unwrap());

    assert!(matches!(
        t.rename_folder(team, "/Z", "Apple"),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        t.rename_folder(team, "/", "x"),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        t.rename_folder(team, "/nope", "x"),
        Err(Error::NotFound(_))
    ));
    // renaming to the same name is a no-op
    assert_eq!(t.rename_folder(team, "/Z", "Z").unwrap(), "/Z");
}

#[test]
fn rename_of_an_implicit_folder_works() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let d = doc(&f, "Spec", "/old/sub");
    assert_eq!(t.rename_folder(&f.team.id, "/old", "new").unwrap(), "/new");
    assert_eq!(
        SqliteDocuments::new(f.db.conn()).get(&d).unwrap().path,
        "/new/sub"
    );
}

#[test]
fn move_folder_prevents_cycles_and_clashes() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    t.ensure_folder_path(team, "/A/Child/Grand").unwrap();
    t.ensure_folder_path(team, "/B").unwrap();
    let d = doc(&f, "Deep", "/A/Child/Grand");

    for dest in ["/A", "/A/Child", "/A/Child/Grand"] {
        assert!(
            matches!(t.move_folder(team, "/A", dest), Err(Error::Invalid(_))),
            "{dest}"
        );
    }
    assert!(matches!(
        t.move_folder(team, "/", "/B"),
        Err(Error::Invalid(_))
    ));
    assert_eq!(t.move_folder(team, "/A/Child", "/B").unwrap(), "/B/Child");
    assert_eq!(
        SqliteDocuments::new(f.db.conn()).get(&d).unwrap().path,
        "/B/Child/Grand"
    );
    // back to the root
    assert_eq!(t.move_folder(team, "/B/Child", "/").unwrap(), "/Child");
    // moving into the same parent is a no-op
    assert_eq!(t.move_folder(team, "/Child", "/").unwrap(), "/Child");
    // clash
    t.create_folder(team, "/B", "Child").unwrap();
    assert!(matches!(
        t.move_folder(team, "/Child", "/B"),
        Err(Error::Conflict(_))
    ));
    // a sibling whose name merely shares a prefix is not a descendant
    t.ensure_folder_path(team, "/Apple").unwrap();
    assert_eq!(t.move_folder(team, "/Apple", "/A").unwrap(), "/A/Apple");
    assert!(matches!(
        t.move_folder(team, "/A", "/Missing"),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn failed_operations_leave_no_partial_state() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    t.ensure_folder_path(team, "/A/B").unwrap();
    let d = doc(&f, "D", "/A/B");
    assert!(t.move_folder(team, "/A", "/A/B").is_err());
    assert!(t.folder_exists(team, "/A/B").unwrap());
    assert_eq!(
        SqliteDocuments::new(f.db.conn()).get(&d).unwrap().path,
        "/A/B"
    );
}

#[test]
fn delete_folder_policies() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    t.ensure_folder_path(team, "/A/B").unwrap();
    let d1 = doc(&f, "One", "/A");
    let d2 = doc(&f, "Two", "/A/B");
    let keep = doc(&f, "Keep", "/");

    assert!(matches!(
        t.delete_folder(team, "/A", DeletePolicy::RefuseIfNotEmpty),
        Err(Error::Conflict(_))
    ));
    let r = t.delete_folder(team, "/A", DeletePolicy::Cascade).unwrap();
    assert_eq!((r.folders_removed, r.documents_deleted), (2, 2));
    let docs = SqliteDocuments::new(f.db.conn());
    assert!(docs.get(&d1).unwrap().deleted_at.is_some());
    assert!(docs.get(&d2).unwrap().deleted_at.is_some());
    assert!(docs.get(&keep).unwrap().deleted_at.is_none());
    assert!(!t.folder_exists(team, "/A").unwrap());

    t.create_folder(team, "/", "Empty").unwrap();
    let r = t
        .delete_folder(team, "/Empty", DeletePolicy::RefuseIfNotEmpty)
        .unwrap();
    assert_eq!((r.folders_removed, r.documents_deleted), (1, 0));
    assert!(matches!(
        t.delete_folder(team, "/", DeletePolicy::Cascade),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        t.delete_folder(team, "/Gone", DeletePolicy::Cascade),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn move_document_requires_an_existing_live_target() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    t.create_folder(team, "/", "B").unwrap();
    let d = doc(&f, "D", "/");
    assert_eq!(t.move_document(&d, "/B").unwrap().path, "/B");
    assert_eq!(t.move_document(&d, "").unwrap().path, "/");
    assert!(matches!(
        t.move_document(&d, "/Nope"),
        Err(Error::NotFound(_))
    ));
    SqliteDocuments::new(f.db.conn()).soft_delete(&d).unwrap();
    assert!(matches!(t.move_document(&d, "/B"), Err(Error::Conflict(_))));
}

#[test]
fn resolve_paths() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    t.create_folder(team, "/", "A").unwrap();
    let d = doc(&f, "Readme", "/A");
    assert_eq!(t.resolve(team, "/").unwrap(), Resolved::Root);
    assert!(matches!(
        t.resolve(team, "/A/").unwrap(),
        Resolved::Folder { id: Some(_), .. }
    ));
    match t.resolve(team, "A/Readme").unwrap() {
        Resolved::Document(x) => assert_eq!(x.id, d),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        t.resolve(team, "/A/Nope"),
        Err(Error::NotFound(_))
    ));
    doc(&f, "Readme", "/A");
    assert!(matches!(
        t.resolve(team, "/A/Readme"),
        Err(Error::Conflict(_))
    ));
    assert!(t.resolve(team, "/a/../b").is_err());
}

#[test]
fn ordering_default_and_reorder() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    for n in ["b", "a", "c"] {
        t.create_folder(team, "/", n).unwrap();
    }
    let x = doc(&f, "x", "/");
    let y = doc(&f, "y", "/");
    assert_eq!(names(&f, "/"), ["a", "b", "c", "x", "y"]);

    t.reorder(
        team,
        "/",
        &[
            ChildRef::Folder("/c".into()),
            ChildRef::Document(y.clone()),
            ChildRef::Folder("/a".into()),
        ],
    )
    .unwrap();
    // listed folders/docs first in given order within their kind, unlisted follow
    assert_eq!(names(&f, "/"), ["c", "a", "b", "y", "x"]);
    let _ = x;

    // stranger / duplicate entries are rejected and change nothing
    assert!(t
        .reorder(team, "/", &[ChildRef::Folder("/zzz".into())])
        .is_err());
    assert!(t
        .reorder(
            team,
            "/",
            &[ChildRef::Folder("/a".into()), ChildRef::Folder("/a".into())]
        )
        .is_err());
    assert_eq!(names(&f, "/"), ["c", "a", "b", "y", "x"]);
}

#[test]
fn reorder_materialises_implicit_folders() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    doc(&f, "d", "/q");
    doc(&f, "e", "/p");
    t.reorder(team, "/", &[ChildRef::Folder("/q".into())])
        .unwrap();
    assert_eq!(names(&f, "/"), ["q", "p"]);
    assert!(t.get_folder(team, "/q").is_ok());
}

#[test]
fn subtree_queries_and_soft_deleted_documents_are_hidden() {
    let f = fixture();
    let t = SqliteTree::new(f.db.conn());
    let team = &f.team.id;
    t.ensure_folder_path(team, "/A/B").unwrap();
    let d1 = doc(&f, "One", "/A");
    let d2 = doc(&f, "Two", "/A/B");
    let d3 = doc(&f, "Gone", "/A/B");
    SqliteDocuments::new(f.db.conn()).soft_delete(&d3).unwrap();

    let mut ids = t.subtree_document_ids(team, "/A").unwrap();
    ids.sort();
    let mut want = vec![d1, d2.clone()];
    want.sort();
    assert_eq!(ids, want);
    assert_eq!(t.subtree_document_ids(team, "/A/B").unwrap(), [d2]);
    let node = t.subtree(team, "/A").unwrap();
    assert_eq!(node.kind, NodeKind::Folder);
    assert!(matches!(t.subtree(team, "/nope"), Err(Error::NotFound(_))));
}

#[test]
fn works_inside_an_outer_transaction_and_rolls_back_with_it() {
    let mut f = fixture();
    let team = f.team.id.clone();
    let res: nyx_core::Result<()> = f.db.transaction(|c| {
        let t = SqliteTree::new(c);
        t.create_folder(&team, "/", "Temp")?;
        t.rename_folder(&team, "/Temp", "Other")?;
        Err(Error::Invalid("abort".into()))
    });
    assert!(res.is_err());
    assert!(!SqliteTree::new(f.db.conn())
        .folder_exists(&team, "/Other")
        .unwrap());
}
