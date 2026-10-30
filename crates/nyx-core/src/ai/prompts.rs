//! Prompt construction for every AI quality / advisor operation. Pure functions returning a
//! [`Prompt`]; the system texts are embedded constants ported verbatim from
//! `apps/api/src/services/ai.service.ts` (wording is behaviour: tests pin the load-bearing
//! phrases).

use super::provider::Message;

/// Which of the two configured models a prompt should run on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// The smart default model (`MODEL` in the TS service).
    Default,
    /// The fast/cheap model (`MODEL_FAST`).
    Fast,
}

/// A fully built model call, independent of provider and model slug.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    /// System prompt.
    pub system: String,
    /// Turns (last one is the user's).
    pub messages: Vec<Message>,
    /// Output cap per call.
    pub max_tokens: u32,
    /// Model tier.
    pub tier: Tier,
    /// Continue transparently across `max_tokens` cutoffs (document-length outputs).
    pub continue_past_max: bool,
}

impl Prompt {
    fn new(tier: Tier, max_tokens: u32, system: String, user: String) -> Self {
        Self {
            system,
            messages: vec![Message::user(user)],
            max_tokens,
            tier,
            continue_past_max: false,
        }
    }
}

/// Default output cap for document-length generations.
pub const DOCUMENT_MAX_TOKENS: u32 = 8192;
/// Upper bound on tickets from the bulk planner.
pub const MAX_BULK_TICKETS: usize = 12;
/// Number of history turns kept for edits.
pub const EDIT_HISTORY_TURNS: usize = 10;

/// Truncate to at most `n` characters (never splits a code point).
#[must_use]
pub fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Stage-aware quality criteria (lifecycle stage slug to focus text).
#[must_use]
pub fn stage_criteria(stage: &str) -> Option<&'static str> {
    Some(match stage {
        "conception" => "Focus on: clarity of problem definition, evidence of market validation, target user identification, uniqueness of proposed approach, and completeness of problem framing.",
        "definition" => "Focus on: completeness of requirements, unambiguous language, user story coverage with acceptance criteria, measurable success metrics, and clearly bounded scope.",
        "architecture" => "Focus on: technical feasibility, traceability back to PRD requirements, scalability and security considerations, documented trade-offs, and dependency analysis.",
        "implementation" => "Focus on: AI-readiness (can an AI coding agent act on this spec?), testable acceptance criteria, edge case coverage, ticket granularity, and rollback planning.",
        "execution" => "Focus on: documentation freshness, drift coverage against current codebase, release completeness, accuracy of documented behavior, and changelog coverage.",
        _ => return None,
    })
}

/// The `"\n\nThis is a "<stage>" stage document. <criteria>"` suffix, or empty.
fn stage_context(stage: Option<&str>) -> String {
    match stage.and_then(|s| stage_criteria(s).map(|c| (s, c))) {
        Some((s, c)) => format!("\n\nThis is a \"{s}\" stage document. {c}"),
        None => String::new(),
    }
}

/// Seeding instruction for a lifecycle transition, with the generic fallback.
#[must_use]
pub fn seed_instruction(from: &str, to: &str) -> String {
    match (from, to) {
        ("conception", "definition") => "Based on this conception document (problem statement, vision, market analysis), generate a Product Requirements Document in **markdown format**. Extract clear requirements, user stories with acceptance criteria, success metrics, and scope boundaries. Structure it as a proper PRD.".into(),
        ("definition", "architecture") => "Based on this product requirements document, design the system architecture in **markdown format**. Include data model design, API contracts, component specifications, and key architectural decisions. Trace each architecture element back to a requirement.".into(),
        ("architecture", "implementation") => "Based on this architecture document, create an implementation specification in **markdown format**. Include step-by-step coding plan, file-by-file changes, acceptance criteria, test plan, edge cases, and a ticket breakdown. Make it actionable for an AI coding agent.".into(),
        ("implementation", "execution") => "Based on this implementation specification, generate execution documentation in **markdown format**. Include release notes template, deployment checklist, drift monitoring setup, and changelog entries. Focus on what was built and how to verify it.".into(),
        _ => format!("Based on this {from} document, generate appropriate content for a {to} stage document."),
    }
}

const SPEC_QUALITY_SYSTEM: &str = r#"You are a technical specification quality analyzer. Given a spec document, rate its quality from 1 to 10 and provide actionable improvement suggestions. A score of 10/10 is explicitly achievable and should be awarded when warranted.

Scoring guide:
- 1-3: Major gaps — missing sections, vague language, no actionable detail
- 4-6: Partial — covers basics but has significant omissions or ambiguity
- 7-8: Solid — well-structured, mostly complete, minor improvements possible
- 9: Excellent — comprehensive, clear, actionable, with only trivial polish remaining
- 10: Exceptional — comprehensive coverage, unambiguous language, fully actionable with clear acceptance criteria, addresses edge cases, and requires no further clarification to implement

If the document meets all criteria for its stage and requires no meaningful improvements, score it 10. Do not withhold a perfect score simply because "there is always room for improvement."

Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...]}"#;

/// Spec quality score (1-10) with suggestions.
#[must_use]
pub fn spec_quality(content: &str, stage: Option<&str>) -> Prompt {
    Prompt::new(
        Tier::Default,
        1024,
        format!("{SPEC_QUALITY_SYSTEM}{}", stage_context(stage)),
        format!("Analyze the quality of this specification document:\n\n{content}"),
    )
}

const DRIFT_SYSTEM: &str = r#"You are a code-spec drift detector. Compare the specification with the code and identify any mismatches. Respond ONLY with valid JSON in this exact format: {"hasDrift": <boolean>, "driftScore": <number 0-10>, "details": "<description>", "suggestions": ["fix1", "fix2", ...]}"#;

/// Spec-vs-code drift detection.
#[must_use]
pub fn drift(spec: &str, code: &str) -> Prompt {
    Prompt::new(
        Tier::Default,
        1024,
        DRIFT_SYSTEM.into(),
        format!("Compare this specification with the code and identify drift:\n\n## Specification\n{spec}\n\n## Code\n{code}"),
    )
}

const TICKET_SYSTEM: &str = r#"You are a ticket generator for a software engineering team. Given a diff between specification versions, generate a well-formatted ticket that describes **concrete code implementation work** — NOT documentation tasks.

CRITICAL RULES:
- Tickets must describe code changes: new features, bug fixes, refactors, API changes, database migrations, test additions, or infrastructure work.
- NEVER generate tickets whose primary goal is to "create documentation", "update docs", "write a guide", or "add README". Documentation-only tickets are acceptable ONLY when the spec explicitly identifies a missing doc as the sole gap.
- Titles must be action-oriented toward code: "Implement ...", "Add ...", "Fix ...", "Refactor ...", "Migrate ...", etc.

GOOD ticket titles:
- "Implement rate limiting on /api/projects endpoint"
- "Add input validation for team invitation flow"
- "Fix race condition in document version save"
- "Refactor auth middleware to support BYOK keys"

BAD ticket titles (do NOT generate these):
- "Create documentation for the API"
- "Update README with setup instructions"
- "Document the new authentication flow"
- "Write user guide for dashboard features"

Respond ONLY with valid JSON in this exact format: {"title": "<short title>", "description": "<detailed markdown description>", "labels": ["label1", "label2", ...]}"#;

/// One ticket from a spec diff.
#[must_use]
pub fn ticket_from_diff(diff: &str, context: Option<&str>) -> Prompt {
    let ctx = context.map_or_else(String::new, |c| format!("\n\nAdditional context: {c}"));
    Prompt::new(
        Tier::Default,
        1024,
        TICKET_SYSTEM.into(),
        format!("Generate a ticket from this specification diff:\n\n{diff}{ctx}"),
    )
}

const DOCUMENT_SYSTEM: &str = "You are a technical documentation writer. Given a prompt, generate a complete, well-structured markdown document. Start with a single \"# Title\" heading on the first line, followed by the full document body. Do not wrap the output in code fences or JSON — return only the markdown.";

/// Generate a markdown document from a free-form prompt (continues past token cap).
#[must_use]
pub fn document(prompt: &str) -> Prompt {
    let mut p = Prompt::new(
        Tier::Fast,
        DOCUMENT_MAX_TOKENS,
        DOCUMENT_SYSTEM.into(),
        prompt.into(),
    );
    p.continue_past_max = true;
    p
}

const EDIT_GROUNDED_SYSTEM: &str = "You are an expert spec editor. You have been given the document, the editing instruction, AND the relevant source files from the project. Treat the source files as ground truth: prefer facts derived from code over facts in the existing document, correct the document where they disagree, and only fill in details that are either already in the document or clearly supported by the code. If the instruction asks for information you cannot verify from either source, leave that section unchanged — do not invent function names, file paths, endpoints, env vars, flags, error codes, or numeric limits. Return ONLY the updated markdown — no code fences, no explanations.";
const EDIT_UNGROUNDED_SYSTEM: &str = "You have been given the document and an editing instruction but NO source code. You must not fabricate concrete implementation details. Specifically: no invented function signatures, module names, API paths, env var names, CLI flags, error codes, or numeric limits. For any quality suggestion that would require such details, leave that section unchanged and insert a brief inline marker like `> TODO: needs codebase context`. Return ONLY the updated markdown — no code fences, no explanations.";

/// A source file given to the model as ground truth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeFile {
    /// Repo-relative path.
    pub path: String,
    /// File text.
    pub content: String,
}

/// Edit a document by instruction. Grounded when `code` is non-empty. Keeps the last
/// [`EDIT_HISTORY_TURNS`] history turns.
#[must_use]
pub fn edit_document(
    current: &str,
    instruction: &str,
    history: &[Message],
    code: &[CodeFile],
) -> Prompt {
    let grounded = !code.is_empty();
    let user = if grounded {
        let block = code
            .iter()
            .map(|f| format!("### {}\n\n```\n{}\n```", f.path, f.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        format!("Here is the current document:\n\n{current}\n\n---\n\nHere are the relevant source files from the project (treat as ground truth):\n\n{block}\n\n---\n\nInstruction: {instruction}")
    } else {
        format!("Here is the current document:\n\n{current}\n\n---\n\nInstruction: {instruction}")
    };
    let start = history.len().saturating_sub(EDIT_HISTORY_TURNS);
    let mut messages: Vec<Message> = history[start..].to_vec();
    messages.push(Message::user(user));
    Prompt {
        system: if grounded {
            EDIT_GROUNDED_SYSTEM
        } else {
            EDIT_UNGROUNDED_SYSTEM
        }
        .into(),
        messages,
        max_tokens: DOCUMENT_MAX_TOKENS,
        tier: Tier::Fast,
        continue_past_max: true,
    }
}

/// A document version for change analysis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionChange {
    /// Version number.
    pub version: i64,
    /// Commit-style message.
    pub message: Option<String>,
    /// Full content (truncated to 1000 chars in the prompt).
    pub content: String,
}

const CHANGES_SYSTEM: &str = r#"You are a change analyst for a software engineering team. Given a set of document version changes, analyze them and suggest ticket groupings. Group related changes into logical tickets that describe **concrete code implementation work**.

CRITICAL RULES:
- Each suggested ticket must describe actionable engineering work: new features, bug fixes, refactors, API changes, database migrations, test additions, or infrastructure tasks.
- NEVER suggest tickets whose primary goal is to "create documentation", "update docs", or "write a guide". Documentation-only tickets are acceptable ONLY when the change explicitly identifies a missing doc as the sole gap.
- Ticket titles must be action-oriented toward code changes: "Implement ...", "Add ...", "Fix ...", "Refactor ...", "Migrate ...", etc.

Respond ONLY with valid JSON in this exact format: {"title": "<proposal title>", "description": "<summary of all changes>", "suggestedTickets": [{"title": "<ticket title>", "description": "<detailed description>", "priority": "high|medium|low", "labels": ["label1"]}]}"#;

/// Group version changes into suggested tickets.
#[must_use]
pub fn changes_for_tickets(changes: &[VersionChange], document_title: &str) -> Prompt {
    let summary = changes
        .iter()
        .map(|c| {
            let msg = c
                .message
                .as_ref()
                .map_or_else(String::new, |m| format!(" — {m}"));
            format!(
                "### Version {}{}\n{}",
                c.version,
                msg,
                truncate_chars(&c.content, 1000)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Prompt::new(
        Tier::Default,
        2048,
        CHANGES_SYSTEM.into(),
        format!("Analyze these changes to the document \"{document_title}\" and suggest tickets:\n\n{summary}"),
    )
}

fn files_block(files: &[CodeFile]) -> String {
    files
        .iter()
        .map(|f| format!("### {}\n```\n{}\n```", f.path, f.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

const BOOTSTRAP_SYSTEM: &str = "You are a technical documentation generator. Given a set of code files from a repository, generate comprehensive initial documentation in Markdown format. Include: project overview, architecture notes, key modules, setup instructions if inferable, and any important patterns you notice.";

/// Initial documentation from repository files.
#[must_use]
pub fn bootstrap_docs(files: &[CodeFile]) -> Prompt {
    Prompt::new(
        Tier::Default,
        4096,
        BOOTSTRAP_SYSTEM.into(),
        format!(
            "Generate documentation from these code files:\n\n{}",
            files_block(files)
        ),
    )
}

/// Per-module documentation (fast model, as in the TS service).
#[must_use]
pub fn module_docs(module: &str, files: &[CodeFile]) -> Prompt {
    let system = format!("You are a technical documentation generator focused on the \"{module}\" module of a codebase. Analyze the provided source files and generate focused documentation in Markdown format. Include:\n- **Purpose**: What this module does and its responsibilities\n- **Key workflows**: Step-by-step data flows\n- **API surface**: Exported functions, endpoints, type signatures\n- **Dependencies**: What it imports, what depends on it\n- **Configuration**: Relevant env vars, feature flags\n\nBe concise but thorough. Use code references where helpful.");
    Prompt::new(
        Tier::Fast,
        2048,
        system,
        format!(
            "Generate documentation for the \"{module}\" module from these files:\n\n{}",
            files_block(files)
        ),
    )
}

/// Merge per-module docs into one document (default model).
#[must_use]
pub fn merge_module_docs(docs: &[(String, String)], repo: &str) -> Prompt {
    let sections = docs
        .iter()
        .map(|(m, d)| format!("## Module: {m}\n\n{d}"))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let system = format!("You are a technical documentation editor. You are given per-module documentation for the \"{repo}\" repository. Merge them into a single, well-structured document with:\n1. A project overview section (synthesized from all modules)\n2. Architecture overview (how modules connect)\n3. Each module as a section with its documentation\n4. End-to-end workflows that cross modules\n\nPreserve the technical detail from each module doc. Use clean Markdown formatting with headers, lists, and code blocks.");
    Prompt::new(
        Tier::Default,
        8192,
        system,
        format!("Merge these module docs into a structured document for {repo}:\n\n{sections}"),
    )
}

const MISSING_SECTIONS_SYSTEM: &str = r#"You are a technical specification completeness analyzer. Given a document, identify any important sections that are missing. Respond ONLY with valid JSON in this exact format: {"missingSections": [{"name": "<section name>", "description": "<why this section matters>", "priority": "high" | "medium" | "low"}]}"#;

/// Which important sections are missing.
#[must_use]
pub fn missing_sections(content: &str, stage: Option<&str>) -> Prompt {
    Prompt::new(
        Tier::Default,
        1024,
        format!("{MISSING_SECTIONS_SYSTEM}{}", stage_context(stage)),
        format!("Analyze this document for missing sections:\n\n{content}"),
    )
}

const NOTIFICATION_SYSTEM: &str = r#"You are an AI advisor assistant for a documentation platform. A user is replying to a notification about their document. Provide a helpful follow-up response. Respond ONLY with valid JSON in this exact format: {"reply": "<your response>", "suggestedActions": ["action1", "action2"]}"#;

/// Reply to a user's message about an advisor notification.
#[must_use]
pub fn notification_reply(notification_id: &str, message: &str, document: &str) -> Prompt {
    Prompt::new(
        Tier::Default,
        1024,
        NOTIFICATION_SYSTEM.into(),
        format!(
            "Notification ID: {notification_id}\n\nUser message: {message}\n\nDocument context:\n{}",
            truncate_chars(document, 2000)
        ),
    )
}

/// Phase 1 of the bulk ticket planner: titles, labels and one-line summaries only.
#[must_use]
pub fn bulk_outline(
    title: &str,
    content: &str,
    stage: Option<&str>,
    code_context: Option<&str>,
) -> Prompt {
    let stage_focus = match stage {
        Some("conception" | "definition") => "Focus on requirement gaps, missing user stories, and unanswered questions that need code solutions.",
        Some("architecture" | "implementation") => "Focus on code changes, API contracts, migration tasks, and test coverage.",
        Some("execution") => "Focus on drift remediation — code fixes to bring implementation back in sync with specs.",
        _ => "",
    };
    let code_block = code_context
        .map(|c| truncate_chars(c, 3000))
        .filter(|c| !c.is_empty())
        .map_or_else(String::new, |c| format!("\n\nLinked code context:\n{c}"));
    let system = format!("Ticket planning engine. List exactly the tickets needed to implement the document, generating at most {MAX_BULK_TICKETS} tickets. Focus on the most important changes required. Each ticket = one independently deliverable unit of code work. {stage_focus}{}\n\nRules:\n- Code work only: features, bugs, tests, APIs, migrations, security. No doc-only tickets.\n- Title: \"[S]\"/\"[M]\"/\"[L]\" prefix + action verb\n- Labels: 1-3 labels\n- Description: one sentence summary ONLY (details will be expanded separately)\n\nJSON array only: [{{title, description, labels}}]", stage_context(stage));
    Prompt::new(
        Tier::Fast,
        4096,
        system,
        format!(
            "Plan tickets for \"{title}\":\n\n{}{code_block}",
            truncate_chars(content, 12_000)
        ),
    )
}

/// Phase 2 of the bulk planner: expand ticket number `idx` (0-based) given all titles.
#[must_use]
pub fn bulk_expand(
    idx: usize,
    ticket_title: &str,
    ticket_summary: &str,
    all_titles: &[String],
    doc_title: &str,
    content: &str,
) -> Prompt {
    let n = idx + 1;
    let titles = all_titles
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{}. {t}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let system = format!("Expand ticket #{n} into a detailed implementation spec. Return ONLY the markdown description (no JSON, no wrapping). Include these sections:\n\n## Context\nWhich spec section this addresses and WHY.\n\n## Implementation Details\nStep-by-step: what code to write, patterns, libraries/APIs, data flow, error handling. Specific enough to start coding.\n\n## Affected Areas\nSpecific file paths, modules, DB tables, API endpoints, or components.\n\n## Acceptance Criteria\n3-8 testable checklist items. Specific, not vague.\n\nIMPORTANT: Focus ONLY on this ticket's scope. Do NOT overlap with other tickets in the plan. Here is the full ticket list for context — the other tickets handle everything not in your scope:\n{titles}");
    Prompt::new(
        Tier::Fast,
        2048,
        system,
        format!("Expand ticket #{n}:\nTitle: {ticket_title}\nSummary: {ticket_summary}\n\nFrom document \"{doc_title}\":\n{}", truncate_chars(content, 4000)),
    )
}

const EXPAND_SYSTEM: &str = "Expand a brief ticket into a detailed implementation description. Include: ## Context (which part of the spec), ## Affected Areas (files/modules), ## Acceptance Criteria (checklist). Be specific and actionable. Return markdown only, no JSON.";

/// Expand a brief ticket into a full description on demand.
#[must_use]
pub fn expand_ticket(
    ticket_title: &str,
    brief: &str,
    doc_title: &str,
    doc_content: &str,
) -> Prompt {
    Prompt::new(
        Tier::Fast,
        1024,
        EXPAND_SYSTEM.into(),
        format!("Ticket: {ticket_title}\nBrief: {brief}\n\nFrom document \"{doc_title}\":\n{doc_content}"),
    )
}

const DECISION_SYSTEM: &str = r#"You are a capacity estimation engine for AI-agent-heavy development teams. The bottleneck is no longer writing code — it is human judgment: reviewing, deciding, and integrating.

Given a specification document, estimate its DECISION WEIGHT — the human judgment cost to ship what this doc describes. Analyze these five signals:

1. **ambiguity** (1–20): Count of TBDs, open questions, vague language, undefined terms, missing acceptance criteria. Higher = more decisions the team must resolve.
2. **integrationSurface** (1–20): Number of external systems, APIs, other components, or teams this work touches. Each seam requires human coordination.
3. **validationDifficulty** (1–20): How hard is it to verify correctness? Visual UI is easy (low). Sync logic, data integrity, state management, security — these need deep review (high).
4. **scopeSpread** (1–20): How many distinct work items does this doc imply? More items = more review cycles and integration points.
5. **novelty** (1–20): Is there prior art to compare against, or is this greenfield? Novel work requires more judgment per unit of output.

Also estimate **reviewCycles** — the number of human review passes this work will realistically require before it's shippable (1–10).

Identify the top 2–4 **bottlenecks** — specific items in the doc driving the weight up (e.g., "No acceptance criteria for the sync endpoint", "Touches 4 external APIs with no error contract defined").

Respond ONLY with valid JSON:
{"weight": <sum of 5 signals, 5–100>, "breakdown": {"ambiguity": <n>, "integrationSurface": <n>, "validationDifficulty": <n>, "scopeSpread": <n>, "novelty": <n>}, "bottlenecks": ["...", "..."], "reviewCycles": <n>}"#;

/// Decision-weight (human judgment cost) estimate.
#[must_use]
pub fn decision_weight(content: &str, stage: Option<&str>) -> Prompt {
    let ctx = stage.map_or_else(String::new, |s| format!("\n\nThis is a \"{s}\" stage document. Earlier stages (conception, definition) typically carry higher ambiguity; later stages (implementation, execution) carry higher validation difficulty."));
    Prompt::new(
        Tier::Default,
        1024,
        format!("{DECISION_SYSTEM}{ctx}"),
        format!(
            "Estimate the decision weight of this specification:\n\n{}",
            truncate_chars(content, 8000)
        ),
    )
}

const MEETING_SYSTEM: &str = r#"You are a meeting notes quality analyzer for a technical team. Given meeting notes, rate their quality from 1 to 10 and provide actionable improvement suggestions. Evaluate based on these criteria:
- Are decisions clearly stated with owners?
- Are action items specific, assigned, and have deadlines?
- Are code references resolvable (file paths, not vague)?
- Are open questions properly flagged?
- Is the summary comprehensive?
- Is there proper speaker attribution?

Also extract metrics: count of decisions, action items, code references, and open questions.

Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...], "meetingMetrics": {"decisions": <number>, "actionItems": <number>, "codeReferences": <number>, "openQuestions": <number>}}"#;

/// Meeting-note quality score and metrics.
#[must_use]
pub fn meeting_quality(content: &str) -> Prompt {
    Prompt::new(
        Tier::Default,
        1024,
        MEETING_SYSTEM.into(),
        format!("Analyze the quality of these meeting notes:\n\n{content}"),
    )
}

const MEETING_APPLY_SYSTEM: &str = "You are an expert meeting notes editor. Given meeting notes and a list of improvement suggestions, apply all the suggested improvements to the content. Return ONLY the updated markdown content. Do not wrap the output in code fences. Do not include any explanations — just the raw updated markdown.";

/// Apply improvement suggestions to meeting notes.
#[must_use]
pub fn apply_meeting_suggestions(content: &str, suggestions: &[String]) -> Prompt {
    let list = suggestions
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {s}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    Prompt::new(
        Tier::Default,
        4096,
        MEETING_APPLY_SYSTEM.into(),
        format!(
            "Here are the meeting notes:\n\n{content}\n\n---\n\nApply these improvements:\n{list}"
        ),
    )
}

/// Seed the next lifecycle stage's document from the current one (continues past token cap).
#[must_use]
pub fn seed_next_stage(content: &str, from: &str, to: &str) -> Prompt {
    let system = format!("You are a technical documentation expert helping teams progress through their product lifecycle. {} Write the output as a well-structured markdown document. Start with a # Title heading on the first line.", seed_instruction(from, to));
    let mut p = Prompt::new(
        Tier::Fast,
        DOCUMENT_MAX_TOKENS,
        system,
        format!("Generate the next-stage document from this source:\n\n{content}"),
    );
    p.continue_past_max = true;
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_quality_includes_stage_criteria_only_for_known_stages() {
        let p = spec_quality("DOC", Some("implementation"));
        assert!(p
            .system
            .contains("This is a \"implementation\" stage document."));
        assert!(p.system.contains("AI-readiness"));
        assert!(p.system.contains("score of 10/10 is explicitly achievable"));
        assert!(p.system.contains(r#"{"score": <number>, "suggestions""#));
        assert_eq!(p.max_tokens, 1024);
        assert_eq!(p.tier, Tier::Default);
        assert!(p.messages[0].content.ends_with("DOC"));
        assert!(!spec_quality("d", Some("bogus"))
            .system
            .contains("stage document"));
        assert!(!spec_quality("d", None).system.contains("stage document"));
    }

    #[test]
    fn every_stage_has_criteria() {
        for s in [
            "conception",
            "definition",
            "architecture",
            "implementation",
            "execution",
        ] {
            assert!(stage_criteria(s).is_some(), "{s}");
        }
        assert!(stage_criteria("nope").is_none());
    }

    #[test]
    fn seed_instructions_cover_transitions_and_fallback() {
        assert!(
            seed_instruction("conception", "definition").contains("Product Requirements Document")
        );
        assert!(seed_instruction("architecture", "implementation").contains("AI coding agent"));
        assert_eq!(
            seed_instruction("a", "b"),
            "Based on this a document, generate appropriate content for a b stage document."
        );
        let p = seed_next_stage("SRC", "definition", "architecture");
        assert!(p.system.contains("markdown format"));
        assert!(p.system.contains("Start with a # Title heading"));
        assert!(p.continue_past_max);
        assert_eq!(p.tier, Tier::Fast);
    }

    #[test]
    fn edit_grounded_vs_ungrounded() {
        let code = vec![CodeFile {
            path: "src/a.rs".into(),
            content: "fn a(){}".into(),
        }];
        let g = edit_document("DOC", "do it", &[], &code);
        assert!(g.system.contains("Treat the source files as ground truth"));
        let u = &g.messages.last().unwrap().content;
        assert!(u.contains("### src/a.rs\n\n```\nfn a(){}\n```"));
        assert!(u.ends_with("Instruction: do it"));
        let n = edit_document("DOC", "do it", &[], &[]);
        assert!(n.system.contains("NO source code"));
        assert!(n.system.contains("TODO: needs codebase context"));
        assert!(!n.messages[0].content.contains("source files"));
    }

    #[test]
    fn edit_keeps_last_ten_history_turns() {
        let hist: Vec<Message> = (0..15).map(|i| Message::user(format!("h{i}"))).collect();
        let p = edit_document("d", "i", &hist, &[]);
        assert_eq!(p.messages.len(), 11);
        assert_eq!(p.messages[0].content, "h5");
    }

    #[test]
    fn ticket_prompt_forbids_doc_only_tickets_and_embeds_context() {
        let p = ticket_from_diff("DIFF", Some("ctx"));
        assert!(p
            .system
            .contains("NEVER generate tickets whose primary goal"));
        assert!(p.messages[0]
            .content
            .ends_with("DIFF\n\nAdditional context: ctx"));
        assert!(!ticket_from_diff("D", None).messages[0]
            .content
            .contains("Additional context"));
    }

    #[test]
    fn changes_prompt_truncates_each_version_and_formats_message() {
        let long = "x".repeat(2000);
        let p = changes_for_tickets(
            &[
                VersionChange {
                    version: 1,
                    message: Some("init".into()),
                    content: long,
                },
                VersionChange {
                    version: 2,
                    message: None,
                    content: "short".into(),
                },
            ],
            "Spec",
        );
        let u = &p.messages[0].content;
        assert!(u.contains("### Version 1 — init\n"));
        assert!(u.contains("### Version 2\nshort"));
        assert_eq!(u.matches('x').count(), 1000);
        assert_eq!(p.max_tokens, 2048);
    }

    #[test]
    fn bulk_outline_stage_focus_and_limits() {
        let p = bulk_outline(
            "T",
            &"Q".repeat(20_000),
            Some("execution"),
            Some("src/x.rs"),
        );
        assert!(p.system.contains("at most 12 tickets"));
        assert!(p.system.contains("drift remediation"));
        assert!(p
            .system
            .contains("JSON array only: [{title, description, labels}]"));
        assert!(p.messages[0]
            .content
            .contains("Linked code context:\nsrc/x.rs"));
        assert_eq!(p.messages[0].content.matches('Q').count(), 12_000);
        assert_eq!(p.tier, Tier::Fast);
        assert!(!bulk_outline("T", "c", None, Some("")).messages[0]
            .content
            .contains("Linked code"));
    }

    #[test]
    fn bulk_expand_lists_all_titles() {
        let titles = vec!["[S] One".to_owned(), "[M] Two".to_owned()];
        let p = bulk_expand(1, "[M] Two", "sum", &titles, "Doc", "content");
        assert!(p.system.contains("Expand ticket #2"));
        assert!(p.system.contains("1. [S] One\n2. [M] Two"));
        assert!(p.messages[0]
            .content
            .starts_with("Expand ticket #2:\nTitle: [M] Two\nSummary: sum"));
    }

    #[test]
    fn decision_weight_prompt() {
        let p = decision_weight(&"é".repeat(9000), Some("definition"));
        assert!(p.system.contains("**ambiguity** (1–20)"));
        assert!(p.system.contains("Earlier stages"));
        assert_eq!(
            p.messages[0].content.chars().filter(|c| *c == 'é').count(),
            8000
        );
    }

    #[test]
    fn misc_prompts() {
        assert!(missing_sections("d", Some("architecture"))
            .system
            .contains("traceability"));
        assert_eq!(
            notification_reply("n1", "hi", &"z".repeat(3000)).messages[0]
                .content
                .matches('z')
                .count(),
            2000
        );
        let m = apply_meeting_suggestions("N", &["a".into(), "b".into()]);
        assert!(m.messages[0]
            .content
            .ends_with("Apply these improvements:\n1. a\n2. b"));
        assert!(meeting_quality("n").system.contains("meetingMetrics"));
        let md = module_docs(
            "auth",
            &[CodeFile {
                path: "p".into(),
                content: "c".into(),
            }],
        );
        assert!(md.system.contains("\"auth\" module"));
        assert_eq!(md.tier, Tier::Fast);
        let mg = merge_module_docs(&[("auth".into(), "docs".into())], "repo");
        assert!(mg.messages[0].content.contains("## Module: auth\n\ndocs"));
        assert_eq!(mg.max_tokens, 8192);
        assert!(document("write").continue_past_max);
        assert_eq!(expand_ticket("t", "b", "d", "c").max_tokens, 1024);
        assert_eq!(drift("S", "C").messages[0].content, "Compare this specification with the code and identify drift:\n\n## Specification\nS\n\n## Code\nC");
        assert!(bootstrap_docs(&[]).system.contains("project overview"));
    }
}
