//! Orchestration: bytes in, an [`IntakeRecord`] out, plus the hooks for the LLM step.
//!
//! ```text
//! ingest_file / ingest_text   -> record `received` -> `parsed` (or `failed`)
//! structuring_prompt          -> caller sends it to an LLM
//! apply_structuring_response  -> record `structured` | `clarification_needed`
//! index_record                -> chunks written via store::chunks for a document version
//! ```
//!
//! Nothing here calls the network. Images go to the [`OcrEngine`], audio to the [`Transcriber`];
//! everything else is parsed in-process by [`super::parse`].

use super::chunking::{store_doc_chunks, ChunkOptions, Embeddings};
use super::engines::{
    normalize_media_type, recognize_checked, transcribe_checked, validate_audio_file, OcrEngine,
    Transcriber,
};
use super::kind::{sniff, InputKind};
use super::limits::{sanitize_filename, Limits};
use super::parse::parse_file;
use super::record::{IntakeRecord, IntakeRepo, IntakeStatus, NewIntakeRecord};
use super::structuring::{parse_spec_response, StructuredSpec, StructuringPrompt};
use crate::error::{Error, Result};
use crate::model::DocChunk;
use crate::store::ChunkRepo;

/// Intake orchestrator. Cheap to build; holds only borrowed engines and limits.
pub struct IntakePipeline<'a> {
    /// Size and safety limits.
    pub limits: Limits,
    /// Speech-to-text engine for audio.
    pub transcriber: &'a dyn Transcriber,
    /// OCR engine for images.
    pub ocr: &'a dyn OcrEngine,
}

impl<'a> IntakePipeline<'a> {
    /// Pipeline with default [`Limits`].
    #[must_use]
    pub fn new(transcriber: &'a dyn Transcriber, ocr: &'a dyn OcrEngine) -> Self {
        Self {
            limits: Limits::default(),
            transcriber,
            ocr,
        }
    }

    /// Pasted text (`POST /api/intake/process`, `/transcript`). Empty input is rejected.
    pub fn ingest_text(
        &self,
        repo: &impl IntakeRepo,
        team_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<IntakeRecord> {
        if text.trim().is_empty() {
            return Err(Error::Invalid("rawInput must not be empty".into()));
        }
        self.limits.check_size(InputKind::Text, text.len())?;
        let rec = repo.create(&NewIntakeRecord::from_bytes(
            team_id,
            user_id,
            InputKind::Text,
            None,
            "text/plain",
            text.as_bytes(),
        ))?;
        repo.mark_parsed(&rec.id, text, None)
    }

    /// An uploaded or dropped file.
    ///
    /// Validation failures (unsafe name, empty, too large, unsupported type, bad audio type)
    /// return `Err` and create no record. Once a record exists, extraction failures are stored
    /// as status `failed` with the message and returned as `Ok(record)`, so the UI can show them
    /// and offer [`IntakeRepo::retry`].
    pub fn ingest_file(
        &self,
        repo: &impl IntakeRepo,
        team_id: &str,
        user_id: &str,
        bytes: &[u8],
        filename: Option<&str>,
        declared_mime: Option<&str>,
    ) -> Result<IntakeRecord> {
        let name = filename.map(sanitize_filename).transpose()?;
        let sniffed = sniff(name.as_deref(), declared_mime, bytes);
        if sniffed.kind == InputKind::Unknown {
            return Err(Error::Invalid(format!(
                "unsupported file type \"{}\"",
                sniffed.mime
            )));
        }
        self.limits.check_size(sniffed.kind, bytes.len())?;
        if sniffed.kind == InputKind::Audio {
            validate_audio_file(
                name.as_deref(),
                Some(&sniffed.mime),
                bytes.len(),
                &self.limits,
            )
            .map_err(Error::Invalid)?;
        }

        let rec = repo.create(&NewIntakeRecord::from_bytes(
            team_id,
            user_id,
            sniffed.kind,
            name.clone(),
            &sniffed.mime,
            bytes,
        ))?;

        let extracted: Result<(String, Option<String>)> = match sniffed.kind {
            InputKind::Image => recognize_checked(self.ocr, bytes, &sniffed.mime).and_then(|t| {
                if t.is_empty() {
                    Err(Error::Invalid(
                        "No text was recognised in the image.".into(),
                    ))
                } else {
                    Ok((t, None))
                }
            }),
            InputKind::Audio => {
                transcribe_checked(self.transcriber, bytes, normalize_media_type(&sniffed.mime))
                    .map(|t| (t, None))
            }
            _ => parse_file(bytes, name.as_deref(), declared_mime, &self.limits)
                .map(|p| (p.content, p.note)),
        };

        match extracted {
            Ok((text, mut note)) => {
                if sniffed.mismatch {
                    let m = format!(
                        "The file content looks like {} but its name or type said otherwise; it was handled as {}.",
                        sniffed.mime, sniffed.kind
                    );
                    note = Some(note.map_or(m.clone(), |n| format!("{n} {m}")));
                }
                repo.mark_parsed(&rec.id, &text, note.as_deref())
            }
            Err(e) => repo.mark_failed(&rec.id, &e.to_string()),
        }
    }

    /// Build the prompt for the LLM step. With `clarifications` (questions, answers) it builds the
    /// `processWithClarifications` variant. The record must be `parsed` or `clarification_needed`.
    pub fn structuring_prompt(
        &self,
        record: &IntakeRecord,
        clarifications: Option<(&[String], &[String])>,
    ) -> Result<StructuringPrompt> {
        let ready = matches!(
            record.status,
            IntakeStatus::Parsed | IntakeStatus::ClarificationNeeded
        );
        let Some(text) = record.raw_text.as_deref().filter(|_| ready) else {
            return Err(Error::Conflict(format!(
                "intake {} is {} and has nothing to structure",
                record.id, record.status
            )));
        };
        Ok(match clarifications {
            None => StructuringPrompt::for_raw_input(text),
            Some((q, a)) => StructuringPrompt::with_clarifications(text, q, a),
        })
    }

    /// Parse the LLM reply and move the record to `structured` or `clarification_needed`.
    pub fn apply_structuring_response(
        &self,
        repo: &impl IntakeRepo,
        record_id: &str,
        reply: &str,
    ) -> Result<(IntakeRecord, StructuredSpec)> {
        let spec = parse_spec_response(reply);
        let rec = repo.mark_structured(record_id, &spec)?;
        Ok((rec, spec))
    }

    /// Chunk the extracted text of `record` and store it for `(doc_id, version)`.
    pub fn index_record(
        &self,
        chunks: &impl ChunkRepo,
        record: &IntakeRecord,
        doc_id: &str,
        version: i64,
        options: &ChunkOptions,
        embeddings: Option<Embeddings<'_>>,
    ) -> Result<Vec<DocChunk>> {
        let text = record.raw_text.as_deref().ok_or_else(|| {
            Error::Conflict(format!("intake {} has no extracted text", record.id))
        })?;
        store_doc_chunks(
            chunks,
            doc_id,
            &record.team_id,
            version,
            text,
            options,
            embeddings,
        )
    }
}
