//! Pure request builders and response parsers for the two wire formats Nyx speaks:
//! the Anthropic Messages API and the OpenAI-compatible Chat Completions API (used by `OpenAI`,
//! `OpenRouter`, Ollama and most local servers).
//!
//! Nothing here performs I/O or sees an API key except as a `&str` argument that is copied
//! straight into a header.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::provider::{LlmError, LlmRequest, LlmResponse, StopReason, Usage};
use super::transport::{Headers, HttpRequest, Method};

/// `anthropic-version` header value.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Default per-request timeout.
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// Max characters of a provider error body kept in [`LlmError::Http`].
const ERROR_BODY_LIMIT: usize = 300;

/// One message in an Anthropic request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnthropicMessage {
    /// `user` or `assistant`.
    pub role: String,
    /// Plain-text content.
    pub content: String,
}

/// Body of `POST /v1/messages`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnthropicRequest {
    /// Model slug.
    pub model: String,
    /// Output cap.
    pub max_tokens: u32,
    /// System prompt; omitted when empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Turns.
    pub messages: Vec<AnthropicMessage>,
    /// Temperature override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

/// Translate a neutral request into an Anthropic body.
#[must_use]
pub fn anthropic_body(req: &LlmRequest) -> AnthropicRequest {
    AnthropicRequest {
        model: req.model.clone(),
        max_tokens: req.max_tokens,
        system: if req.system.is_empty() {
            None
        } else {
            Some(req.system.clone())
        },
        messages: req
            .messages
            .iter()
            .map(|m| AnthropicMessage {
                role: m.role.as_str().to_owned(),
                content: m.content.clone(),
            })
            .collect(),
        temperature: req.temperature,
    }
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Build the HTTP request for the Anthropic Messages API.
///
/// # Errors
/// [`LlmError::Config`] if the body cannot be serialised (cannot happen for valid input).
pub fn anthropic_http_request(
    base_url: &str,
    api_key: &str,
    req: &LlmRequest,
) -> Result<HttpRequest, LlmError> {
    let body =
        serde_json::to_string(&anthropic_body(req)).map_err(|e| LlmError::Config(e.to_string()))?;
    Ok(HttpRequest {
        method: Method::Post,
        url: join_url(base_url, "v1/messages"),
        headers: Headers::from_pairs([
            ("x-api-key", api_key),
            ("anthropic-version", ANTHROPIC_VERSION),
            ("content-type", "application/json"),
        ]),
        body: Some(body.into_bytes()),
        timeout_secs: Some(DEFAULT_TIMEOUT_SECS),
    })
}

/// Parse a response from the Anthropic Messages API (status + body).
///
/// Text blocks are concatenated; non-text blocks (tool use) are ignored.
///
/// # Errors
/// [`LlmError::Http`] for non-2xx, [`LlmError::BadResponse`] for unreadable 2xx bodies.
pub fn parse_anthropic_response(status: u16, body: &str) -> Result<LlmResponse, LlmError> {
    if !(200..300).contains(&status) {
        return Err(http_error(status, body));
    }
    let v: Value = serde_json::from_str(body).map_err(|e| LlmError::BadResponse(e.to_string()))?;
    let blocks = v
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| LlmError::BadResponse("missing `content` array".into()))?;
    let text: String = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    let stop_reason = match v.get("stop_reason").and_then(Value::as_str) {
        Some("max_tokens") => StopReason::MaxTokens,
        Some("end_turn" | "stop_sequence") | None => StopReason::EndTurn,
        Some(other) => StopReason::Other(other.to_owned()),
    };
    let usage = v.get("usage");
    Ok(LlmResponse {
        model: v
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        text,
        stop_reason,
        usage: Usage {
            input_tokens: token_count(usage, "input_tokens"),
            output_tokens: token_count(usage, "output_tokens"),
        },
    })
}

/// One message in an OpenAI-style request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiMessage {
    /// `system`, `user` or `assistant`.
    pub role: String,
    /// Plain-text content.
    pub content: String,
}

/// Body of `POST /chat/completions`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenAiRequest {
    /// Model slug.
    pub model: String,
    /// Output cap.
    pub max_tokens: u32,
    /// System message first, then turns.
    pub messages: Vec<OpenAiMessage>,
    /// Temperature override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

/// Translate a neutral request into an OpenAI-compatible body (system prompt becomes the first
/// message, mirroring `mapAnthropicMessagesToOpenAI` in the TS adapter).
#[must_use]
pub fn openai_body(req: &LlmRequest) -> OpenAiRequest {
    let mut messages = Vec::with_capacity(req.messages.len() + 1);
    if !req.system.is_empty() {
        messages.push(OpenAiMessage {
            role: "system".into(),
            content: req.system.clone(),
        });
    }
    messages.extend(req.messages.iter().map(|m| OpenAiMessage {
        role: m.role.as_str().to_owned(),
        content: m.content.clone(),
    }));
    OpenAiRequest {
        model: req.model.clone(),
        max_tokens: req.max_tokens,
        messages,
        temperature: req.temperature,
    }
}

/// Build the HTTP request for an OpenAI-compatible endpoint.
///
/// `api_key` is `None` for keyless local servers (Ollama). `extra_headers` carries provider
/// attribution headers (`OpenRouter`'s `HTTP-Referer` / `X-Title`).
///
/// # Errors
/// [`LlmError::Config`] if the body cannot be serialised.
pub fn openai_http_request(
    base_url: &str,
    api_key: Option<&str>,
    extra_headers: &[(String, String)],
    req: &LlmRequest,
) -> Result<HttpRequest, LlmError> {
    let body =
        serde_json::to_string(&openai_body(req)).map_err(|e| LlmError::Config(e.to_string()))?;
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(k) = api_key {
        headers.push(("Authorization".into(), format!("Bearer {k}")));
    }
    headers.extend(extra_headers.iter().cloned());
    Ok(HttpRequest {
        method: Method::Post,
        url: join_url(base_url, "chat/completions"),
        headers: Headers::from_pairs(headers),
        body: Some(body.into_bytes()),
        timeout_secs: Some(DEFAULT_TIMEOUT_SECS),
    })
}

/// Parse a Chat Completions response. `finish_reason` `length` maps to
/// [`StopReason::MaxTokens`] (port of `mapFinishReason`).
///
/// # Errors
/// [`LlmError::Http`] for non-2xx, [`LlmError::BadResponse`] for unreadable 2xx bodies.
pub fn parse_openai_response(status: u16, body: &str) -> Result<LlmResponse, LlmError> {
    if !(200..300).contains(&status) {
        return Err(http_error(status, body));
    }
    let v: Value = serde_json::from_str(body).map_err(|e| LlmError::BadResponse(e.to_string()))?;
    let choice = v
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .ok_or_else(|| LlmError::BadResponse("missing `choices[0]`".into()))?;
    let text = match choice.pointer("/message/content") {
        Some(Value::String(s)) => s.clone(),
        // Some servers return content as an array of {type:"text",text:".."} parts.
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    };
    let stop_reason = match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length") => StopReason::MaxTokens,
        Some("stop") | None => StopReason::EndTurn,
        Some(other) => StopReason::Other(other.to_owned()),
    };
    let usage = v.get("usage");
    Ok(LlmResponse {
        model: v
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        text,
        stop_reason,
        usage: Usage {
            input_tokens: token_count(usage, "prompt_tokens"),
            output_tokens: token_count(usage, "completion_tokens"),
        },
    })
}

fn token_count(usage: Option<&Value>, key: &str) -> u64 {
    usage
        .and_then(|u| u.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// Build an [`LlmError::Http`] from a failed response, extracting `error.message` when present
/// and truncating whatever is kept.
fn http_error(status: u16, body: &str) -> LlmError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.to_owned());
    LlmError::Http {
        status,
        message: message.chars().take(ERROR_BODY_LIMIT).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::Message;

    fn req() -> LlmRequest {
        LlmRequest {
            model: "m".into(),
            system: "be terse".into(),
            messages: vec![
                Message::user("hi"),
                Message::assistant("yo"),
                Message::user("again"),
            ],
            max_tokens: 64,
            temperature: Some(0.2),
        }
    }

    #[test]
    fn anthropic_request_shape() {
        let h = anthropic_http_request("https://api.anthropic.com/", "sk-ant-x", &req()).unwrap();
        assert_eq!(h.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(h.header_value("x-api-key"), Some("sk-ant-x"));
        assert_eq!(h.header_value("anthropic-version"), Some(ANTHROPIC_VERSION));
        let v: Value = serde_json::from_slice(h.body.as_deref().unwrap()).unwrap();
        assert_eq!(v["system"], "be terse");
        assert_eq!(v["max_tokens"], 64);
        assert_eq!(v["messages"].as_array().unwrap().len(), 3);
        assert_eq!(v["messages"][1]["role"], "assistant");
        assert!(!format!("{h:?}").contains("sk-ant-x"));
    }

    #[test]
    fn anthropic_omits_empty_system_and_temperature() {
        let mut r = req();
        r.system.clear();
        r.temperature = None;
        let v = serde_json::to_value(anthropic_body(&r)).unwrap();
        assert!(v.get("system").is_none());
        assert!(v.get("temperature").is_none());
    }

    #[test]
    fn anthropic_response_concatenates_text_blocks() {
        let body = r#"{"model":"claude-x","content":[{"type":"text","text":"Hel"},{"type":"tool_use","id":"t"},{"type":"text","text":"lo"}],"stop_reason":"max_tokens","usage":{"input_tokens":7,"output_tokens":3}}"#;
        let r = parse_anthropic_response(200, body).unwrap();
        assert_eq!(r.text, "Hello");
        assert_eq!(r.stop_reason, StopReason::MaxTokens);
        assert_eq!(r.usage.input_tokens, 7);
        assert_eq!(r.model, "claude-x");
    }

    #[test]
    fn anthropic_error_and_malformed() {
        let e = parse_anthropic_response(
            401,
            r#"{"error":{"type":"auth","message":"invalid x-api-key"}}"#,
        )
        .unwrap_err();
        assert_eq!(
            e,
            LlmError::Http {
                status: 401,
                message: "invalid x-api-key".into()
            }
        );
        assert!(matches!(
            parse_anthropic_response(200, "not json"),
            Err(LlmError::BadResponse(_))
        ));
        assert!(matches!(
            parse_anthropic_response(200, r#"{"id":"x"}"#),
            Err(LlmError::BadResponse(_))
        ));
        // Non-JSON error body is kept (truncated).
        let long = "x".repeat(1000);
        let LlmError::Http { message, .. } = parse_anthropic_response(502, &long).unwrap_err()
        else {
            panic!("expected Http");
        };
        assert_eq!(message.len(), ERROR_BODY_LIMIT);
    }

    #[test]
    fn openai_request_puts_system_first_and_bearer_auth() {
        let extra = vec![("X-Title".to_owned(), "Nyx".to_owned())];
        let h = openai_http_request(
            "https://openrouter.ai/api/v1",
            Some("sk-or-1"),
            &extra,
            &req(),
        )
        .unwrap();
        assert_eq!(h.url, "https://openrouter.ai/api/v1/chat/completions");
        assert_eq!(h.header_value("authorization"), Some("Bearer sk-or-1"));
        assert_eq!(h.header_value("x-title"), Some("Nyx"));
        let v: Value = serde_json::from_slice(h.body.as_deref().unwrap()).unwrap();
        assert_eq!(v["messages"][0]["role"], "system");
        assert_eq!(v["messages"].as_array().unwrap().len(), 4);
        assert!(!format!("{h:?}").contains("sk-or-1"));
    }

    #[test]
    fn openai_keyless_has_no_auth_header() {
        let h = openai_http_request("http://localhost:11434/v1", None, &[], &req()).unwrap();
        assert!(h.header_value("authorization").is_none());
    }

    #[test]
    fn openai_response_variants() {
        let ok = r#"{"model":"gpt","choices":[{"message":{"content":"hi"},"finish_reason":"length"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}"#;
        let r = parse_openai_response(200, ok).unwrap();
        assert_eq!(r.text, "hi");
        assert_eq!(r.stop_reason, StopReason::MaxTokens);
        assert_eq!(r.usage.output_tokens, 2);

        let parts = r#"{"choices":[{"message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},"finish_reason":"stop"}]}"#;
        assert_eq!(parse_openai_response(200, parts).unwrap().text, "ab");

        let null = r#"{"choices":[{"message":{"content":null},"finish_reason":"tool_calls"}]}"#;
        let r = parse_openai_response(200, null).unwrap();
        assert_eq!(r.text, "");
        assert_eq!(r.stop_reason, StopReason::Other("tool_calls".into()));

        assert!(matches!(
            parse_openai_response(200, r#"{"choices":[]}"#),
            Err(LlmError::BadResponse(_))
        ));
        assert!(matches!(
            parse_openai_response(429, r#"{"error":{"message":"slow down"}}"#),
            Err(LlmError::Http { status: 429, .. })
        ));
    }
}
