#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::many_single_char_names,
    clippy::assert_is_empty,
    clippy::cast_precision_loss,
    missing_docs
)]
//! End-to-end intake tests against an in-memory database. No network, no real engines.

mod common;

use common::{fixture, new_doc};
use nyx_core::intake::{
    ChunkOptions, Confidence, FakeOcr, FakeTranscriber, InputKind, IntakePipeline, IntakeRepo,
    IntakeStatus, SqliteIntake,
};
use nyx_core::store::{ChunkRepo, SqliteChunks};
use nyx_core::Error;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
const SPEC: &str = r#"{"title":"Export CSV","userStory":"As an admin, I want export so that I can audit","acceptanceCriteria":["1. button"],"edgeCases":[],"openQuestions":[],"confidence":"high"}"#;

#[test]
fn text_to_structured_spec_lifecycle() {
    let f = fixture();
    let repo = SqliteIntake::new(f.db.conn());
    let (t, o) = (FakeTranscriber::returning("x"), FakeOcr::returning("x"));
    let p = IntakePipeline::new(&t, &o);

    let rec = p
        .ingest_text(&repo, &f.team.id, &f.user.id, "we need CSV export")
        .unwrap();
    assert_eq!(
        (rec.status, rec.kind),
        (IntakeStatus::Parsed, InputKind::Text)
    );
    assert_eq!(rec.raw_text.as_deref(), Some("we need CSV export"));

    let prompt = p.structuring_prompt(&rec, None).unwrap();
    assert!(prompt.user.ends_with("we need CSV export"));

    let (rec, spec) = p.apply_structuring_response(&repo, &rec.id, SPEC).unwrap();
    assert_eq!(rec.status, IntakeStatus::Structured);
    assert_eq!(spec.confidence, Confidence::High);
    assert_eq!(rec.spec().unwrap().unwrap().title, "Export CSV");

    // Terminal: cannot structure twice, cannot fail afterwards.
    assert!(matches!(
        repo.mark_failed(&rec.id, "x"),
        Err(Error::Conflict(_))
    ));
    assert!(p.structuring_prompt(&rec, None).is_err());
}

#[test]
fn low_confidence_needs_clarification_then_resolves() {
    let f = fixture();
    let repo = SqliteIntake::new(f.db.conn());
    let (t, o) = (FakeTranscriber::returning("x"), FakeOcr::returning("x"));
    let p = IntakePipeline::new(&t, &o);
    let rec = p
        .ingest_text(&repo, &f.team.id, &f.user.id, "make it better")
        .unwrap();

    let (rec, spec) = p
        .apply_structuring_response(&repo, &rec.id, "not json")
        .unwrap();
    assert_eq!(rec.status, IntakeStatus::ClarificationNeeded);
    assert_eq!(spec.confidence, Confidence::Low);

    let qs = vec!["Better how?".to_string()];
    let ans = vec!["Faster load".to_string()];
    let prompt = p.structuring_prompt(&rec, Some((&qs, &ans))).unwrap();
    assert!(prompt.user.contains("Q: Better how?\nA: Faster load"));

    let (rec, _) = p.apply_structuring_response(&repo, &rec.id, SPEC).unwrap();
    assert_eq!(rec.status, IntakeStatus::Structured);
}

#[test]
fn file_kinds_are_routed_to_the_right_extractor() {
    let f = fixture();
    let repo = SqliteIntake::new(f.db.conn());
    let (t, o) = (
        FakeTranscriber::returning("  meeting words "),
        FakeOcr::returning("text from image"),
    );
    let p = IntakePipeline::new(&t, &o);
    let go = |bytes: &[u8], name: &str, mime: Option<&str>| {
        p.ingest_file(&repo, &f.team.id, &f.user.id, bytes, Some(name), mime)
            .unwrap()
    };

    let csv = go(b"a,b\n1,2", "t.csv", Some("application/octet-stream"));
    assert_eq!(csv.kind, InputKind::Csv);
    assert_eq!(
        csv.raw_text.as_deref(),
        Some("| a | b |\n| --- | --- |\n| 1 | 2 |")
    );

    let md = go(b"# Hi", "../../notes.md", None);
    assert_eq!(md.source_name.as_deref(), Some("notes.md"), "path stripped");

    let img = go(PNG, "shot.png", Some("image/png"));
    assert_eq!(
        (img.kind, img.status),
        (InputKind::Image, IntakeStatus::Parsed)
    );
    assert_eq!(img.raw_text.as_deref(), Some("text from image"));

    let audio = go(b"ID3\x04\0\0\0\0", "memo.mp3", Some("audio/mpeg"));
    assert_eq!(audio.kind, InputKind::Audio);
    assert_eq!(audio.raw_text.as_deref(), Some("meeting words"));
    assert_eq!(t.calls()[0].1, "audio/mpeg");

    let pcb = go(
        b"(kicad_pcb (version 1) (layers (0 \"F.Cu\" signal)))",
        "b.kicad_pcb",
        None,
    );
    assert_eq!(pcb.kind, InputKind::Pcb);
    assert!(pcb.raw_text.unwrap().contains("# PCB: b.kicad_pcb"));

    assert_eq!(repo.list_by_team(&f.team.id).unwrap().len(), 5);
}

#[test]
fn validation_errors_create_no_record_but_engine_errors_are_recorded() {
    let f = fixture();
    let repo = SqliteIntake::new(f.db.conn());
    let (t, o) = (
        FakeTranscriber::failing("model missing"),
        FakeOcr::returning("   "),
    );
    let p = IntakePipeline::new(&t, &o);

    for (bytes, name) in [
        (&b""[..], "empty.txt"),
        (&[0u8, 1, 2, 0xFF][..], "blob.bin"),
        (&b"x"[..], "../.."),
        (&b"RIFF\0\0\0\0WAVEfmt "[..], "clip.ogg"),
    ] {
        assert!(
            p.ingest_file(&repo, &f.team.id, &f.user.id, bytes, Some(name), None)
                .is_err(),
            "{name}"
        );
    }
    assert!(repo.list_by_team(&f.team.id).unwrap().is_empty());

    let a = p
        .ingest_file(
            &repo,
            &f.team.id,
            &f.user.id,
            b"ID3\x04\0\0",
            Some("a.mp3"),
            None,
        )
        .unwrap();
    assert_eq!(a.status, IntakeStatus::Failed);
    assert!(a.error.unwrap().contains("model missing"));

    let blank = p
        .ingest_file(&repo, &f.team.id, &f.user.id, PNG, Some("blank.png"), None)
        .unwrap();
    assert_eq!(blank.status, IntakeStatus::Failed);
    assert!(blank.error.unwrap().contains("No text was recognised"));

    let retried = repo.retry(&a.id).unwrap();
    assert_eq!(
        (retried.status, retried.error),
        (IntakeStatus::Received, None)
    );
}

#[test]
fn size_limit_is_enforced() {
    let f = fixture();
    let repo = SqliteIntake::new(f.db.conn());
    let (t, o) = (FakeTranscriber::returning("x"), FakeOcr::returning("x"));
    let mut p = IntakePipeline::new(&t, &o);
    p.limits.max_upload_bytes = 8;
    assert!(p
        .ingest_file(
            &repo,
            &f.team.id,
            &f.user.id,
            b"123456789",
            Some("a.txt"),
            None
        )
        .is_err());
    assert!(p
        .ingest_text(&repo, &f.team.id, &f.user.id, "123456789")
        .is_err());
    assert!(p.ingest_text(&repo, &f.team.id, &f.user.id, "  ").is_err());
}

#[test]
fn duplicate_detection_history_and_document_link() {
    let f = fixture();
    let repo = SqliteIntake::new(f.db.conn());
    let (t, o) = (FakeTranscriber::returning("x"), FakeOcr::returning("x"));
    let p = IntakePipeline::new(&t, &o);
    let a = p
        .ingest_text(&repo, &f.team.id, &f.user.id, "same words")
        .unwrap();
    let b = p
        .ingest_text(&repo, &f.team.id, &f.user.id, "same words")
        .unwrap();
    let dupes = repo.find_by_hash(&f.team.id, &a.sha256).unwrap();
    assert_eq!(
        dupes.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec![b.id.as_str(), a.id.as_str()]
    );
    assert_eq!(
        repo.list_by_team(&f.team.id).unwrap()[0].id,
        b.id,
        "newest first"
    );

    let doc = new_doc(&f, "Spec", "body");
    let linked = repo.link_document(&a.id, &doc.id).unwrap();
    assert_eq!(linked.document_id.as_deref(), Some(doc.id.as_str()));
    assert!(matches!(
        repo.link_document(&a.id, "nope"),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(repo.get("missing"), Err(Error::NotFound(_))));
}

#[test]
fn status_transition_table() {
    use IntakeStatus::{ClarificationNeeded, Failed, Parsed, Received, Structured};
    assert!(Received.can_become(Parsed));
    assert!(Failed.can_become(Received));
    assert!(ClarificationNeeded.can_become(Structured));
    assert!(!Received.can_become(Structured));
    assert!(!Structured.can_become(Failed));
    for s in IntakeStatus::ALL {
        assert!(!s.can_become(*s) || *s == ClarificationNeeded);
    }
}

#[test]
fn chunks_are_written_through_the_store() {
    let f = fixture();
    let repo = SqliteIntake::new(f.db.conn());
    let (t, o) = (FakeTranscriber::returning("x"), FakeOcr::returning("x"));
    let p = IntakePipeline::new(&t, &o);
    let long = "Sentence number one is here. ".repeat(40);
    let rec = p.ingest_text(&repo, &f.team.id, &f.user.id, &long).unwrap();
    let doc = new_doc(&f, "Spec", "body");
    let chunks = SqliteChunks::new(f.db.conn());
    let opts = ChunkOptions {
        chunk_size: 200,
        overlap: 20,
        drop_covered_tail: true,
    };

    let stored = p
        .index_record(&chunks, &rec, &doc.id, 1, &opts, None)
        .unwrap();
    assert!(stored.len() > 3);
    assert_eq!(stored[0].chunk_index, 0);
    assert!(stored
        .iter()
        .all(|c| c.org_id == f.team.id && c.embedding.is_none()));

    // Re-indexing replaces rather than appends.
    let again = p
        .index_record(&chunks, &rec, &doc.id, 1, &opts, None)
        .unwrap();
    assert_eq!(again.len(), stored.len());
    assert_eq!(chunks.doc_chunks(&doc.id, 1).unwrap().len(), stored.len());

    // Embeddings must match the chunk count.
    let bad = [vec![1.0_f32]];
    let e = nyx_core::intake::Embeddings {
        model: "fake",
        vectors: &bad,
    };
    assert!(p
        .index_record(&chunks, &rec, &doc.id, 1, &opts, Some(e))
        .is_err());
    let vectors: Vec<Vec<f32>> = (0..stored.len()).map(|i| vec![i as f32, 1.0]).collect();
    let e = nyx_core::intake::Embeddings {
        model: "fake",
        vectors: &vectors,
    };
    let embedded = p
        .index_record(&chunks, &rec, &doc.id, 1, &opts, Some(e))
        .unwrap();
    assert_eq!(embedded[2].embedding.as_deref(), Some(&[2.0, 1.0][..]));
    assert_eq!(embedded[0].embedding_model.as_deref(), Some("fake"));
}
