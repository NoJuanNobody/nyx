//! Sprint Gatekeeper.
//!
//! Two layers:
//!
//! 1. [`evaluate_stage_gate`]: the TS `gatekeeper.service.ts` rules, ported check for check (three
//!    checks in fixed order: content not empty, minimum length, valid sequential stage move).
//! 2. [`assess_readiness`]: the pre-sprint readiness report the Sprint Gatekeeper screen needs.
//!    It runs rules over the specs and tickets that are about to enter a sprint plus the capacity
//!    check from [`super::sprint`], and returns a 0-100 score, blockers and warnings.
//!
//! Parity note: the TS has only layer 1 and the capacity warning. The rule set in layer 2
//! (acceptance criteria, traceability, unresolved markers, oversize, duplicates, spec quality) is
//! new; it is deterministic, every rule has an id, and thresholds are in [`ReadinessConfig`].
//! Nothing here calls a model.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::draft::{dedupe_key, parse_traceability, title_similarity, DUPLICATE_THRESHOLD};
use super::sprint::{estimate_decision_weight, SprintCapacity, SprintStatus, CAPACITY_THRESHOLD};
use crate::ai::quality::{QualityBand, NEEDS_IMPROVEMENT_THRESHOLD};

/// Default stage ordering when a document has no lifecycle attached (the `documentStageEnum`).
pub const DEFAULT_STAGE_ORDER: [&str; 5] = [
    "conception",
    "definition",
    "architecture",
    "implementation",
    "execution",
];

/// Minimum trimmed content length for a stage transition.
pub const MIN_CONTENT_LENGTH: usize = 100;

/// One gate check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateCheck {
    /// Check id.
    pub name: String,
    /// Passed?
    pub passed: bool,
    /// Why not (only when failed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Result of a stage gate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateResult {
    /// All checks passed.
    pub passed: bool,
    /// The three checks, in order.
    pub checks: Vec<GateCheck>,
}

fn check(name: &str, passed: bool, reason: impl FnOnce() -> String) -> GateCheck {
    GateCheck {
        name: name.into(),
        passed,
        reason: (!passed).then(reason),
    }
}

/// May a document with `content` at `stage` move to `target`? Port of `evaluateGate`.
///
/// Edge cases kept from the TS: lengths are in characters of the trimmed content; no current stage
/// (`None`) allows any recognised target; a current stage outside `order` (including `""`)
/// allows any recognised target; moving to the same stage counts as backward; skipping ahead is
/// rejected with the expected next stage named.
#[must_use]
pub fn evaluate_stage_gate(
    content: &str,
    stage: Option<&str>,
    target: &str,
    order: &[&str],
) -> GateResult {
    let trimmed = content.trim();
    let len = trimmed.chars().count();
    let mut checks = vec![
        check("content_not_empty", len > 0, || {
            "Document content must not be empty".into()
        }),
        check("minimum_content_length", len >= MIN_CONTENT_LENGTH, || {
            format!(
                "Document content must be at least {MIN_CONTENT_LENGTH} characters (currently {len})"
            )
        }),
    ];

    let pos = |s: &str| order.iter().position(|o| *o == s);
    let target_idx = pos(target);
    let current = stage.and_then(|cur| pos(cur).map(|c| (cur, c)));
    let transition: std::result::Result<(), String> = match (target_idx, current) {
        (None, _) => Err(format!(
            "Target stage \"{target}\" is not a recognized stage"
        )),
        (Some(t), Some((cur, c))) if t <= c => Err(format!(
            "Cannot move backward from \"{cur}\" to \"{target}\""
        )),
        (Some(t), Some((cur, c))) if t != c + 1 => Err(format!(
            "Cannot skip stages: must move from \"{cur}\" to \"{}\", not \"{target}\"",
            order[c + 1]
        )),
        // No current stage, or one outside this order: any recognised target is allowed.
        (Some(_), _) => Ok(()),
    };
    checks.push(check("valid_stage_transition", transition.is_ok(), || {
        transition.clone().err().unwrap_or_default()
    }));
    GateResult {
        passed: checks.iter().all(|c| c.passed),
        checks,
    }
}

// ----------------------------------------------------------- readiness

/// How bad a finding is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Must be fixed before the sprint starts.
    Blocker,
    /// Should be looked at; does not stop the sprint.
    Warning,
}

/// What a finding is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Subject {
    /// A ticket (by id).
    Ticket(String),
    /// A spec document (by id).
    Spec(String),
    /// The sprint as a whole.
    Sprint,
}

/// One failed rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    /// Rule id (stable, e.g. `ticket.acceptance_criteria`).
    pub rule: String,
    /// Severity.
    pub severity: Severity,
    /// Subject.
    pub subject: Subject,
    /// Human-readable message.
    pub message: String,
}

/// A ticket entering the sprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketInput {
    /// Id (ticket id, issue key).
    pub id: String,
    /// Title.
    pub title: String,
    /// Body (markdown).
    pub body: String,
    /// Labels.
    pub labels: Vec<String>,
    /// Status; `Done` tickets are not assessed (already finished work).
    pub status: SprintStatus,
    /// Spec document it traces to, if known (drives `ticket.spec_linked`).
    pub document_id: Option<String>,
}

/// A spec backing the sprint's tickets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpecInput {
    /// Document id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Content.
    pub content: String,
    /// Lifecycle stage.
    pub stage: Option<String>,
    /// Latest spec-quality score (0-10, from the Advisor), if one exists.
    pub quality_score: Option<f64>,
}

/// Thresholds. `Default` is what the screen uses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadinessConfig {
    /// Minimum ticket body length (trimmed, footer excluded).
    pub min_body_chars: usize,
    /// Ticket weight at or above which a split is suggested.
    pub oversize_weight: u32,
    /// Stage a spec should have reached before its tickets enter a sprint.
    pub required_stage: String,
    /// Stage order used for `required_stage`.
    pub stage_order: Vec<String>,
    /// Capacity percentage that is a blocker (the warning level is [`CAPACITY_THRESHOLD`]).
    pub capacity_blocker_percent: u32,
}

impl Default for ReadinessConfig {
    fn default() -> Self {
        Self {
            min_body_chars: 50,
            oversize_weight: 40,
            required_stage: "implementation".into(),
            stage_order: DEFAULT_STAGE_ORDER
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            capacity_blocker_percent: 100,
        }
    }
}

/// Per-item outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemReadiness {
    /// Subject.
    pub subject: Subject,
    /// Rules evaluated.
    pub checks: u32,
    /// Rules passed.
    pub passed: u32,
    /// No blocker among the findings.
    pub ready: bool,
}

/// The readiness report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadinessReport {
    /// 0-100: weighted share of rules that passed (blocker rules weigh 3, warnings 1).
    pub score: u32,
    /// No blockers.
    pub ready: bool,
    /// Blocking findings.
    pub blockers: Vec<Finding>,
    /// Non-blocking findings.
    pub warnings: Vec<Finding>,
    /// Per ticket / spec breakdown.
    pub items: Vec<ItemReadiness>,
}

const BLOCKER_WEIGHT: u32 = 3;
const WARNING_WEIGHT: u32 = 1;

struct Run {
    passed_w: u32,
    total_w: u32,
    findings: Vec<Finding>,
    items: Vec<ItemReadiness>,
}

struct ItemRun<'r> {
    run: &'r mut Run,
    subject: Subject,
    checks: u32,
    passed: u32,
    blocked: bool,
}

impl ItemRun<'_> {
    fn rule(&mut self, id: &str, sev: Severity, ok: bool, msg: impl FnOnce() -> String) {
        let w = if sev == Severity::Blocker {
            BLOCKER_WEIGHT
        } else {
            WARNING_WEIGHT
        };
        self.checks += 1;
        self.run.total_w += w;
        if ok {
            self.passed += 1;
            self.run.passed_w += w;
        } else {
            self.blocked |= sev == Severity::Blocker;
            self.run.findings.push(Finding {
                rule: id.into(),
                severity: sev,
                subject: self.subject.clone(),
                message: msg(),
            });
        }
    }

    fn finish(self) {
        self.run.items.push(ItemReadiness {
            subject: self.subject,
            checks: self.checks,
            passed: self.passed,
            ready: !self.blocked,
        });
    }
}

fn has_acceptance_criteria(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("acceptance criteria")
        || lower.contains("acceptance:")
        || lower.contains("definition of done")
        || lower.contains("- [ ]")
        || lower.contains("- [x]")
}

/// Body without the traceability footer, for length checks.
fn body_without_footer(body: &str) -> &str {
    body.find("\n---\nGenerated by Nyx")
        .map_or(body, |i| &body[..i])
}

fn unresolved_markers(content: &str) -> usize {
    let words = content
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| {
            w.eq_ignore_ascii_case("todo")
                || w.eq_ignore_ascii_case("tbd")
                || w.eq_ignore_ascii_case("fixme")
        })
        .count();
    words + content.matches("???").count()
}

/// Assess whether the sprint can start.
///
/// Rules (id, severity):
/// - `sprint.not_empty` (blocker): at least one open ticket.
/// - `sprint.capacity_warning` / `sprint.capacity_blocker` (warning at the rounded
///   [`CAPACITY_THRESHOLD`] percent, blocker at `capacity_blocker_percent`): only evaluated when a
///   capacity is supplied.
/// - `ticket.title` (blocker): non-empty. `ticket.body_length` (blocker): body, minus the Nyx
///   footer, has at least `min_body_chars` characters. `ticket.acceptance_criteria` (warning).
///   `ticket.spec_linked` (warning): traceability footer or `document_id`.
///   `ticket.not_oversized` (warning): heuristic weight below `oversize_weight`.
///   `ticket.unique_title` (blocker): no earlier ticket in the sprint with the same (>= 0.8
///   similar) title.
/// - `spec.min_content` (blocker): the TS gate's content checks. `spec.stage_reached` (warning).
///   `spec.unresolved_markers` (warning): `TODO` / `TBD` / `FIXME` / `???`. `spec.quality`
///   (warning below 7, blocker below 4) when a score is supplied.
///
/// Done tickets are skipped. Specs are assessed once each.
#[must_use]
pub fn assess_readiness(
    tickets: &[TicketInput],
    specs: &[SpecInput],
    capacity: Option<&SprintCapacity>,
    cfg: &ReadinessConfig,
) -> ReadinessReport {
    let mut run = Run {
        passed_w: 0,
        total_w: 0,
        findings: Vec::new(),
        items: Vec::new(),
    };
    let open: Vec<&TicketInput> = tickets
        .iter()
        .filter(|t| t.status != SprintStatus::Done)
        .collect();

    // Sprint level.
    {
        let mut s = ItemRun {
            run: &mut run,
            subject: Subject::Sprint,
            checks: 0,
            passed: 0,
            blocked: false,
        };
        s.rule(
            "sprint.not_empty",
            Severity::Blocker,
            !open.is_empty(),
            || "The sprint has no open tickets".into(),
        );
        if let Some(c) = capacity {
            let pct = c.capacity_percent;
            s.rule(
                "sprint.capacity_warning",
                Severity::Warning,
                pct < CAPACITY_THRESHOLD,
                || format!("Sprint is at {pct}% of judgment bandwidth (threshold {CAPACITY_THRESHOLD}%)"),
            );
            s.rule(
                "sprint.capacity_blocker",
                Severity::Blocker,
                pct < cfg.capacity_blocker_percent,
                || format!("Sprint is at {pct}% of judgment bandwidth: defer work before starting"),
            );
        }
        s.finish();
    }

    // Tickets.
    let mut seen: Vec<&str> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    for t in &open {
        let mut r = ItemRun {
            run: &mut run,
            subject: Subject::Ticket(t.id.clone()),
            checks: 0,
            passed: 0,
            blocked: false,
        };
        let body = body_without_footer(&t.body).trim();
        r.rule(
            "ticket.title",
            Severity::Blocker,
            !t.title.trim().is_empty(),
            || "Ticket has no title".into(),
        );
        let blen = body.chars().count();
        r.rule(
            "ticket.body_length",
            Severity::Blocker,
            blen >= cfg.min_body_chars,
            || {
                format!(
                    "Description is too thin to implement from ({blen} of {} characters)",
                    cfg.min_body_chars
                )
            },
        );
        r.rule(
            "ticket.acceptance_criteria",
            Severity::Warning,
            has_acceptance_criteria(body),
            || "No acceptance criteria found".into(),
        );
        r.rule(
            "ticket.spec_linked",
            Severity::Warning,
            t.document_id.is_some() || parse_traceability(&t.body).is_some(),
            || "Ticket is not linked back to a spec".into(),
        );
        let w = estimate_decision_weight(&t.title, &t.labels);
        r.rule(
            "ticket.not_oversized",
            Severity::Warning,
            w < cfg.oversize_weight,
            || format!("Estimated decision weight {w} suggests splitting this ticket"),
        );
        let dup = !t.title.trim().is_empty()
            && (!seen_keys.insert(dedupe_key(&t.title))
                || seen
                    .iter()
                    .any(|s| title_similarity(s, &t.title) >= DUPLICATE_THRESHOLD));
        r.rule("ticket.unique_title", Severity::Blocker, !dup, || {
            format!("\"{}\" duplicates another ticket in the sprint", t.title)
        });
        seen.push(&t.title);
        r.finish();
    }

    // Specs.
    let required = cfg
        .stage_order
        .iter()
        .position(|s| *s == cfg.required_stage);
    for sp in specs {
        let mut r = ItemRun {
            run: &mut run,
            subject: Subject::Spec(sp.id.clone()),
            checks: 0,
            passed: 0,
            blocked: false,
        };
        let content_len = sp.content.trim().chars().count();
        r.rule(
            "spec.min_content",
            Severity::Blocker,
            content_len >= MIN_CONTENT_LENGTH,
            || {
                format!(
                    "\"{}\" has {content_len} characters; at least {MIN_CONTENT_LENGTH} are required",
                    sp.title
                )
            },
        );
        if let Some(req) = required {
            let reached = sp
                .stage
                .as_deref()
                .and_then(|s| cfg.stage_order.iter().position(|o| o == s))
                .is_some_and(|i| i >= req);
            r.rule("spec.stage_reached", Severity::Warning, reached, || {
                format!(
                    "\"{}\" is at stage {} but tickets should come from \"{}\"",
                    sp.title,
                    sp.stage.as_deref().unwrap_or("(none)"),
                    cfg.required_stage
                )
            });
        }
        let markers = unresolved_markers(&sp.content);
        r.rule(
            "spec.unresolved_markers",
            Severity::Warning,
            markers == 0,
            || {
                format!(
                    "\"{}\" still has {markers} unresolved TODO/TBD marker(s)",
                    sp.title
                )
            },
        );
        if let Some(q) = sp.quality_score {
            r.rule(
                "spec.quality",
                Severity::Blocker,
                q >= NEEDS_IMPROVEMENT_THRESHOLD,
                || {
                    format!(
                        "\"{}\" quality score {q:.1}/10 reports significant issues",
                        sp.title
                    )
                },
            );
            r.rule(
                "spec.quality_good",
                Severity::Warning,
                QualityBand::of(q) == QualityBand::Good,
                || format!("\"{}\" quality score {q:.1}/10 needs improvement", sp.title),
            );
        }
        r.finish();
    }

    let score = if run.total_w == 0 {
        0
    } else {
        #[allow(clippy::cast_sign_loss)]
        let p = ((f64::from(run.passed_w) / f64::from(run.total_w)) * 100.0).round() as u32;
        p
    };
    let (blockers, warnings): (Vec<_>, Vec<_>) = run
        .findings
        .into_iter()
        .partition(|f| f.severity == Severity::Blocker);
    ReadinessReport {
        score,
        ready: blockers.is_empty(),
        blockers,
        warnings,
        items: run.items,
    }
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use crate::tickets::sprint::{empty_sprint, SprintOrigin};

    const ORDER: [&str; 5] = DEFAULT_STAGE_ORDER;

    fn gate(content: &str, stage: Option<&str>, target: &str) -> GateResult {
        evaluate_stage_gate(content, stage, target, &ORDER)
    }

    fn long() -> String {
        "A".repeat(100)
    }

    fn check_of<'a>(r: &'a GateResult, name: &str) -> &'a GateCheck {
        r.checks.iter().find(|c| c.name == name).unwrap()
    }

    // ---- stage gate: ports of the vitest cases

    #[test]
    fn gate_passes_with_three_checks() {
        let r = gate(&long(), Some("conception"), "definition");
        assert!(r.passed);
        assert_eq!(r.checks.len(), 3);
        assert!(r.checks.iter().all(|c| c.passed && c.reason.is_none()));
    }

    #[test]
    fn gate_passes_sequentially_through_all_stages() {
        for w in ORDER.windows(2) {
            assert!(gate(&long(), Some(w[0]), w[1]).passed, "{w:?}");
        }
    }

    #[test]
    fn gate_empty_and_whitespace_content() {
        for c in ["", "   \n\t  "] {
            let r = gate(c, Some("conception"), "definition");
            assert!(!r.passed);
            let e = check_of(&r, "content_not_empty");
            assert!(!e.passed);
            assert_eq!(
                e.reason.as_deref(),
                Some("Document content must not be empty")
            );
        }
    }

    #[test]
    fn gate_min_length_boundary() {
        let r = gate(&"A".repeat(50), Some("conception"), "definition");
        let l = check_of(&r, "minimum_content_length");
        assert!(!l.passed);
        let reason = l.reason.as_deref().unwrap();
        assert!(reason.contains("at least 100 characters") && reason.contains("currently 50"));
        assert!(
            check_of(
                &gate(&"X".repeat(100), Some("conception"), "definition"),
                "minimum_content_length"
            )
            .passed
        );
        assert!(
            !check_of(
                &gate(&"X".repeat(99), Some("conception"), "definition"),
                "minimum_content_length"
            )
            .passed
        );
        // Length is of the trimmed content, in characters.
        let padded = format!("  {}  ", "é".repeat(100));
        assert!(gate(&padded, None, "conception").passed);
        let padded = format!("  {}  ", "é".repeat(99));
        assert!(!gate(&padded, None, "conception").passed);
    }

    #[test]
    fn gate_backward_same_skip_unknown() {
        let r = gate(&long(), Some("architecture"), "definition");
        assert!(check_of(&r, "valid_stage_transition")
            .reason
            .as_deref()
            .unwrap()
            .contains("Cannot move backward"));
        let r = gate(&long(), Some("definition"), "definition");
        assert!(check_of(&r, "valid_stage_transition")
            .reason
            .as_deref()
            .unwrap()
            .contains("Cannot move backward"));
        let r = gate(&long(), Some("conception"), "architecture");
        let reason = check_of(&r, "valid_stage_transition")
            .reason
            .clone()
            .unwrap();
        assert!(
            reason.contains("Cannot skip stages")
                && reason.contains("\"definition\", not \"architecture\"")
        );
        let r = gate(&long(), Some("conception"), "nonexistent");
        assert!(check_of(&r, "valid_stage_transition")
            .reason
            .as_deref()
            .unwrap()
            .contains("not a recognized stage"));
    }

    #[test]
    fn gate_null_and_unknown_current_stage() {
        assert!(gate(&long(), None, "conception").passed);
        assert!(gate(&long(), None, "execution").passed);
        assert!(gate(&long(), Some("legacy-stage"), "execution").passed);
        assert!(gate(&long(), Some(""), "definition").passed); // "" is not null in TS, but unknown
        assert!(!gate(&long(), None, "nonexistent").passed);
        // Unrecognised target wins over an unknown current stage.
        assert!(!gate(&long(), Some("legacy-stage"), "nonexistent").passed);
    }

    #[test]
    fn gate_custom_stage_order_and_multiple_failures() {
        let custom = ["idea", "build", "ship"];
        assert!(evaluate_stage_gate(&long(), Some("idea"), "build", &custom).passed);
        let r = evaluate_stage_gate("", Some("idea"), "ship", &custom);
        assert_eq!(r.checks.iter().filter(|c| !c.passed).count(), 3);
        assert!(check_of(&r, "valid_stage_transition")
            .reason
            .as_deref()
            .unwrap()
            .contains("\"build\""));
        // Check order is fixed.
        let names: Vec<_> = r.checks.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "content_not_empty",
                "minimum_content_length",
                "valid_stage_transition"
            ]
        );
        // Empty order: nothing is recognised.
        assert!(!evaluate_stage_gate(&long(), None, "idea", &[]).passed);
    }

    #[test]
    fn gate_json_shape_matches_ts() {
        let v = serde_json::to_value(gate(&long(), None, "conception")).unwrap();
        assert_eq!(v["passed"], true);
        assert!(v["checks"][0].get("reason").is_none());
    }

    // ---- readiness rule matrix

    fn ticket(id: &str, title: &str, body: &str) -> TicketInput {
        TicketInput {
            id: id.into(),
            title: title.into(),
            body: body.into(),
            labels: vec![],
            status: SprintStatus::Todo,
            document_id: Some("doc-1".into()),
        }
    }

    const GOOD_BODY: &str = "Implement the login endpoint with session cookies.\n\n## Acceptance criteria\n- [ ] returns 200";

    fn spec(id: &str, content: &str, stage: Option<&str>, q: Option<f64>) -> SpecInput {
        SpecInput {
            id: id.into(),
            title: "Auth spec".into(),
            content: content.into(),
            stage: stage.map(str::to_owned),
            quality_score: q,
        }
    }

    fn rules(r: &ReadinessReport) -> Vec<String> {
        r.blockers
            .iter()
            .chain(&r.warnings)
            .map(|f| f.rule.clone())
            .collect()
    }

    fn assess(t: &[TicketInput], s: &[SpecInput]) -> ReadinessReport {
        assess_readiness(t, s, None, &ReadinessConfig::default())
    }

    #[test]
    fn clean_sprint_is_ready_with_full_score() {
        let r = assess(
            &[ticket("T1", "Add login", GOOD_BODY)],
            &[spec("doc-1", &long(), Some("implementation"), Some(8.0))],
        );
        assert!(
            r.ready && r.blockers.is_empty() && r.warnings.is_empty(),
            "{r:?}"
        );
        assert_eq!(r.score, 100);
        assert_eq!(r.items.len(), 3); // sprint + ticket + spec
        assert!(r.items.iter().all(|i| i.ready && i.passed == i.checks));
    }

    #[test]
    fn empty_sprint_is_a_blocker_and_done_tickets_do_not_count() {
        let r = assess(&[], &[]);
        assert!(!r.ready);
        assert_eq!(rules(&r), ["sprint.not_empty"]);
        assert_eq!(r.score, 0);
        let mut done = ticket("T1", "Shipped", "");
        done.status = SprintStatus::Done;
        let r = assess(&[done], &[]);
        assert_eq!(rules(&r), ["sprint.not_empty"]);
    }

    #[test]
    fn ticket_rule_matrix() {
        let mut t = ticket("T1", "  ", "short");
        t.document_id = None;
        let r = assess(&[t], &[]);
        let mut got = rules(&r);
        got.sort();
        assert_eq!(
            got,
            [
                "ticket.acceptance_criteria",
                "ticket.body_length",
                "ticket.spec_linked",
                "ticket.title"
            ]
        );
        assert!(!r.ready);

        // Traceability footer counts as a link; acceptance criteria variants all count.
        let body = format!(
            "{GOOD_BODY}\n\n---\nGenerated by Nyx from \"S\" (nyx://document/d1)\nnyx-ref:doc=d1;draft=x1"
        );
        let mut t = ticket("T2", "Add login", &body);
        t.document_id = None;
        assert!(assess(&[t], &[]).warnings.is_empty());
        for ok in [
            "Definition of Done: x",
            "ACCEPTANCE: x",
            "- [x] done item",
            "Acceptance Criteria",
        ] {
            assert!(has_acceptance_criteria(ok), "{ok}");
        }
        assert!(!has_acceptance_criteria("just prose"));

        // The footer does not count toward body length.
        let footer_only =
            "x\n\n---\nGenerated by Nyx from \"S\" (nyx://document/d1)\nnyx-ref:doc=d1;draft=x1";
        let r = assess(&[ticket("T3", "Short", footer_only)], &[]);
        assert!(rules(&r).contains(&"ticket.body_length".to_string()));
    }

    #[test]
    fn oversize_and_duplicate_rules() {
        let mut big = ticket("T1", "Breaking migration of API endpoint", GOOD_BODY);
        big.labels = vec!["security".into(), "feature".into()];
        let r = assess(&[big], &[]);
        assert_eq!(rules(&r), ["ticket.not_oversized"]);
        assert!(r.ready); // warning only

        let r = assess(
            &[
                ticket("T1", "Add OAuth login flow", GOOD_BODY),
                ticket("T2", "[M] add oauth LOGIN flow", GOOD_BODY),
                ticket("T3", "Add OAuth login flow now", GOOD_BODY), // 4/5 words = 0.8
                ticket("T4", "Totally different", GOOD_BODY),
            ],
            &[],
        );
        let dups: Vec<_> = r
            .blockers
            .iter()
            .filter(|f| f.rule == "ticket.unique_title")
            .map(|f| f.subject.clone())
            .collect();
        assert_eq!(
            dups,
            [Subject::Ticket("T2".into()), Subject::Ticket("T3".into())]
        );
        assert!(!r.ready);
    }

    #[test]
    fn spec_rule_matrix() {
        let r = assess(
            &[ticket("T1", "Add login", GOOD_BODY)],
            &[spec("s1", "tiny", Some("conception"), Some(2.0))],
        );
        let mut got = rules(&r);
        got.sort();
        assert_eq!(
            got,
            [
                "spec.min_content",
                "spec.quality",
                "spec.quality_good",
                "spec.stage_reached"
            ]
        );
        // Quality bands: 4.0 is needs-improvement (warning only), 7.0 is good.
        let ok = |q| {
            assess(
                &[ticket("T1", "Add login", GOOD_BODY)],
                &[spec("s", &long(), Some("execution"), Some(q))],
            )
        };
        assert_eq!(rules(&ok(4.0)), ["spec.quality_good"]);
        assert!(ok(4.0).ready);
        assert!(ok(7.0).warnings.is_empty());
        assert!(!ok(3.99).ready);
        // No score supplied -> no quality rules.
        let r = assess(
            &[ticket("T1", "Add login", GOOD_BODY)],
            &[spec("s", &long(), Some("implementation"), None)],
        );
        assert!(r.warnings.is_empty());
        // Unknown / missing stage is "not reached".
        for st in [None, Some("legacy")] {
            let r = assess(
                &[ticket("T1", "Add login", GOOD_BODY)],
                &[spec("s", &long(), st, None)],
            );
            assert_eq!(rules(&r), ["spec.stage_reached"]);
        }
        // Markers.
        let content = format!("{} TODO: decide. TBD. fixme later ???", long());
        let r = assess(
            &[ticket("T1", "Add login", GOOD_BODY)],
            &[spec("s", &content, Some("execution"), None)],
        );
        assert_eq!(rules(&r), ["spec.unresolved_markers"]);
        assert!(r.warnings[0].message.contains("4 unresolved"));
        // Words merely containing markers do not count.
        assert_eq!(unresolved_markers("mastodon todos tbdx"), 0);
    }

    #[test]
    fn capacity_rules_warn_then_block() {
        let mut c = empty_sprint();
        c.source = SprintOrigin::Github;
        let t = [ticket("T1", "Add login", GOOD_BODY)];
        let mut run = |pct: u32| {
            c.capacity_percent = pct;
            assess_readiness(&t, &[], Some(&c), &ReadinessConfig::default())
        };
        assert!(rules(&run(79)).is_empty());
        let r = run(80);
        assert_eq!(rules(&r), ["sprint.capacity_warning"]);
        assert!(r.ready);
        let r = run(99);
        assert!(r.ready);
        let r = run(100);
        assert!(!r.ready);
        assert_eq!(
            rules(&r),
            ["sprint.capacity_blocker", "sprint.capacity_warning"]
        );
    }

    #[test]
    fn score_is_weighted_and_monotonic() {
        let clean = assess(&[ticket("T1", "Add login", GOOD_BODY)], &[]);
        let warn = {
            let mut t = ticket("T1", "Add login", GOOD_BODY);
            t.document_id = None;
            assess(&[t], &[])
        };
        let block = assess(&[ticket("T1", "Add login", "short")], &[]);
        assert_eq!(clean.score, 100);
        assert!(clean.score > warn.score && warn.score > block.score);
        // Exact numbers: sprint(3) + ticket: title 3, body 3, ac 1, linked 1, size 1, unique 3 = 15.
        assert_eq!(warn.score, 93); // 14/15
        assert_eq!(block.score, 73); // body_length (3) + acceptance (1) failed -> 11/15
    }
}
