//! Intake: "chaos ingestion" of text, markdown, CSV, PDF, DOCX, images, audio and PCB files.
//!
//! Ported from the TypeScript API (`services/intake.service.ts`, `file-parser.service.ts`,
//! `transcription.service.ts`, `chunking.service.ts`, `pcb-parser.service.ts`, the non-agent
//! `services/voice/*`, and `routes/{intake,upload,audio}.ts`). Details and parity gaps are in
//! `docs/rust-core/intake.md`.
//!
//! | Module | Role |
//! |---|---|
//! | [`kind`] | [`InputKind`], MIME refinement, magic-byte [`sniff`] |
//! | [`limits`] | [`Limits`], file-name sanitising, [`safe_join`], archive entry checks |
//! | [`parse`] | [`parse_file`] (text, markdown, CSV, PDF, DOCX, PCB), [`append_to_document`] |
//! | [`docx`], [`pdf`], [`pcb`] | format readers (zip-bomb and DoS guarded) |
//! | [`chunking`] | exact port of `chunkText`, writes through `store::chunks` |
//! | [`engines`] | [`Transcriber`] / [`OcrEngine`] traits, fakes, audio validation |
//! | [`structuring`] | [`StructuringPrompt`] builders + tolerant LLM-reply parsers (no LLM call) |
//! | [`voice`] | diarization, meeting intelligence, meeting-notes document |
//! | [`record`] | [`IntakeRecord`] lifecycle + [`SqliteIntake`] (migration 173) |
//! | [`pipeline`] | [`IntakePipeline`] tying the above together |
//!
//! Typical flow: `IntakePipeline::ingest_file` -> `structuring_prompt` -> (caller runs the LLM)
//! -> `apply_structuring_response` -> optionally create a document and `index_record`.

#![allow(
    clippy::doc_markdown,
    clippy::missing_panics_doc,
    clippy::assert_is_empty,
    clippy::cast_possible_wrap,
    clippy::format_push_string,
    clippy::unnested_or_patterns
)]

pub mod chunking;
pub mod docx;
pub mod engines;
pub mod kind;
pub mod limits;
pub mod parse;
pub mod pcb;
pub mod pdf;
pub mod pipeline;
pub mod record;
pub mod structuring;
pub mod voice;

pub use chunking::{chunk_text, store_doc_chunks, ChunkOptions, Embeddings};
pub use engines::{
    normalize_media_type, validate_audio_file, FakeOcr, FakeTranscriber, OcrEngine, Transcriber,
};
pub use kind::{refine_mime, sniff, InputKind, Sniffed};
pub use limits::{check_entry_name, safe_join, sanitize_filename, Limits};
pub use parse::{append_to_document, csv_to_markdown_table, parse_file, ParsedFile};
pub use pipeline::IntakePipeline;
pub use record::{IntakeRecord, IntakeRepo, IntakeStatus, NewIntakeRecord, SqliteIntake};
pub use structuring::{
    parse_spec_response, parse_transcript_response, Confidence, StructuredSpec,
    StructuredTranscript, StructuringPrompt,
};
