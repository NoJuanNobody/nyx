//! Document lifecycle stages, domain pipelines, transition rules and templates.
//!
//! Port of `apps/api/src/db/seed-lifecycles.ts`, `seed-templates.ts` (+ `lifecycle-templates.ts`),
//! `services/pipeline-access.service.ts` and `apps/web/src/lib/lifecycles.ts`. Pipelines are free:
//! the credit gate on activation is gone.
//!
//! - [`pipeline`]: typed [`PipelineDef`] / [`StageDef`] / [`TemplateDef`], validation, and the
//!   [`Registry`] of embedded pipelines. Definitions live as JSON under `crates/nyx-core/data/pipelines/`
//!   and are embedded at build time (see `build.rs`): add a pipeline by adding a file, no Rust edits.
//! - [`transition`]: stage transition planning and validation ([`plan_transition`]).
//! - [`template`]: `{{variable}}` rendering and markdown section parsing for templates.
//! - [`seed`]: idempotent seeding of a registry into [`crate::store::lifecycles`].
//! - [`access`]: free pipeline activation records.

pub mod access;
pub mod pipeline;
pub mod seed;
pub mod template;
pub mod transition;

pub use access::{Activation, PipelineAccess};
pub use pipeline::{PipelineDef, Registry, StageDef, TemplateDef, DEFAULT_PIPELINE_SLUG};
pub use seed::{ensure_builtin_pipelines, seed_pipelines, SeedReport};
pub use template::{instantiate, render, Rendered, Vars};
pub use transition::{plan_transition, Transition, TransitionKind, TransitionPolicy};
