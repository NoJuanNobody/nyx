# Lifecycle: stages, templates, domain pipelines (AI-64)

Module: `crates/nyx-core/src/lifecycle/`. Data: `crates/nyx-core/data/pipelines/*.json`.

## TS source mapping

| TypeScript | Rust |
|---|---|
| `apps/api/src/db/seed-lifecycles.ts` (20 lifecycles, 5/6/8 stages) | `data/pipelines/<slug>.json` + `lifecycle::seed::{seed_pipelines, ensure_builtin_pipelines}` |
| `apps/api/src/db/seed-templates.ts` + `lifecycle-templates.ts` (260 templates) | `templates` array inside each pipeline JSON, `PipelineDef::templates_for/template`, `Registry::all_templates` |
| `apps/web/src/lib/lifecycles.ts` (`connectors`, `suggestions`, `getLifecycle/getStages/getStageInfo/getNextStage/getAllLifecycles`) | `connectors` + per-stage `suggestions` in the JSON, `Registry::{resolve, stage_info, next_stage, list}` |
| `routes/documents.ts` stage change (unrestricted) and `docs/lifecycle-stages.md` "Stage Transitions" | `lifecycle::transition::plan_transition` (`Free` = TS behaviour, `Sequential` = guided mode) |
| `services/pipeline-access.service.ts` | `lifecycle::access::PipelineAccess` (free: `credits_paid` is always 0), migration 164 `pipeline_activations` |
| `routes/templates.ts` (list/filter) | read side only, via `PipelineDef::templates_for` |

## Adding a pipeline (no Rust edits)

Drop `data/pipelines/<slug>.json` (file name must equal the slug). `build.rs` regenerates the include list. The shape is `PipelineDef`
(unknown fields are rejected). Run `cargo test -p nyx-core lifecycle` to validate: slug format, unique stages, `#RRGGBB`
colours, increasing `sort_order`, `connectors` empty or `stages-1`, templates bound to real stages, `{{ }}` syntax.
Exactly one pipeline may set `is_default`.

## Templates

- `{{name}}`, `{{name|default}}`, `\{{` for a literal. `render` reports unresolved names.
- The 260 ported templates use legacy placeholders (`[Feature Name]`, `[X.Y.Z]`, `YYYY-MM-DD`); `instantiate` fills them from
  vars `feature_name`, `version`, `date` and leaves unknown ones for the author.
- `MarkdownDoc` (fence-aware, lossless round trip), `set_body`, `completeness(template, doc)` for structure scoring.
- Goldens: `crates/nyx-core/tests/golden/` (`UPDATE_GOLDEN=1` to regenerate).

## Decisions and gaps

- Stage text comes from the DB seed (`seed-lifecycles.ts`); the web registry has slightly longer copy for many stages. Only
  its `connectors` and `suggestions` were merged. `unscripted_video_production` exists only in the seed, so it has no
  connectors or suggestions yet.
- Stage slugs repeat across pipelines (`revisions`, `final_delivery`, ...). TS templates were keyed by stage slug alone and
  therefore leaked across pipelines; here each template belongs to exactly one pipeline (assigned from the section headers of `lifecycle-templates.ts`).
- Seeding never steals the default flag from an existing default (TS would hit the unique index) and never updates existing rows.
- Templates are not persisted in SQLite: `document_templates` (custom per-team templates, `routes/templates.ts` CRUD) is not
  ported. TODO: migration + `TemplateRepo` if custom templates are wanted.
- `activate` rejects unknown pipeline slugs (TS did not validate). No FK on `user_id`/`team_id`.
- The AI "seeding prompts" and stage-aware quality prompts in `docs/lifecycle-stages.md` are agent features and not ported.
- `tests/migrations.rs` used version 100 for its "extra migration" fixture, which now sorts before 164; changed to 9000.
