//! Pluggable speech-to-text and OCR engines.
//!
//! The TypeScript sent audio to a hosted LLM (`transcription.service.ts`). Nyx is local-first and
//! the in-app LLM is gone, so transcription and OCR are traits; this crate ships only fakes for
//! tests. Real engines are out of scope for this ticket (see `docs/rust-core/intake.md`):
//!
//! - [`Transcriber`]: intended binding is **whisper.cpp** through the `whisper-rs` crate, behind
//!   an optional cargo feature (model file chosen by the user, 16 kHz mono PCM decoded from
//!   mp3/wav/m4a/webm with `symphonia`). A remote OpenAI-compatible `/audio/transcriptions`
//!   endpoint is the alternative for users without a local model.
//! - [`OcrEngine`]: intended binding is **Tesseract** (`leptess` or `tesseract-rs`), also feature
//!   gated, with the language packs supplied by the user.
//!
//! Both traits are synchronous and `Send + Sync`; callers run them on a worker thread.

use super::kind::extension;
use super::limits::Limits;
use crate::error::{Error, Result};

/// Speech-to-text engine.
pub trait Transcriber: Send + Sync {
    /// Transcribe a complete audio file. `mime` is the sniffed MIME type (for example `audio/mpeg`).
    fn transcribe(&self, audio: &[u8], mime: &str) -> Result<String>;
}

/// Optical character recognition engine.
pub trait OcrEngine: Send + Sync {
    /// Extract text from an image. `mime` is the sniffed MIME type (for example `image/png`).
    fn recognize(&self, image: &[u8], mime: &str) -> Result<String>;
}

/// Test double for [`Transcriber`]: returns a canned transcript (or error) and records calls.
#[derive(Debug, Default)]
pub struct FakeTranscriber {
    response: std::sync::Mutex<Option<std::result::Result<String, String>>>,
    calls: std::sync::Mutex<Vec<(usize, String)>>,
}

impl FakeTranscriber {
    /// Always return `text`.
    #[must_use]
    pub fn returning(text: impl Into<String>) -> Self {
        Self {
            response: std::sync::Mutex::new(Some(Ok(text.into()))),
            calls: std::sync::Mutex::default(),
        }
    }

    /// Always fail with `message`.
    #[must_use]
    pub fn failing(message: impl Into<String>) -> Self {
        Self {
            response: std::sync::Mutex::new(Some(Err(message.into()))),
            calls: std::sync::Mutex::default(),
        }
    }

    /// `(byte length, mime)` of every call so far.
    #[must_use]
    pub fn calls(&self) -> Vec<(usize, String)> {
        self.calls.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

impl Transcriber for FakeTranscriber {
    fn transcribe(&self, audio: &[u8], mime: &str) -> Result<String> {
        if let Ok(mut c) = self.calls.lock() {
            c.push((audio.len(), mime.to_string()));
        }
        match self.response.lock().ok().and_then(|r| r.clone()) {
            Some(Ok(t)) => Ok(t),
            Some(Err(m)) => Err(Error::Invalid(m)),
            None => Ok(String::new()),
        }
    }
}

/// Test double for [`OcrEngine`].
#[derive(Debug, Default)]
pub struct FakeOcr {
    response: std::sync::Mutex<Option<std::result::Result<String, String>>>,
}

impl FakeOcr {
    /// Always return `text`.
    #[must_use]
    pub fn returning(text: impl Into<String>) -> Self {
        Self {
            response: std::sync::Mutex::new(Some(Ok(text.into()))),
        }
    }

    /// Always fail with `message`.
    #[must_use]
    pub fn failing(message: impl Into<String>) -> Self {
        Self {
            response: std::sync::Mutex::new(Some(Err(message.into()))),
        }
    }
}

impl OcrEngine for FakeOcr {
    fn recognize(&self, _image: &[u8], _mime: &str) -> Result<String> {
        match self.response.lock().ok().and_then(|r| r.clone()) {
            Some(Ok(t)) => Ok(t),
            Some(Err(m)) => Err(Error::Invalid(m)),
            None => Ok(String::new()),
        }
    }
}

/// Run a transcriber and apply the TS post-conditions: trim, and fail on an empty result.
pub fn transcribe_checked(engine: &dyn Transcriber, audio: &[u8], mime: &str) -> Result<String> {
    let text = engine.transcribe(audio, mime)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(Error::Invalid(
            "Transcription produced empty result. The audio may be unclear or empty.".into(),
        ));
    }
    Ok(text.to_string())
}

/// Run an OCR engine; an image without text is not an error but is reported by the pipeline.
pub fn recognize_checked(engine: &dyn OcrEngine, image: &[u8], mime: &str) -> Result<String> {
    Ok(engine.recognize(image, mime)?.trim().to_string())
}

/// Audio MIME types accepted for upload (TS `SUPPORTED_MIME_TYPES`).
pub const SUPPORTED_AUDIO_MIMES: [&str; 8] = [
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/m4a",
    "audio/mp4",
    "audio/x-m4a",
    "audio/webm",
];

/// Audio extensions accepted for upload (TS `SUPPORTED_EXTENSIONS`).
pub const SUPPORTED_AUDIO_EXTENSIONS: [&str; 4] = [".mp3", ".wav", ".m4a", ".webm"];

/// Port of `transcriptionService.validateAudioFile`: `Ok(())` or the user-facing message.
pub fn validate_audio_file(
    filename: Option<&str>,
    mime: Option<&str>,
    size: usize,
    limits: &Limits,
) -> std::result::Result<(), String> {
    let max = limits.max_audio_bytes;
    if size as u64 > max {
        return Err(format!(
            "File too large. Maximum size is {}MB, got {}MB.",
            max / (1024 * 1024),
            (size as f64 / 1024.0 / 1024.0).round()
        ));
    }
    if let Some(name) = filename {
        let ext = format!(".{}", extension(name));
        let ext = if name.contains('.') {
            ext
        } else {
            name.chars().last().map(String::from).unwrap_or_default()
        };
        if !SUPPORTED_AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            return Err(format!(
                "Unsupported file extension \"{ext}\". Supported: {}",
                SUPPORTED_AUDIO_EXTENSIONS.join(", ")
            ));
        }
    }
    if let Some(m) = mime.filter(|m| !m.is_empty()) {
        if !SUPPORTED_AUDIO_MIMES.contains(&m.to_lowercase().as_str()) {
            return Err(format!(
                "Unsupported MIME type \"{m}\". Supported: mp3, wav, m4a, webm"
            ));
        }
    }
    Ok(())
}

/// Port of `normalizeMediaType`: collapse the accepted MIME spellings to four canonical types.
#[must_use]
pub fn normalize_media_type(mime: &str) -> &'static str {
    let lower = mime.to_lowercase();
    if lower.contains("mp3") || lower == "audio/mpeg" {
        "audio/mpeg"
    } else if lower.contains("wav") {
        "audio/wav"
    } else if lower.contains("m4a") || lower == "audio/mp4" || lower == "audio/x-m4a" {
        "audio/mp4"
    } else if lower.contains("webm") {
        "audio/webm"
    } else {
        "audio/mpeg"
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn audio_validation_matches_the_typescript_messages() {
        let l = Limits::default();
        assert!(validate_audio_file(Some("a.MP3"), Some("audio/mpeg"), 10, &l).is_ok());
        assert!(validate_audio_file(None, None, 10, &l).is_ok());
        let big = validate_audio_file(Some("a.mp3"), None, 26 * 1024 * 1024, &l).unwrap_err();
        assert_eq!(big, "File too large. Maximum size is 25MB, got 26MB.");
        let ext = validate_audio_file(Some("a.ogg"), None, 1, &l).unwrap_err();
        assert_eq!(
            ext,
            "Unsupported file extension \".ogg\". Supported: .mp3, .wav, .m4a, .webm"
        );
        let mime = validate_audio_file(Some("a.mp3"), Some("audio/ogg"), 1, &l).unwrap_err();
        assert_eq!(
            mime,
            "Unsupported MIME type \"audio/ogg\". Supported: mp3, wav, m4a, webm"
        );
        assert!(validate_audio_file(Some("noext"), None, 1, &l).is_err());
    }

    #[test]
    fn media_type_normalisation() {
        assert_eq!(normalize_media_type("audio/mp3"), "audio/mpeg");
        assert_eq!(normalize_media_type("audio/x-wav"), "audio/wav");
        assert_eq!(normalize_media_type("audio/x-m4a"), "audio/mp4");
        assert_eq!(normalize_media_type("AUDIO/WEBM"), "audio/webm");
        assert_eq!(normalize_media_type("whatever"), "audio/mpeg");
    }

    #[test]
    fn fakes_and_post_conditions() {
        let t = FakeTranscriber::returning("  hello world \n");
        assert_eq!(
            transcribe_checked(&t, b"abc", "audio/wav").unwrap(),
            "hello world"
        );
        assert_eq!(t.calls(), vec![(3, "audio/wav".to_string())]);
        assert!(transcribe_checked(&FakeTranscriber::returning("   "), b"a", "audio/wav").is_err());
        assert!(transcribe_checked(&FakeTranscriber::failing("boom"), b"a", "audio/wav").is_err());
        assert_eq!(
            recognize_checked(&FakeOcr::returning(" text "), b"a", "image/png").unwrap(),
            "text"
        );
        assert!(recognize_checked(&FakeOcr::failing("x"), b"a", "image/png").is_err());
    }
}
