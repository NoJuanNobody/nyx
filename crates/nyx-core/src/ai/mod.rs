//! BYOK model providers and the AI quality / Advisor surface (non-chat).
//!
//! Ported from the TS API (ticket AI-75): `lib/llm.ts`, `routes/ai-keys.ts`, `routes/models.ts`,
//! `routes/ai.ts`, `services/ai.service.ts`, `services/claude-insights.service.ts` and
//! `services/suggestion.service.ts`. The in-app agent and chat loop are not ported.
//! No AI feature needs a Nyx-hosted key: every call goes to a provider the user configured with
//! their own key (or a local Ollama server).
//!
//! # Layers
//!
//! | Module | Role |
//! |---|---|
//! | [`provider`] | The shared [`LlmProvider`] trait, request/response types, [`FakeLlm`], [`complete_full`] |
//! | [`wire`] | Pure Anthropic Messages and OpenAI-compatible request builders / response parsers |
//! | [`transport`] | [`HttpTransport`] seam, [`FakeTransport`], real impl is a documented TODO for the wiring wave |
//! | [`config`] | [`ProviderConfig`], [`ByokKeys`] (keys live in `profile::SecretStore`), [`select_provider`] |
//! | [`client`] | [`HttpLlm`]: config + secrets + transport = a real provider |
//! | [`models`] | Model picker catalog with fallback and TTL cache |
//! | [`prompts`] / [`parse`] | Embedded prompt builders and tolerant output parsers |
//! | [`advisor`] | [`Advisor`]: the one-shot operations |
//! | [`quality`] | Score bands and the quality gate |
//! | [`insights`] | Claude GitHub Action comment parsing |
//! | [`store`] | SQLite: provider settings, usage log, ticket suggestions |
//!
//! # Example
//!
//! ```
//! use nyx_core::ai::{Advisor, FakeLlm, ModelPair};
//!
//! let llm = FakeLlm::with_texts(&[r#"{"score": 8, "suggestions": ["Add acceptance criteria"]}"#]);
//! let models = ModelPair { default: "m".into(), fast: "f".into() };
//! let q = Advisor::new(&llm, &models).analyze_spec_quality("# Spec", None).unwrap();
//! assert_eq!(q.score, 8.0);
//! ```

#![allow(unknown_lints, clippy::assert_is_empty)]

pub mod advisor;
pub mod client;
pub mod config;
pub mod insights;
pub mod models;
pub mod parse;
pub mod prompts;
pub mod provider;
pub mod quality;
pub mod store;
pub mod transport;
pub mod wire;

pub use advisor::{Advisor, UsageSink};
pub use client::HttpLlm;
pub use config::{
    normalize_model_slug, select_provider, ByokKeys, KeyStatus, ModelPair, ProviderConfig,
    ProviderKind,
};
pub use models::{ModelCatalog, ModelInfo};
pub use provider::{
    complete_full, FakeLlm, LlmError, LlmProvider, LlmRequest, LlmResponse, Message, Role,
    StopReason, Usage,
};
pub use quality::{GateResult, QualityBand, QualityGate};
pub use transport::{FakeTransport, HttpRequest, HttpResponse, HttpTransport};
