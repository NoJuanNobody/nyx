//! The shared [`LlmProvider`] trait and its request/response types.
//!
//! The trait is deliberately synchronous and transport-agnostic: `complete` takes a request and
//! returns a response. Async front-ends (Tauri, MCP) call it from a blocking task. Streaming is
//! optional: [`LlmProvider::complete_stream`] has a default that delivers the whole text as one
//! chunk, so providers only override it when they can really stream.
//!
//! [`FakeLlm`] is the scripted in-memory implementation used by every test in this module (and
//! available to sibling modules' tests). It never touches the network.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::Error;

/// Failure talking to (or configuring) a model provider.
///
/// Messages never contain API keys: HTTP error bodies are truncated and keys are never formatted
/// into errors.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LlmError {
    /// No API key is stored for a provider that needs one (BYOK not configured).
    #[error("no API key configured for provider `{0}`")]
    NoKey(String),
    /// The provider answered with a non-success HTTP status.
    #[error("provider returned HTTP {status}: {message}")]
    Http {
        /// HTTP status code.
        status: u16,
        /// Provider error message (truncated).
        message: String,
    },
    /// The request never completed (DNS, TLS, timeout, ...).
    #[error("transport error: {0}")]
    Transport(String),
    /// The provider answered 2xx but the body was not a recognisable completion.
    #[error("unreadable provider response: {0}")]
    BadResponse(String),
    /// Provider configuration is invalid or incomplete.
    #[error("provider configuration error: {0}")]
    Config(String),
    /// A fake or exhausted test provider ran out of scripted responses.
    #[error("no scripted response left")]
    Exhausted,
}

impl From<LlmError> for Error {
    fn from(e: LlmError) -> Self {
        match e {
            LlmError::NoKey(p) => Error::NotFound(format!("api key for provider `{p}`")),
            other => Error::Invalid(other.to_string()),
        }
    }
}

/// Who authored a message. System text is a separate request field, not a role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The human / calling program.
    User,
    /// The model.
    Assistant,
}

impl Role {
    /// Wire string shared by the Anthropic and `OpenAI` formats.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// One conversation turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    /// Author.
    pub role: Role,
    /// Plain-text content.
    pub content: String,
}

impl Message {
    /// A user turn.
    #[must_use]
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
        }
    }

    /// An assistant turn.
    #[must_use]
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
        }
    }
}

/// A provider-neutral completion request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmRequest {
    /// Model slug in the provider's own namespace.
    pub model: String,
    /// System prompt (may be empty).
    pub system: String,
    /// Conversation turns; must start with a user turn.
    pub messages: Vec<Message>,
    /// Output token cap.
    pub max_tokens: u32,
    /// Sampling temperature, if overriding the provider default.
    pub temperature: Option<f32>,
}

impl LlmRequest {
    /// Single-user-turn request.
    #[must_use]
    pub fn simple(
        model: impl Into<String>,
        system: impl Into<String>,
        user: impl Into<String>,
        max_tokens: u32,
    ) -> Self {
        Self {
            model: model.into(),
            system: system.into(),
            messages: vec![Message::user(user)],
            max_tokens,
            temperature: None,
        }
    }
}

/// Why generation stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    /// Natural end of the turn.
    EndTurn,
    /// Hit `max_tokens`; the text is truncated.
    MaxTokens,
    /// Anything else the provider reported (verbatim).
    Other(String),
}

/// Token accounting for one call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// Prompt tokens.
    pub input_tokens: u64,
    /// Completion tokens.
    pub output_tokens: u64,
}

impl Usage {
    /// Component-wise sum.
    #[must_use]
    pub fn plus(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens + other.input_tokens,
            output_tokens: self.output_tokens + other.output_tokens,
        }
    }
}

/// A provider-neutral completion response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmResponse {
    /// Model that actually answered (providers may alias).
    pub model: String,
    /// Concatenated text output.
    pub text: String,
    /// Why generation stopped.
    pub stop_reason: StopReason,
    /// Token usage.
    pub usage: Usage,
}

impl LlmResponse {
    /// Convenience constructor for tests and fakes.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            model: "fake".into(),
            text: text.into(),
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
        }
    }

    /// Same as [`LlmResponse::text`] but marked as cut off by `max_tokens`.
    #[must_use]
    pub fn truncated(text: impl Into<String>) -> Self {
        Self {
            stop_reason: StopReason::MaxTokens,
            ..Self::text(text)
        }
    }
}

/// A model backend. Implemented by [`super::HttpLlm`] (real) and [`FakeLlm`] (tests).
pub trait LlmProvider: Send + Sync + fmt::Debug {
    /// Short provider name for logs and usage records (`anthropic`, `openrouter`, ...).
    fn name(&self) -> &str;

    /// Run one completion.
    ///
    /// # Errors
    /// [`LlmError`] on missing key, HTTP failure or an unreadable response.
    fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmError>;

    /// Streaming completion. `on_chunk` receives text fragments in order; the returned response
    /// holds the full text. The default implementation is non-streaming: one chunk at the end.
    ///
    /// # Errors
    /// Same as [`LlmProvider::complete`].
    fn complete_stream(
        &self,
        request: &LlmRequest,
        on_chunk: &mut dyn FnMut(&str),
    ) -> Result<LlmResponse, LlmError> {
        let response = self.complete(request)?;
        on_chunk(&response.text);
        Ok(response)
    }
}

/// Instruction appended after a `max_tokens` cutoff (verbatim from the TS service).
pub const CONTINUE_PROMPT: &str = "Your previous message was cut off at the maximum length. Continue exactly from where it stopped — do not repeat anything already written and do not add any preamble; output only the remaining content.";

/// Run a completion to its natural stopping point, continuing across `max_tokens` cutoffs.
///
/// Port of `generateComplete`: on `MaxTokens` the accumulated text is carried back as an
/// assistant turn followed by [`CONTINUE_PROMPT`] (a trailing assistant prefill is rejected by
/// newer Claude models). At most `max_continuations` extra calls are made. Usage is summed.
///
/// # Errors
/// Propagates the first provider error.
pub fn complete_full(
    llm: &dyn LlmProvider,
    request: &LlmRequest,
    max_continuations: usize,
) -> Result<LlmResponse, LlmError> {
    let mut full = String::new();
    let mut usage = Usage::default();
    let mut last = None;
    for _ in 0..=max_continuations {
        let mut req = request.clone();
        if !full.is_empty() {
            req.messages.push(Message::assistant(full.clone()));
            req.messages.push(Message::user(CONTINUE_PROMPT));
        }
        let resp = llm.complete(&req)?;
        full.push_str(&resp.text);
        usage = usage.plus(resp.usage);
        let stop = resp.stop_reason != StopReason::MaxTokens;
        last = Some(resp);
        if stop {
            break;
        }
    }
    let last = last.ok_or(LlmError::Exhausted)?;
    Ok(LlmResponse {
        model: last.model,
        text: full,
        stop_reason: last.stop_reason,
        usage,
    })
}

/// Scripted provider for tests: pops one queued result per call and records every request.
#[derive(Default)]
pub struct FakeLlm {
    script: Mutex<VecDeque<Result<LlmResponse, LlmError>>>,
    seen: Mutex<Vec<LlmRequest>>,
}

impl fmt::Debug for FakeLlm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let queued = self.script.lock().map_or(0, |s| s.len());
        write!(f, "FakeLlm {{ queued: {queued} }}")
    }
}

impl FakeLlm {
    /// Empty script; every call fails with [`LlmError::Exhausted`] until responses are queued.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fake that answers with the given texts in order.
    #[must_use]
    pub fn with_texts(texts: &[&str]) -> Self {
        let f = Self::new();
        for t in texts {
            f.push_text(t);
        }
        f
    }

    /// Queue a successful text response.
    pub fn push_text(&self, text: &str) {
        self.push(Ok(LlmResponse::text(text)));
    }

    /// Queue an arbitrary result.
    pub fn push(&self, result: Result<LlmResponse, LlmError>) {
        if let Ok(mut s) = self.script.lock() {
            s.push_back(result);
        }
    }

    /// Requests received so far, oldest first.
    #[must_use]
    pub fn requests(&self) -> Vec<LlmRequest> {
        self.seen.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Number of calls made.
    #[must_use]
    pub fn call_count(&self) -> usize {
        self.seen.lock().map_or(0, |s| s.len())
    }
}

impl LlmProvider for FakeLlm {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmError> {
        if let Ok(mut s) = self.seen.lock() {
            s.push(request.clone());
        }
        self.script
            .lock()
            .map_err(|_| LlmError::Exhausted)?
            .pop_front()
            .unwrap_or(Err(LlmError::Exhausted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_pops_in_order_and_records() {
        let f = FakeLlm::with_texts(&["a", "b"]);
        let r = LlmRequest::simple("m", "s", "u", 10);
        assert_eq!(f.complete(&r).unwrap().text, "a");
        assert_eq!(f.complete(&r).unwrap().text, "b");
        assert_eq!(f.complete(&r), Err(LlmError::Exhausted));
        assert_eq!(f.call_count(), 3);
        assert_eq!(f.requests()[0].system, "s");
    }

    #[test]
    fn default_stream_delivers_one_chunk() {
        let f = FakeLlm::with_texts(&["hello"]);
        let mut chunks = Vec::new();
        let r = f
            .complete_stream(&LlmRequest::simple("m", "", "u", 1), &mut |c| {
                chunks.push(c.to_owned());
            })
            .unwrap();
        assert_eq!(chunks, vec!["hello"]);
        assert_eq!(r.text, "hello");
    }

    #[test]
    fn complete_full_continues_past_max_tokens() {
        let f = FakeLlm::new();
        f.push(Ok(LlmResponse::truncated("# T\npart one ")));
        f.push(Ok(LlmResponse::truncated("part two ")));
        f.push_text("end");
        let r = complete_full(&f, &LlmRequest::simple("m", "s", "go", 5), 6).unwrap();
        assert_eq!(r.text, "# T\npart one part two end");
        assert_eq!(r.stop_reason, StopReason::EndTurn);
        let reqs = f.requests();
        assert_eq!(reqs.len(), 3);
        assert_eq!(reqs[1].messages.len(), 3);
        assert_eq!(reqs[1].messages[1], Message::assistant("# T\npart one "));
        assert_eq!(reqs[1].messages[2].content, CONTINUE_PROMPT);
        assert_eq!(reqs[2].messages[1].content, "# T\npart one part two ");
    }

    #[test]
    fn complete_full_respects_continuation_cap() {
        let f = FakeLlm::new();
        for _ in 0..10 {
            f.push(Ok(LlmResponse::truncated("x")));
        }
        let r = complete_full(&f, &LlmRequest::simple("m", "", "u", 1), 2).unwrap();
        assert_eq!(r.text, "xxx");
        assert_eq!(f.call_count(), 3);
    }

    #[test]
    fn complete_full_sums_usage_and_propagates_errors() {
        let f = FakeLlm::new();
        let mut a = LlmResponse::truncated("a");
        a.usage = Usage {
            input_tokens: 1,
            output_tokens: 2,
        };
        let mut b = LlmResponse::text("b");
        b.usage = Usage {
            input_tokens: 10,
            output_tokens: 20,
        };
        f.push(Ok(a));
        f.push(Ok(b));
        let r = complete_full(&f, &LlmRequest::simple("m", "", "u", 1), 3).unwrap();
        assert_eq!(
            r.usage,
            Usage {
                input_tokens: 11,
                output_tokens: 22
            }
        );
        let e = FakeLlm::new();
        assert_eq!(
            complete_full(&e, &LlmRequest::simple("m", "", "u", 1), 3),
            Err(LlmError::Exhausted)
        );
    }

    #[test]
    fn llm_error_maps_into_core_error() {
        let e: Error = LlmError::NoKey("anthropic".into()).into();
        assert!(matches!(e, Error::NotFound(_)));
        let e: Error = LlmError::Transport("x".into()).into();
        assert!(matches!(e, Error::Invalid(_)));
    }
}
