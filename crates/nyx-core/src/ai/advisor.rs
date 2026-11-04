//! The AI Advisor: one-shot quality and drafting operations over any [`LlmProvider`].
//!
//! Port of the non-chat half of `ai.service.ts` (spec quality, drift, tickets, documents, edits,
//! missing sections, decision weight, meeting notes, stage seeding, bulk ticket planning). Each
//! method is `build prompt -> one provider call -> tolerant parse`; there is no agent loop, no
//! tool use and no conversation state beyond the history the caller passes to
//! [`Advisor::edit_document`].

use super::config::ModelPair;
use super::parse::{
    self, ChangeAnalysis, DecisionWeight, DriftReport, GeneratedDocument, MeetingQuality,
    MissingSection, NotificationReply, SpecQuality, TicketDraft,
};
use super::prompts::{self, CodeFile, Prompt, Tier, VersionChange, MAX_BULK_TICKETS};
use super::provider::{complete_full, LlmError, LlmProvider, LlmRequest, Message, Usage};

/// Max `max_tokens` continuations for document-length outputs (as in the TS service).
pub const MAX_CONTINUATIONS: usize = 6;

/// Receives token usage after every provider call (see `ai::store::SqliteUsage`).
pub trait UsageSink {
    /// Record one call.
    fn record(&self, operation: &str, provider: &str, model: &str, usage: Usage);
}

/// Advisor bound to a provider and a model pair.
#[derive(Clone, Copy)]
pub struct Advisor<'a> {
    llm: &'a dyn LlmProvider,
    models: &'a ModelPair,
    usage: Option<&'a dyn UsageSink>,
}

impl std::fmt::Debug for Advisor<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Advisor")
            .field("llm", &self.llm)
            .field("models", &self.models)
            .finish_non_exhaustive()
    }
}

impl<'a> Advisor<'a> {
    /// New advisor without usage tracking.
    #[must_use]
    pub fn new(llm: &'a dyn LlmProvider, models: &'a ModelPair) -> Self {
        Self {
            llm,
            models,
            usage: None,
        }
    }

    /// Attach a usage sink.
    #[must_use]
    pub fn with_usage(mut self, sink: &'a dyn UsageSink) -> Self {
        self.usage = Some(sink);
        self
    }

    /// Execute a built prompt and return the raw text.
    fn run(&self, operation: &str, p: &Prompt) -> Result<String, LlmError> {
        let model = match p.tier {
            Tier::Default => &self.models.default,
            Tier::Fast => &self.models.fast,
        };
        let req = LlmRequest {
            model: model.clone(),
            system: p.system.clone(),
            messages: p.messages.clone(),
            max_tokens: p.max_tokens,
            temperature: None,
        };
        let resp = if p.continue_past_max {
            complete_full(self.llm, &req, MAX_CONTINUATIONS)?
        } else {
            self.llm.complete(&req)?
        };
        if let Some(u) = self.usage {
            u.record(operation, self.llm.name(), model, resp.usage);
        }
        Ok(resp.text)
    }

    /// Stage-aware spec quality score (1-10) and suggestions.
    ///
    /// # Errors
    /// Provider failure. Unparseable *replies* never error (see [`parse::spec_quality`]).
    pub fn analyze_spec_quality(
        &self,
        content: &str,
        stage: Option<&str>,
    ) -> Result<SpecQuality, LlmError> {
        Ok(parse::spec_quality(
            &self.run("analyze", &prompts::spec_quality(content, stage))?,
        ))
    }

    /// Spec-vs-code drift.
    ///
    /// # Errors
    /// Provider failure.
    pub fn detect_drift(&self, spec: &str, code: &str) -> Result<DriftReport, LlmError> {
        Ok(parse::drift(
            &self.run("detect-drift", &prompts::drift(spec, code))?,
        ))
    }

    /// One ticket from a spec diff.
    ///
    /// # Errors
    /// Provider failure.
    pub fn generate_ticket_from_diff(
        &self,
        diff: &str,
        context: Option<&str>,
    ) -> Result<TicketDraft, LlmError> {
        Ok(parse::ticket(&self.run(
            "generate-ticket",
            &prompts::ticket_from_diff(diff, context),
        )?))
    }

    /// Generate a markdown document from a prompt.
    ///
    /// # Errors
    /// Provider failure.
    pub fn generate_document(&self, prompt: &str) -> Result<GeneratedDocument, LlmError> {
        Ok(parse::document(
            &self.run("generate-document", &prompts::document(prompt))?,
        ))
    }

    /// Edit a document by instruction. Pass `code` to ground the edit in source files.
    ///
    /// # Errors
    /// Provider failure.
    pub fn edit_document(
        &self,
        current: &str,
        instruction: &str,
        history: &[Message],
        code: &[CodeFile],
    ) -> Result<String, LlmError> {
        let text = self.run(
            "edit-document",
            &prompts::edit_document(current, instruction, history, code),
        )?;
        Ok(parse::strip_edge_fences(&text))
    }

    /// Group version changes into suggested tickets.
    ///
    /// # Errors
    /// Provider failure.
    pub fn analyze_changes_for_tickets(
        &self,
        changes: &[VersionChange],
        document_title: &str,
    ) -> Result<ChangeAnalysis, LlmError> {
        Ok(parse::change_analysis(
            &self.run(
                "analyze-changes",
                &prompts::changes_for_tickets(changes, document_title),
            )?,
            document_title,
        ))
    }

    /// Initial docs from repository files.
    ///
    /// # Errors
    /// Provider failure.
    pub fn bootstrap_docs_from_code(&self, files: &[CodeFile]) -> Result<String, LlmError> {
        self.run("bootstrap-docs", &prompts::bootstrap_docs(files))
    }

    /// Docs for one module.
    ///
    /// # Errors
    /// Provider failure.
    pub fn bootstrap_module_docs(
        &self,
        module: &str,
        files: &[CodeFile],
    ) -> Result<String, LlmError> {
        self.run(
            "bootstrap-module-docs",
            &prompts::module_docs(module, files),
        )
    }

    /// Merge per-module docs (`(module, docs)` pairs) into one document.
    ///
    /// # Errors
    /// Provider failure.
    pub fn merge_module_docs(
        &self,
        docs: &[(String, String)],
        repo: &str,
    ) -> Result<String, LlmError> {
        self.run("merge-module-docs", &prompts::merge_module_docs(docs, repo))
    }

    /// Missing important sections.
    ///
    /// # Errors
    /// Provider failure.
    pub fn analyze_missing_sections(
        &self,
        content: &str,
        stage: Option<&str>,
    ) -> Result<Vec<MissingSection>, LlmError> {
        Ok(parse::missing_sections(&self.run(
            "missing-sections",
            &prompts::missing_sections(content, stage),
        )?))
    }

    /// Reply to a user's message about an advisor notification.
    ///
    /// # Errors
    /// Provider failure.
    pub fn notification_reply(
        &self,
        notification_id: &str,
        message: &str,
        document: &str,
    ) -> Result<NotificationReply, LlmError> {
        Ok(parse::notification_reply(&self.run(
            "notification-reply",
            &prompts::notification_reply(notification_id, message, document),
        )?))
    }

    /// Plan up to [`MAX_BULK_TICKETS`] tickets for a document, then expand each one.
    ///
    /// Phase 1 asks the fast model for an outline; phase 2 expands every ticket with the full
    /// title list as context. Unlike the TS version (parallel `Promise.all`) the expansions run
    /// sequentially; a failed expansion keeps the outline ticket. If the outline cannot be
    /// parsed a single "[M] Review" placeholder ticket is returned.
    ///
    /// # Errors
    /// Provider failure in phase 1 only.
    pub fn generate_bulk_ticket_suggestions(
        &self,
        content: &str,
        title: &str,
        stage: Option<&str>,
        code_context: Option<&str>,
    ) -> Result<Vec<TicketDraft>, LlmError> {
        let raw = self.run(
            "bulk-outline",
            &prompts::bulk_outline(title, content, stage, code_context),
        )?;
        let mut outline = parse::ticket_array(&raw);
        outline.truncate(MAX_BULK_TICKETS);
        if outline.is_empty() {
            return Ok(vec![TicketDraft {
                title: format!("[M] Review \"{title}\""),
                description:
                    "AI generated suggestions but they could not be parsed. Please try again."
                        .into(),
                labels: vec!["spec-review".into()],
            }]);
        }
        let titles: Vec<String> = outline.iter().map(|t| t.title.clone()).collect();
        Ok(outline
            .into_iter()
            .enumerate()
            .map(|(i, t)| {
                let p = prompts::bulk_expand(i, &t.title, &t.description, &titles, title, content);
                match self.run("bulk-expand", &p) {
                    Ok(text) if !text.trim().is_empty() => TicketDraft {
                        description: text.trim().to_owned(),
                        ..t
                    },
                    _ => t,
                }
            })
            .collect())
    }

    /// Expand a brief ticket into a full description; returns `brief` if the model says nothing.
    ///
    /// # Errors
    /// Provider failure.
    pub fn expand_ticket_description(
        &self,
        ticket_title: &str,
        brief: &str,
        doc_title: &str,
        doc_content: &str,
    ) -> Result<String, LlmError> {
        let text = self.run(
            "expand-ticket",
            &prompts::expand_ticket(ticket_title, brief, doc_title, doc_content),
        )?;
        Ok(if text.trim().is_empty() {
            brief.to_owned()
        } else {
            text
        })
    }

    /// Decision weight (human judgment cost) of a spec.
    ///
    /// # Errors
    /// Provider failure.
    pub fn estimate_decision_weight(
        &self,
        content: &str,
        stage: Option<&str>,
    ) -> Result<DecisionWeight, LlmError> {
        Ok(parse::decision_weight(&self.run(
            "decision-weight",
            &prompts::decision_weight(content, stage),
        )?))
    }

    /// Meeting-note quality.
    ///
    /// # Errors
    /// Provider failure.
    pub fn analyze_meeting_note_quality(&self, content: &str) -> Result<MeetingQuality, LlmError> {
        Ok(parse::meeting_quality(&self.run(
            "meeting-quality",
            &prompts::meeting_quality(content),
        )?))
    }

    /// Apply improvement suggestions to meeting notes.
    ///
    /// # Errors
    /// Provider failure.
    pub fn apply_meeting_suggestions(
        &self,
        content: &str,
        suggestions: &[String],
    ) -> Result<String, LlmError> {
        let text = self.run(
            "meeting-apply",
            &prompts::apply_meeting_suggestions(content, suggestions),
        )?;
        Ok(parse::strip_edge_fences(&text))
    }

    /// Seed the next lifecycle stage's document from the current one.
    ///
    /// # Errors
    /// Provider failure.
    pub fn seed_next_stage(
        &self,
        content: &str,
        from: &str,
        to: &str,
    ) -> Result<GeneratedDocument, LlmError> {
        Ok(parse::document(&self.run(
            "seed-next-stage",
            &prompts::seed_next_stage(content, from, to),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::ai::provider::{FakeLlm, LlmResponse};

    fn models() -> ModelPair {
        ModelPair {
            default: "smart".into(),
            fast: "quick".into(),
        }
    }

    #[derive(Default)]
    struct Sink(RefCell<Vec<(String, String, String, Usage)>>);
    impl UsageSink for Sink {
        fn record(&self, op: &str, provider: &str, model: &str, usage: Usage) {
            self.0
                .borrow_mut()
                .push((op.into(), provider.into(), model.into(), usage));
        }
    }

    #[test]
    fn quality_uses_default_model_and_parses() {
        let f = FakeLlm::with_texts(&[r#"{"score": 9, "suggestions": ["tighten"]}"#]);
        let m = models();
        let q = Advisor::new(&f, &m)
            .analyze_spec_quality("spec", Some("definition"))
            .unwrap();
        assert_eq!(q.score, 9.0);
        let r = &f.requests()[0];
        assert_eq!(r.model, "smart");
        assert_eq!(r.max_tokens, 1024);
        assert!(r.system.contains("\"definition\" stage document"));
    }

    #[test]
    fn malformed_model_output_never_errors() {
        let m = models();
        let f = FakeLlm::with_texts(&[
            "I think it is a 6/10",
            "???",
            "??",
            "?",
            "plain",
            "plain",
            "plain",
            "plain",
        ]);
        let a = Advisor::new(&f, &m);
        assert_eq!(a.analyze_spec_quality("s", None).unwrap().score, 6.0);
        assert!(!a.detect_drift("s", "c").unwrap().has_drift);
        assert_eq!(
            a.generate_ticket_from_diff("d", None).unwrap().labels,
            vec!["spec-change", "implementation"]
        );
        assert!(a.analyze_missing_sections("c", None).unwrap().is_empty());
        assert_eq!(a.estimate_decision_weight("c", None).unwrap().weight, 50.0);
        assert_eq!(
            a.analyze_meeting_note_quality("c")
                .unwrap()
                .meeting_metrics
                .decisions,
            0
        );
        assert_eq!(a.generate_document("p").unwrap().title, "Untitled Document");
        assert_eq!(a.notification_reply("n", "m", "d").unwrap().reply, "plain");
    }

    #[test]
    fn provider_errors_propagate() {
        let f = FakeLlm::new();
        f.push(Err(LlmError::Http {
            status: 500,
            message: "down".into(),
        }));
        let m = models();
        assert!(matches!(
            Advisor::new(&f, &m).analyze_spec_quality("s", None),
            Err(LlmError::Http { status: 500, .. })
        ));
    }

    #[test]
    fn document_generation_continues_and_uses_fast_model() {
        let f = FakeLlm::new();
        f.push(Ok(LlmResponse::truncated("# Plan\n\npart 1\n")));
        f.push_text("part 2");
        let m = models();
        let d = Advisor::new(&f, &m)
            .generate_document("write a plan")
            .unwrap();
        assert_eq!(d.title, "Plan");
        assert_eq!(d.content, "# Plan\n\npart 1\npart 2");
        assert_eq!(f.requests()[0].model, "quick");
        assert_eq!(f.call_count(), 2);
    }

    #[test]
    fn edit_strips_fences_and_grounds() {
        let f = FakeLlm::with_texts(&["```markdown\n# Edited\n```"]);
        let m = models();
        let code = [CodeFile {
            path: "a.rs".into(),
            content: "x".into(),
        }];
        let out = Advisor::new(&f, &m)
            .edit_document("# Old", "improve", &[Message::user("earlier")], &code)
            .unwrap();
        assert_eq!(out, "# Edited");
        let r = &f.requests()[0];
        assert!(r.system.contains("ground truth"));
        assert_eq!(r.messages.len(), 2);
    }

    #[test]
    fn bulk_suggestions_cap_and_expand() {
        let outline: Vec<String> = (0..15)
            .map(|i| format!(r#"{{"title":"[S] T{i}","description":"s{i}","labels":["l"]}}"#))
            .collect();
        let f = FakeLlm::new();
        f.push_text(&format!("[{}]", outline.join(",")));
        for i in 0..12 {
            if i == 3 {
                f.push(Err(LlmError::Transport("flaky".into())));
            } else if i == 4 {
                f.push_text("   ");
            } else {
                f.push_text(&format!("## Context\nexpanded {i}"));
            }
        }
        let m = models();
        let out = Advisor::new(&f, &m)
            .generate_bulk_ticket_suggestions("doc", "Doc", Some("implementation"), None)
            .unwrap();
        assert_eq!(out.len(), 12);
        assert_eq!(out[0].description, "## Context\nexpanded 0");
        assert_eq!(out[3].description, "s3", "failed expansion keeps outline");
        assert_eq!(out[4].description, "s4", "blank expansion keeps outline");
        assert_eq!(f.call_count(), 13);
        assert!(f.requests()[0].system.contains("at most 12 tickets"));
        assert_eq!(f.requests()[1].model, "quick");
    }

    #[test]
    fn bulk_suggestions_unparseable_outline_gives_review_ticket() {
        let f = FakeLlm::with_texts(&["sorry, no"]);
        let m = models();
        let out = Advisor::new(&f, &m)
            .generate_bulk_ticket_suggestions("doc", "Spec", None, None)
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "[M] Review \"Spec\"");
        assert_eq!(out[0].labels, vec!["spec-review"]);
        assert_eq!(f.call_count(), 1);
    }

    #[test]
    fn expand_falls_back_to_brief() {
        let f = FakeLlm::with_texts(&["", "## Context\nfull"]);
        let m = models();
        let a = Advisor::new(&f, &m);
        assert_eq!(
            a.expand_ticket_description("t", "brief", "d", "c").unwrap(),
            "brief"
        );
        assert!(a
            .expand_ticket_description("t", "brief", "d", "c")
            .unwrap()
            .contains("full"));
    }

    #[test]
    fn seed_and_meeting_flow() {
        let f = FakeLlm::with_texts(&["# PRD\n\nbody", "```\n# Notes\n- done\n```"]);
        let m = models();
        let a = Advisor::new(&f, &m);
        let d = a
            .seed_next_stage("concept", "conception", "definition")
            .unwrap();
        assert_eq!(d.title, "PRD");
        assert!(f.requests()[0]
            .system
            .contains("Product Requirements Document"));
        assert_eq!(
            a.apply_meeting_suggestions("n", &["add owners".into()])
                .unwrap(),
            "# Notes\n- done"
        );
    }

    #[test]
    fn usage_is_recorded_per_call() {
        let f = FakeLlm::new();
        let mut r = LlmResponse::text(r#"{"score":8,"suggestions":[]}"#);
        r.usage = Usage {
            input_tokens: 100,
            output_tokens: 20,
        };
        f.push(Ok(r));
        let m = models();
        let sink = Sink::default();
        Advisor::new(&f, &m)
            .with_usage(&sink)
            .analyze_spec_quality("s", None)
            .unwrap();
        let rows = sink.0.borrow();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "analyze");
        assert_eq!(rows[0].1, "fake");
        assert_eq!(rows[0].2, "smart");
        assert_eq!(rows[0].3.input_tokens, 100);
    }

    #[test]
    fn changes_and_module_docs_roundtrip() {
        let f = FakeLlm::with_texts(&[
            r#"{"title":"P","description":"D","suggestedTickets":[]}"#,
            "boot docs",
            "module docs",
            "merged",
            r#"{"reply":"r","suggestedActions":["a"]}"#,
            r#"{"missingSections":[{"name":"Risks","description":"d","priority":"high"}]}"#,
            r#"{"hasDrift":true,"driftScore":4,"details":"d","suggestions":[]}"#,
            r#"{"title":"T","description":"d","labels":["x"]}"#,
        ]);
        let m = models();
        let a = Advisor::new(&f, &m);
        let ch = VersionChange {
            version: 2,
            message: None,
            content: "c".into(),
        };
        assert_eq!(
            a.analyze_changes_for_tickets(&[ch], "Doc").unwrap().title,
            "P"
        );
        assert_eq!(a.bootstrap_docs_from_code(&[]).unwrap(), "boot docs");
        assert_eq!(a.bootstrap_module_docs("auth", &[]).unwrap(), "module docs");
        assert_eq!(
            a.merge_module_docs(&[("auth".into(), "d".into())], "repo")
                .unwrap(),
            "merged"
        );
        assert_eq!(
            a.notification_reply("n", "m", "d")
                .unwrap()
                .suggested_actions,
            vec!["a"]
        );
        assert_eq!(
            a.analyze_missing_sections("c", Some("architecture"))
                .unwrap()[0]
                .priority,
            "high"
        );
        assert!(a.detect_drift("s", "c").unwrap().has_drift);
        assert_eq!(
            a.generate_ticket_from_diff("d", Some("ctx")).unwrap().title,
            "T"
        );
        let reqs = f.requests();
        assert_eq!(reqs[1].model, "smart");
        assert_eq!(reqs[2].model, "quick");
        assert_eq!(reqs[3].max_tokens, 8192);
    }
}
