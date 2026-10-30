//! Model catalog for the model picker. Port of `routes/models.ts`: normalises the `OpenRouter`
//! `/models` listing, falls back to a curated list when the fetch fails, and caches for an hour.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::provider::LlmError;
use super::transport::{HttpRequest, HttpTransport, Method};

/// `OpenRouter` catalog endpoint.
pub const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
/// Cache lifetime: one hour.
pub const CACHE_TTL_MS: i64 = 60 * 60 * 1000;

/// One selectable model. Field names match the web contract (camelCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Slug, e.g. `anthropic/claude-sonnet-4`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Context window in tokens.
    pub context_length: u64,
    /// USD per million prompt tokens.
    pub prompt_price_per_m: f64,
    /// USD per million completion tokens.
    pub completion_price_per_m: f64,
    /// Parameter count in billions, best effort.
    pub params_b: Option<f64>,
    /// E.g. `text->text`.
    pub modality: String,
}

fn fallback(id: &str, name: &str, ctx: u64, prompt: f64, completion: f64) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        name: name.into(),
        context_length: ctx,
        prompt_price_per_m: prompt,
        completion_price_per_m: completion,
        params_b: None,
        modality: "text->text".into(),
    }
}

/// Curated list used whenever the live catalog cannot be fetched.
#[must_use]
pub fn fallback_models() -> Vec<ModelInfo> {
    vec![
        fallback(
            "anthropic/claude-sonnet-4",
            "Claude Sonnet 4",
            200_000,
            3.0,
            15.0,
        ),
        fallback(
            "anthropic/claude-3.5-haiku",
            "Claude 3.5 Haiku",
            200_000,
            0.8,
            4.0,
        ),
        fallback("openai/gpt-4o", "GPT-4o", 128_000, 2.5, 10.0),
        fallback(
            "google/gemini-2.0-flash-001",
            "Gemini 2.0 Flash",
            1_000_000,
            0.1,
            0.4,
        ),
    ]
}

/// Best-effort parameter count in billions from a name/description: the first `<number>B` with a
/// word boundary after the `B` (so `Llama 70B` is 70, `4Bit` is not a match).
#[must_use]
pub fn parse_params_b(name: Option<&str>, description: Option<&str>) -> Option<f64> {
    let hay: Vec<char> = format!("{} {}", name.unwrap_or(""), description.unwrap_or(""))
        .chars()
        .collect();
    let mut i = 0;
    while i < hay.len() {
        if hay[i].is_ascii_digit() {
            let start = i;
            let mut j = i;
            while j < hay.len() && hay[j].is_ascii_digit() {
                j += 1;
            }
            if j + 1 < hay.len() && hay[j] == '.' && hay[j + 1].is_ascii_digit() {
                j += 1;
                while j < hay.len() && hay[j].is_ascii_digit() {
                    j += 1;
                }
            }
            let num_end = j;
            while j < hay.len() && hay[j].is_whitespace() {
                j += 1;
            }
            if j < hay.len() && (hay[j] == 'B' || hay[j] == 'b') {
                let after = hay.get(j + 1);
                if !after.is_some_and(|c| c.is_alphanumeric() || *c == '_') {
                    let s: String = hay[start..num_end].iter().collect();
                    if let Ok(v) = s.parse::<f64>() {
                        if v.is_finite() {
                            return Some(v);
                        }
                    }
                }
            }
            i = num_end;
        } else {
            i += 1;
        }
    }
    None
}

fn per_million(v: Option<&Value>) -> f64 {
    let n = v
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0);
    n * 1e6
}

/// Normalise an `OpenRouter` `/models` response body. Entries without a string `id` are dropped.
///
/// # Errors
/// [`LlmError::BadResponse`] if the body is not JSON.
pub fn normalize_openrouter(body: &str) -> Result<Vec<ModelInfo>, LlmError> {
    let v: Value = serde_json::from_str(body).map_err(|e| LlmError::BadResponse(e.to_string()))?;
    let data = v
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(data
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_owned();
            let name = m.get("name").and_then(Value::as_str);
            Some(ModelInfo {
                name: name.unwrap_or(&id).to_owned(),
                context_length: m.get("context_length").and_then(Value::as_u64).unwrap_or(0),
                prompt_price_per_m: per_million(m.pointer("/pricing/prompt")),
                completion_price_per_m: per_million(m.pointer("/pricing/completion")),
                params_b: parse_params_b(name, m.get("description").and_then(Value::as_str)),
                modality: m
                    .pointer("/architecture/modality")
                    .and_then(Value::as_str)
                    .unwrap_or("text->text")
                    .to_owned(),
                id,
            })
        })
        .collect())
}

/// Cached model catalog fetcher.
#[derive(Debug)]
pub struct ModelCatalog {
    transport: Arc<dyn HttpTransport>,
    cache: Mutex<Option<(i64, Vec<ModelInfo>)>>,
}

impl ModelCatalog {
    /// New catalog over a transport.
    #[must_use]
    pub fn new(transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            transport,
            cache: Mutex::new(None),
        }
    }

    /// List models. Serves the cache when younger than [`CACHE_TTL_MS`]; otherwise fetches. Any
    /// failure (transport, non-2xx, bad JSON, empty list) yields [`fallback_models`], which is
    /// cached too so a broken network is not hammered.
    ///
    /// `api_key` is optional: the endpoint also works unauthenticated. `now_ms` is injected for
    /// deterministic tests.
    pub fn list(&self, api_key: Option<&str>, now_ms: i64) -> Vec<ModelInfo> {
        if let Ok(c) = self.cache.lock() {
            if let Some((at, models)) = c.as_ref() {
                if now_ms - at < CACHE_TTL_MS {
                    return models.clone();
                }
            }
        }
        let mut headers = Vec::new();
        if let Some(k) = api_key {
            headers.push(("Authorization".to_owned(), format!("Bearer {k}")));
        }
        let req = HttpRequest {
            method: Method::Get,
            url: OPENROUTER_MODELS_URL.into(),
            headers,
            body: None,
            timeout_secs: 30,
        };
        let fetched = self
            .transport
            .send(&req)
            .and_then(|r| {
                if r.is_success() {
                    normalize_openrouter(&r.body)
                } else {
                    Err(LlmError::Http {
                        status: r.status,
                        message: String::new(),
                    })
                }
            })
            .ok()
            .filter(|m| !m.is_empty())
            .unwrap_or_else(fallback_models);
        if let Ok(mut c) = self.cache.lock() {
            *c = Some((now_ms, fetched.clone()));
        }
        fetched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::FakeTransport;

    #[test]
    fn params_b_heuristic() {
        assert_eq!(
            parse_params_b(Some("Llama 3 70B Instruct"), None),
            Some(70.0)
        );
        assert_eq!(
            parse_params_b(Some("Mixtral"), Some("a 8.5b model")),
            Some(8.5)
        );
        assert_eq!(parse_params_b(Some("GPT-4o"), None), None);
        assert_eq!(parse_params_b(Some("model 4Bit"), None), None);
        assert_eq!(parse_params_b(None, None), None);
        assert_eq!(parse_params_b(Some("x 7 B"), None), Some(7.0));
    }

    const BODY: &str = r#"{"data":[
      {"id":"anthropic/claude-sonnet-4","name":"Claude Sonnet 4","context_length":200000,
       "pricing":{"prompt":"0.000003","completion":"0.000015"},"architecture":{"modality":"text+image->text"}},
      {"id":"meta/llama-70b","pricing":{"prompt":"bad"},"description":"Llama 70B"},
      {"name":"no id"}]}"#;

    #[test]
    fn normalizes_pricing_and_drops_idless() {
        let m = normalize_openrouter(BODY).unwrap();
        assert_eq!(m.len(), 2);
        assert!((m[0].prompt_price_per_m - 3.0).abs() < 1e-9);
        assert!((m[0].completion_price_per_m - 15.0).abs() < 1e-9);
        assert_eq!(m[0].modality, "text+image->text");
        assert_eq!(m[1].name, "meta/llama-70b");
        assert_eq!(m[1].prompt_price_per_m, 0.0);
        assert_eq!(m[1].params_b, Some(70.0));
        assert_eq!(m[1].modality, "text->text");
        let j = serde_json::to_value(&m[0]).unwrap();
        assert!(j.get("contextLength").is_some() && j.get("promptPricePerM").is_some());
        assert!(normalize_openrouter("nope").is_err());
    }

    #[test]
    fn caches_for_an_hour_and_refetches_after() {
        let t = Arc::new(FakeTransport::new());
        t.push(200, BODY);
        t.push(200, r#"{"data":[{"id":"x/y"}]}"#);
        let cat = ModelCatalog::new(t.clone());
        assert_eq!(cat.list(None, 1_000).len(), 2);
        assert_eq!(cat.list(None, 1_000 + CACHE_TTL_MS - 1).len(), 2);
        assert_eq!(t.requests().len(), 1);
        assert_eq!(cat.list(Some("k"), 1_000 + CACHE_TTL_MS).len(), 1);
        assert_eq!(t.requests().len(), 2);
        assert_eq!(t.requests()[0].header("authorization"), None);
        assert_eq!(t.requests()[1].header("authorization"), Some("Bearer k"));
    }

    #[test]
    fn falls_back_on_any_failure() {
        for setup in [0, 1, 2, 3] {
            let t = Arc::new(FakeTransport::new());
            match setup {
                0 => t.push_error("offline"),
                1 => t.push(500, "oops"),
                2 => t.push(200, "not json"),
                _ => t.push(200, r#"{"data":[]}"#),
            }
            let cat = ModelCatalog::new(t.clone());
            assert_eq!(cat.list(None, 0), fallback_models());
            // Fallback is cached too.
            assert_eq!(cat.list(None, 10), fallback_models());
            assert_eq!(t.requests().len(), 1);
        }
    }
}
