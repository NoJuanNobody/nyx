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
use nyx_core::model::{BranchStatus, NewBranch};
use nyx_core::store::*;
use nyx_core::Error;

fn nb(doc: &str, name: &str, user: &str, base: Option<String>) -> NewBranch {
    NewBranch {
        document_id: doc.into(),
        name: name.into(),
        base_version_id: base,
        created_by_id: user.into(),
    }
}

#[test]
fn versions_are_gapless_immutable_and_dedup_identical_saves() {
    let f = fixture();
    let docs = SqliteDocuments::new(f.db.conn());
    let d = new_doc(&f, "Spec", "one");
    let v2 = docs
        .save_content(&d.id, "two", Some("edit"), &f.user.id)
        .unwrap();
    let v3 = docs.save_content(&d.id, "three", None, &f.user.id).unwrap();
    assert_eq!((v2.version, v3.version), (2, 3));
    // identical content: no new version
    let same = docs.save_content(&d.id, "three", None, &f.user.id).unwrap();
    assert_eq!(same.id, v3.id);
    assert_eq!(docs.versions(&d.id).unwrap().len(), 3);
    assert_eq!(docs.get(&d.id).unwrap().content, "three");
    assert_eq!(docs.version(&d.id, 1).unwrap().content, "one");
    assert!(matches!(docs.version(&d.id, 9), Err(Error::NotFound(_))));

    // immutability trigger
    let r =
        f.db.conn()
            .execute("UPDATE document_versions SET content='hack'", []);
    assert!(r.unwrap_err().to_string().contains("immutable"));
    // unique (document, version)
    let dup = f.db.conn().execute(
        "INSERT INTO document_versions (id,document_id,version,content,created_by_id,created_at) VALUES ('z',?1,2,'x',?2,1)",
        [&d.id, &f.user.id],
    );
    assert!(dup.is_err());

    // restoring appends, never rewrites history
    let r = docs.restore_version(&d.id, 1, &f.user.id).unwrap();
    assert_eq!(r.version, 4);
    assert_eq!(r.content, "one");
    assert_eq!(docs.get(&d.id).unwrap().content, "one");
    assert_eq!(docs.versions(&d.id).unwrap().len(), 4);
}

#[test]
fn branch_forks_from_version_and_names_are_unique() {
    let f = fixture();
    let docs = SqliteDocuments::new(f.db.conn());
    let br = SqliteBranches::new(f.db.conn());
    let d = new_doc(&f, "Spec", "base");
    let v1 = docs.latest_version(&d.id).unwrap();
    docs.save_content(&d.id, "head", None, &f.user.id).unwrap();

    let from_latest = br.create(&nb(&d.id, "latest", &f.user.id, None)).unwrap();
    assert_eq!(from_latest.content, "head");
    assert_eq!(from_latest.status, BranchStatus::Draft);
    let from_v1 = br
        .create(&nb(&d.id, "old", &f.user.id, Some(v1.id.clone())))
        .unwrap();
    assert_eq!(from_v1.content, "base");
    assert_eq!(from_v1.base_version_id, v1.id);
    assert!(matches!(
        br.create(&nb(&d.id, "old", &f.user.id, None)),
        Err(Error::Conflict(_))
    ));

    // base version of another document is rejected
    let other = new_doc(&f, "Other", "zzz");
    let other_v = docs.latest_version(&other.id).unwrap();
    assert!(matches!(
        br.create(&nb(&d.id, "x", &f.user.id, Some(other_v.id))),
        Err(Error::Invalid(_))
    ));
    assert_eq!(br.list(&d.id).unwrap().len(), 2);

    docs.soft_delete(&d.id).unwrap();
    assert!(matches!(
        br.create(&nb(&d.id, "late", &f.user.id, None)),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn branch_status_machine() {
    let f = fixture();
    let br = SqliteBranches::new(f.db.conn());
    let d = new_doc(&f, "Spec", "base");
    let b = br.create(&nb(&d.id, "b", &f.user.id, None)).unwrap();

    assert!(matches!(
        br.set_status(&b.id, BranchStatus::Merged, None),
        Err(Error::Conflict(_))
    ));
    let b = br.set_status(&b.id, BranchStatus::InReview, None).unwrap();
    let b = br
        .set_status(&b.id, BranchStatus::Rejected, Some(&f.user.id))
        .unwrap();
    assert_eq!(b.reviewed_by_id.as_deref(), Some(f.user.id.as_str()));
    assert!(matches!(
        br.update_content(&b.id, "x"),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        br.set_status(&b.id, BranchStatus::Approved, None),
        Err(Error::Conflict(_))
    ));
    let b = br.set_status(&b.id, BranchStatus::Draft, None).unwrap();
    assert_eq!(
        br.update_content(&b.id, "edited").unwrap().content,
        "edited"
    );
    // cannot merge unless approved
    assert!(matches!(
        br.merge(&b.id, &f.user.id, MergeStrategy::default()),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn merge_fast_forward_creates_version_and_is_terminal() {
    let f = fixture();
    let docs = SqliteDocuments::new(f.db.conn());
    let br = SqliteBranches::new(f.db.conn());
    let d = new_doc(&f, "Spec", "base");
    let b = br.create(&nb(&d.id, "feat", &f.user.id, None)).unwrap();
    br.update_content(&b.id, "base + feature").unwrap();
    br.set_status(&b.id, BranchStatus::Approved, Some(&f.user.id))
        .unwrap();

    let v = br
        .merge(&b.id, &f.user.id, MergeStrategy::default())
        .unwrap();
    assert_eq!(v.version, 2);
    assert_eq!(v.message.as_deref(), Some("Merge branch feat"));
    assert_eq!(docs.get(&d.id).unwrap().content, "base + feature");
    let merged = br.get(&b.id).unwrap();
    assert_eq!(merged.status, BranchStatus::Merged);
    assert!(merged.merged_at.is_some());
    // second merge refused
    assert!(matches!(
        br.merge(&b.id, &f.user.id, MergeStrategy::Overwrite),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        br.set_status(&b.id, BranchStatus::Draft, None),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn merge_refuses_diverged_unless_overwrite() {
    let f = fixture();
    let docs = SqliteDocuments::new(f.db.conn());
    let br = SqliteBranches::new(f.db.conn());
    let d = new_doc(&f, "Spec", "base");
    let b = br.create(&nb(&d.id, "feat", &f.user.id, None)).unwrap();
    br.update_content(&b.id, "branch edit").unwrap();
    br.set_status(&b.id, BranchStatus::Approved, None).unwrap();
    docs.save_content(&d.id, "main moved on", None, &f.user.id)
        .unwrap();

    let err = br
        .merge(&b.id, &f.user.id, MergeStrategy::FailIfDiverged)
        .unwrap_err();
    assert!(matches!(err, Error::Conflict(_)), "{err:?}");
    // nothing changed
    assert_eq!(docs.get(&d.id).unwrap().content, "main moved on");
    assert_eq!(br.get(&b.id).unwrap().status, BranchStatus::Approved);

    let v = br
        .merge(&b.id, &f.user.id, MergeStrategy::Overwrite)
        .unwrap();
    assert_eq!(v.version, 3);
    assert_eq!(docs.get(&d.id).unwrap().content, "branch edit");
    // history retained
    assert_eq!(docs.version(&d.id, 2).unwrap().content, "main moved on");
}

#[test]
fn failed_transaction_leaves_no_partial_version() {
    let mut f = fixture();
    let d = new_doc(&f, "Spec", "base");
    let user = f.user.id.clone();
    let id = d.id.clone();
    let r: nyx_core::Result<()> = f.db.transaction(|c| {
        let docs = SqliteDocuments::new(c);
        docs.save_content(&id, "tmp", None, &user)?;
        docs.save_content(&id, "tmp2", None, "no-such-user")?; // FK failure
        Ok(())
    });
    assert!(r.is_err());
    let docs = SqliteDocuments::new(f.db.conn());
    assert_eq!(docs.versions(&d.id).unwrap().len(), 1);
    assert_eq!(docs.get(&d.id).unwrap().content, "base");
}
