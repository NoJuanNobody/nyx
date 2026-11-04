//! Sprint capacity in **decision weight** (the human judgment cost of reviewing and integrating
//! work), not story points. Port of `sprint.service.ts` (issue #145 rationale).
//!
//! The pure parts (status normalisation, weight heuristic, capacity maths, trade-off
//! suggestions, defer bookkeeping) are ported one to one. Fetching the sprint is behind
//! [`SprintSource`]; [`JiraSprintSource`](super::jira::JiraSprintSource) and
//! [`LinearSprintSource`](super::linear::LinearSprintSource) are provided, the GitHub Projects v2
//! GraphQL source is not (it is not part of [`crate::git_provider::GitProvider`]; TODO for the
//! wiring wave, see `docs/rust-core/tickets.md`).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::tracker::TrackerError;

/// Decision weight the team can absorb per sprint (TS `DEFAULT_TOTAL_WEIGHT`).
pub const DEFAULT_TOTAL_WEIGHT: u32 = 200;
/// Capacity percentage at or above which a sprint counts as over threshold.
pub const CAPACITY_THRESHOLD: u32 = 80;
/// Weight per legacy story point when only `newTicketPoints` is supplied.
pub const WEIGHT_PER_POINT: u32 = 5;

/// Normalised ticket status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SprintStatus {
    /// Not started (Todo, Backlog, New, Triage, ...).
    Todo,
    /// In progress / in review.
    InProgress,
    /// Done.
    Done,
}

/// Where the sprint data came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SprintOrigin {
    /// GitHub Projects v2.
    Github,
    /// Jira.
    Jira,
    /// Linear.
    Linear,
    /// No integration connected.
    None,
}

/// GitHub Projects status column -> status. Empty / unknown -> todo.
#[must_use]
pub fn normalize_status(raw: Option<&str>) -> SprintStatus {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return SprintStatus::Todo;
    };
    match raw.to_lowercase().as_str() {
        "done" | "closed" | "merged" | "complete" => SprintStatus::Done,
        "in progress" | "in review" | "active" => SprintStatus::InProgress,
        _ => SprintStatus::Todo,
    }
}

/// Jira status name -> status (`normalizeJiraStatus`).
#[must_use]
pub fn normalize_jira_status(name: &str) -> SprintStatus {
    match name.to_lowercase().as_str() {
        "done" | "closed" | "resolved" => SprintStatus::Done,
        "in progress" | "in review" => SprintStatus::InProgress,
        _ => SprintStatus::Todo,
    }
}

/// Heuristic decision weight from labels and title when no explicit weight exists
/// (`estimateDecisionWeight`): baseline 15, label and title adjustments, clamped to 5..=80.
#[must_use]
pub fn estimate_decision_weight(title: &str, labels: &[String]) -> u32 {
    let mut w: i32 = 15;
    for label in labels {
        let l = label.to_lowercase();
        if l.contains("bug") || l.contains("fix") {
            w += 5;
        }
        if l.contains("feature") || l.contains("enhancement") {
            w += 12;
        }
        if l.contains("security") || l.contains("auth") {
            w += 15;
        }
        if l.contains("refactor") || l.contains("chore") {
            w -= 5;
        }
        if l.contains("docs") || l.contains("documentation") {
            w -= 8;
        }
        if l.contains("critical") || l.contains("urgent") {
            w += 10;
        }
        if l.contains("good first issue") || l.contains("easy") {
            w -= 10;
        }
    }
    let t = title.to_lowercase();
    if t.contains("migration") || t.contains("breaking") {
        w += 15;
    }
    if t.contains("api") || t.contains("endpoint") {
        w += 5;
    }
    if t.contains("test") || t.contains("e2e") {
        w += 3;
    }
    u32::try_from(w.clamp(5, 80)).unwrap_or(5)
}

/// Expected review cycles for a weight: >= 40 -> 3, >= 25 -> 2, else 1.
#[must_use]
pub fn estimate_review_cycles(weight: u32) -> u32 {
    if weight >= 40 {
        3
    } else if weight >= 25 {
        2
    } else {
        1
    }
}

/// A raw sprint item as a source reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SprintItem {
    /// Display id (`#12`, `PROJ-7`, `ENG-3`); also the defer key.
    pub key: String,
    /// Title.
    pub title: String,
    /// Labels (Jira items carry none, as in TS).
    pub labels: Vec<String>,
    /// Normalised status.
    pub status: SprintStatus,
}

/// Fetched sprint before capacity maths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SprintSnapshot {
    /// Sprint / project / board name.
    pub name: String,
    /// Items.
    pub items: Vec<SprintItem>,
    /// Which system it came from.
    pub origin: SprintOrigin,
}

/// A ticket in the sprint with its estimated cost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SprintTicket {
    /// Display id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Legacy points (always 1, not used for gating).
    pub points: u32,
    /// Estimated decision weight (5..=80).
    pub decision_weight: u32,
    /// Estimated review cycles.
    pub review_cycles: u32,
    /// Status.
    pub status: SprintStatus,
}

/// Sprint capacity (`SprintCapacity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SprintCapacity {
    /// Name.
    pub sprint_name: String,
    /// Weight the team can absorb.
    pub total_weight: u32,
    /// Sum of ticket weights.
    pub used_weight: u32,
    /// `round(used / total * 100)`.
    pub capacity_percent: u32,
    /// Ticket count (TS reports `tickets.length` here).
    pub total_points: u32,
    /// Sum of points.
    pub used_points: u32,
    /// Tickets.
    pub tickets: Vec<SprintTicket>,
    /// Source.
    pub source: SprintOrigin,
}

/// Result of [`SprintBoard::check`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SprintCheck {
    /// Current capacity.
    pub capacity: SprintCapacity,
    /// Whether the projection (with the new ticket) is at or over [`CAPACITY_THRESHOLD`].
    pub over_threshold: bool,
    /// Trade-off suggestions when over threshold.
    pub suggestions: Vec<String>,
}

/// The empty sprint returned when no integration is connected.
#[must_use]
pub fn empty_sprint() -> SprintCapacity {
    SprintCapacity {
        sprint_name: "No Sprint".into(),
        total_weight: DEFAULT_TOTAL_WEIGHT,
        used_weight: 0,
        capacity_percent: 0,
        total_points: 0,
        used_points: 0,
        tickets: Vec::new(),
        source: SprintOrigin::None,
    }
}

fn percent(used: u32, total: u32) -> u32 {
    if total == 0 {
        return if used == 0 { 0 } else { 100 };
    }
    // JS Math.round on a non-negative value = round half up.
    #[allow(clippy::cast_sign_loss)]
    let p = (f64::from(used) / f64::from(total) * 100.0).round() as u32;
    p
}

/// Something that can list the current sprint.
pub trait SprintSource {
    /// Which system.
    fn origin(&self) -> SprintOrigin;

    /// The current sprint, or `None` when this source has nothing (not connected, no project).
    ///
    /// # Errors
    /// Transport / auth failures. [`SprintBoard::capacity`] logs-and-skips them like the TS
    /// service (which fell through to the next source).
    fn fetch(&self) -> Result<Option<SprintSnapshot>, TrackerError>;

    /// Move an item to the backlog in the source system (best effort). Default: nothing to do.
    ///
    /// # Errors
    /// Transport / auth failures; [`SprintBoard::defer`] ignores them (local defer still holds).
    fn move_to_backlog(&self, key: &str) -> Result<(), TrackerError> {
        let _ = key;
        Ok(())
    }
}

/// In-memory source for tests and manual boards.
#[derive(Debug, Clone)]
pub struct StaticSprintSource(pub Option<SprintSnapshot>);

impl SprintSource for StaticSprintSource {
    fn origin(&self) -> SprintOrigin {
        self.0.as_ref().map_or(SprintOrigin::None, |s| s.origin)
    }
    fn fetch(&self) -> Result<Option<SprintSnapshot>, TrackerError> {
        Ok(self.0.clone())
    }
}

/// Deferral state plus the capacity logic. The deferred set is process-local in TS (lost on
/// restart); here it serialises, so the wiring layer can persist it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SprintBoard {
    deferred: BTreeSet<String>,
}

/// Result of [`SprintBoard::defer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferOutcome {
    /// Always true (local defer cannot fail).
    pub deferred: bool,
    /// The source system also moved the item to its backlog.
    pub moved_remotely: bool,
}

impl SprintBoard {
    /// Empty board.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Keys currently deferred.
    pub fn deferred(&self) -> impl Iterator<Item = &str> {
        self.deferred.iter().map(String::as_str)
    }

    /// Capacity from a snapshot: deferred items are dropped, weights estimated.
    #[must_use]
    pub fn capacity_of(&self, snap: &SprintSnapshot) -> SprintCapacity {
        let tickets: Vec<SprintTicket> = snap
            .items
            .iter()
            .filter(|i| !self.deferred.contains(&i.key))
            .map(|i| {
                let w = estimate_decision_weight(&i.title, &i.labels);
                SprintTicket {
                    id: i.key.clone(),
                    title: i.title.clone(),
                    points: 1,
                    decision_weight: w,
                    review_cycles: estimate_review_cycles(w),
                    status: i.status,
                }
            })
            .collect();
        let used_weight = tickets.iter().map(|t| t.decision_weight).sum();
        let used_points = tickets.iter().map(|t| t.points).sum();
        SprintCapacity {
            sprint_name: snap.name.clone(),
            total_weight: DEFAULT_TOTAL_WEIGHT,
            used_weight,
            capacity_percent: percent(used_weight, DEFAULT_TOTAL_WEIGHT),
            total_points: u32::try_from(tickets.len()).unwrap_or(u32::MAX),
            used_points,
            tickets,
            source: snap.origin,
        }
    }

    /// Capacity from the first source that yields a sprint (sources are tried in order; a source
    /// that errors or has nothing is skipped), else the empty sprint.
    #[must_use]
    pub fn capacity(&self, sources: &[&dyn SprintSource]) -> SprintCapacity {
        for s in sources {
            if let Ok(Some(snap)) = s.fetch() {
                return self.capacity_of(&snap);
            }
        }
        empty_sprint()
    }

    /// Project adding a ticket and suggest what to defer when the result is at or over the
    /// threshold. `new_weight` wins over `new_points` (points count [`WEIGHT_PER_POINT`] each;
    /// 0 points is 0 weight).
    #[must_use]
    pub fn check_capacity(
        capacity: SprintCapacity,
        new_points: Option<u32>,
        new_weight: Option<u32>,
    ) -> SprintCheck {
        let added = new_weight.unwrap_or_else(|| new_points.unwrap_or(0) * WEIGHT_PER_POINT);
        let projected = capacity.used_weight + added;
        let over = percent(projected, capacity.total_weight) >= CAPACITY_THRESHOLD;
        let mut suggestions = Vec::new();
        if over {
            let mut todo: Vec<&SprintTicket> = capacity
                .tickets
                .iter()
                .filter(|t| t.status == SprintStatus::Todo)
                .collect();
            todo.sort_by_key(|t| std::cmp::Reverse(t.decision_weight)); // stable, like JS sort
            for t in todo {
                suggestions.push(format!(
                    "Defer \"{}\" ({}, weight {}, ~{} review cycles) to free judgment bandwidth",
                    t.title, t.id, t.decision_weight, t.review_cycles
                ));
            }
            if suggestions.is_empty() {
                suggestions.push(
                    "All current tickets are in progress. The team's review bandwidth is saturated — adding more work will degrade review quality."
                        .into(),
                );
            }
        }
        SprintCheck {
            capacity,
            over_threshold: over,
            suggestions,
        }
    }

    /// [`Self::capacity`] then [`Self::check_capacity`].
    #[must_use]
    pub fn check(
        &self,
        sources: &[&dyn SprintSource],
        new_points: Option<u32>,
        new_weight: Option<u32>,
    ) -> SprintCheck {
        Self::check_capacity(self.capacity(sources), new_points, new_weight)
    }

    /// Defer a ticket. Idempotent. When `source` is given the item is also moved to its backlog;
    /// a failure there is ignored (non-fatal in TS).
    pub fn defer(&mut self, key: &str, source: Option<&dyn SprintSource>) -> DeferOutcome {
        self.deferred.insert(key.to_owned());
        let moved_remotely = source.is_some_and(|s| s.move_to_backlog(key).is_ok());
        DeferOutcome {
            deferred: true,
            moved_remotely,
        }
    }

    /// Un-defer tickets for the next sprint; returns the keys as given (TS echoes them even if
    /// they were not deferred).
    pub fn schedule_next(&mut self, keys: &[String]) -> Vec<String> {
        for k in keys {
            self.deferred.remove(k);
        }
        keys.to_vec()
    }
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;

    fn item(key: &str, title: &str, labels: &[&str], status: SprintStatus) -> SprintItem {
        SprintItem {
            key: key.into(),
            title: title.into(),
            labels: labels.iter().map(|s| (*s).to_owned()).collect(),
            status,
        }
    }

    fn snap(items: Vec<SprintItem>) -> SprintSnapshot {
        SprintSnapshot {
            name: "Sprint 1".into(),
            items,
            origin: SprintOrigin::Github,
        }
    }

    #[test]
    fn status_normalisation() {
        for (raw, want) in [
            (Some("Done"), SprintStatus::Done),
            (Some("MERGED"), SprintStatus::Done),
            (Some("complete"), SprintStatus::Done),
            (Some("Closed"), SprintStatus::Done),
            (Some("In Progress"), SprintStatus::InProgress),
            (Some("in review"), SprintStatus::InProgress),
            (Some("Active"), SprintStatus::InProgress),
            (Some("Backlog"), SprintStatus::Todo),
            (Some("Triage"), SprintStatus::Todo),
            (Some(""), SprintStatus::Todo),
            (None, SprintStatus::Todo),
        ] {
            assert_eq!(normalize_status(raw), want, "{raw:?}");
        }
        assert_eq!(normalize_jira_status("Resolved"), SprintStatus::Done);
        assert_eq!(normalize_jira_status("In Review"), SprintStatus::InProgress);
        // Jira does not treat "merged"/"active" specially.
        assert_eq!(normalize_jira_status("Active"), SprintStatus::Todo);
        assert_eq!(normalize_jira_status("To Do"), SprintStatus::Todo);
    }

    #[test]
    fn weight_heuristic_and_clamps() {
        let l = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(estimate_decision_weight("Plain", &[]), 15);
        assert_eq!(estimate_decision_weight("Plain", &l(&["bug"])), 20);
        assert_eq!(
            estimate_decision_weight("Plain", &l(&["Feature", "security"])),
            42
        );
        assert_eq!(estimate_decision_weight("Plain", &l(&["docs"])), 7);
        assert_eq!(estimate_decision_weight("Plain", &l(&["chore", "docs"])), 5); // 15-5-8=2 -> clamp to 5
        assert_eq!(
            estimate_decision_weight("Plain", &l(&["docs", "easy", "chore"])),
            5
        );
        assert_eq!(
            estimate_decision_weight("Breaking migration API test", &[]),
            38
        );
        assert_eq!(
            estimate_decision_weight(
                "Breaking migration API",
                &l(&["feature", "security", "critical", "auth"])
            ),
            80 // 15+12+15+10+15+15+5 = 87 -> clamp
        );
        // Substring semantics: "prefix" contains "fix".
        assert_eq!(estimate_decision_weight("x", &l(&["prefix"])), 20);
        // One label can hit several rules.
        assert_eq!(
            estimate_decision_weight("x", &l(&["authentication bug"])),
            35
        );
        assert_eq!(estimate_review_cycles(39), 2);
        assert_eq!(estimate_review_cycles(40), 3);
        assert_eq!(estimate_review_cycles(25), 2);
        assert_eq!(estimate_review_cycles(24), 1);
    }

    #[test]
    fn empty_when_no_source_has_data() {
        let board = SprintBoard::new();
        let none = StaticSprintSource(None);
        let c = board.capacity(&[&none]);
        assert_eq!(c, empty_sprint());
        assert_eq!(c.source, SprintOrigin::None);
        assert_eq!(c.sprint_name, "No Sprint");
        assert_eq!(board.capacity(&[]), empty_sprint());
        let chk = board.check(&[], None, None);
        assert!(!chk.over_threshold && chk.suggestions.is_empty());
    }

    #[test]
    fn first_working_source_wins_and_errors_fall_through() {
        struct Broken;
        impl SprintSource for Broken {
            fn origin(&self) -> SprintOrigin {
                SprintOrigin::Github
            }
            fn fetch(&self) -> Result<Option<SprintSnapshot>, TrackerError> {
                Err(TrackerError::Transport("down".into()))
            }
        }
        let jira = StaticSprintSource(Some(SprintSnapshot {
            name: "PROJ Sprint".into(),
            items: vec![item("PROJ-1", "A", &[], SprintStatus::Todo)],
            origin: SprintOrigin::Jira,
        }));
        let c = SprintBoard::new().capacity(&[&Broken, &jira]);
        assert_eq!(c.source, SprintOrigin::Jira);
        assert_eq!(c.tickets.len(), 1);
    }

    #[test]
    fn capacity_percent_rounds_half_up() {
        let board = SprintBoard::new();
        // 5 tickets of weight 15 = 75 -> 37.5% -> 38 (JS Math.round).
        let items = (0..5)
            .map(|i| item(&format!("#{i}"), "t", &[], SprintStatus::Todo))
            .collect();
        let c = board.capacity_of(&snap(items));
        assert_eq!((c.used_weight, c.capacity_percent), (75, 38));
        assert_eq!((c.total_points, c.used_points), (5, 5));
    }

    #[test]
    fn check_threshold_boundaries_and_projection() {
        // 160 of 200 = exactly 80% -> over (>=).
        let mut c = empty_sprint();
        c.used_weight = 158; // 79%
        assert!(!SprintBoard::check_capacity(c.clone(), None, None).over_threshold);
        assert!(SprintBoard::check_capacity(c.clone(), None, Some(2)).over_threshold); // 160 = 80%
                                                                                       // The threshold applies to the ROUNDED percentage: 159/200 = 79.5% -> 80 -> over.
        c.used_weight = 159;
        assert_eq!(percent(159, 200), 80);
        assert!(SprintBoard::check_capacity(c.clone(), Some(0), None).over_threshold);
        // newTicketWeight wins over points; points count 5 each; 0 points = 0 weight.
        c.used_weight = 100;
        assert!(!SprintBoard::check_capacity(c.clone(), Some(100), Some(10)).over_threshold);
        assert!(SprintBoard::check_capacity(c.clone(), Some(12), None).over_threshold); // 100+60
        assert!(!SprintBoard::check_capacity(c.clone(), Some(11), None).over_threshold); // 155 -> 78%
        assert!(SprintBoard::check_capacity(c, Some(0), Some(60)).over_threshold);
        // Zero-capacity guard (TS would produce NaN/Infinity).
        let mut z = empty_sprint();
        z.total_weight = 0;
        assert!(!SprintBoard::check_capacity(z.clone(), None, None).over_threshold);
        assert!(SprintBoard::check_capacity(z, None, Some(1)).over_threshold);
    }

    #[test]
    fn suggestions_defer_heaviest_todo_first_and_saturation_message() {
        let board = SprintBoard::new();
        let items = vec![
            item("#1", "Small", &["docs"], SprintStatus::Todo), // 7
            item("#2", "Big migration", &["security"], SprintStatus::Todo), // 45
            item("#3", "Tie a", &[], SprintStatus::Todo),       // 15
            item("#4", "Tie b", &[], SprintStatus::Todo),       // 15
            item("#5", "Doing", &["feature"], SprintStatus::InProgress), // 27
            item("#6", "Shipped", &["feature"], SprintStatus::Done),
        ];
        let c = board.capacity_of(&snap(items));
        let chk = SprintBoard::check_capacity(c, None, Some(200));
        assert!(chk.over_threshold);
        assert_eq!(chk.suggestions.len(), 4); // todo only
        assert!(chk.suggestions[0]
            .starts_with("Defer \"Big migration\" (#2, weight 45, ~3 review cycles)"));
        // Stable on ties: Tie a before Tie b.
        assert!(chk.suggestions[1].contains("Tie a") && chk.suggestions[2].contains("Tie b"));
        assert!(chk.suggestions[3].contains("Small"));

        let busy = board.capacity_of(&snap(vec![item(
            "#1",
            "Doing",
            &[],
            SprintStatus::InProgress,
        )]));
        let chk = SprintBoard::check_capacity(busy, None, Some(190));
        assert_eq!(chk.suggestions.len(), 1);
        assert!(chk.suggestions[0].contains("review bandwidth is saturated"));
    }

    #[test]
    fn defer_is_idempotent_filters_capacity_and_schedule_restores() {
        let mut board = SprintBoard::new();
        let s = snap(vec![
            item("#1", "One", &[], SprintStatus::Todo),
            item("#2", "Two", &[], SprintStatus::Todo),
        ]);
        assert_eq!(board.capacity_of(&s).tickets.len(), 2);
        assert_eq!(
            board.defer("#1", None),
            DeferOutcome {
                deferred: true,
                moved_remotely: false
            }
        );
        board.defer("#1", None);
        assert_eq!(board.deferred().count(), 1);
        assert_eq!(board.capacity_of(&s).tickets.len(), 1);
        // Remote move: success and (ignored) failure.
        struct Mover(bool);
        impl SprintSource for Mover {
            fn origin(&self) -> SprintOrigin {
                SprintOrigin::Github
            }
            fn fetch(&self) -> Result<Option<SprintSnapshot>, TrackerError> {
                Ok(None)
            }
            fn move_to_backlog(&self, _k: &str) -> Result<(), TrackerError> {
                if self.0 {
                    Ok(())
                } else {
                    Err(TrackerError::Transport("x".into()))
                }
            }
        }
        assert!(board.defer("#2", Some(&Mover(true))).moved_remotely);
        let o = board.defer("#2", Some(&Mover(false)));
        assert!(o.deferred && !o.moved_remotely);
        // Unknown keys are echoed back like the TS service.
        let back = board.schedule_next(&["#1".to_string(), "#99".to_string()]);
        assert_eq!(back, ["#1", "#99"]);
        assert_eq!(board.capacity_of(&s).tickets.len(), 1); // #2 still deferred
                                                            // Serialises for persistence.
        let j = serde_json::to_string(&board).unwrap();
        assert_eq!(serde_json::from_str::<SprintBoard>(&j).unwrap(), board);
    }

    #[test]
    fn capacity_json_matches_ts_field_names() {
        let c = SprintBoard::new().capacity_of(&snap(vec![item(
            "#1",
            "T",
            &[],
            SprintStatus::InProgress,
        )]));
        let v = serde_json::to_value(&c).unwrap();
        for k in [
            "sprintName",
            "totalWeight",
            "usedWeight",
            "capacityPercent",
            "totalPoints",
            "usedPoints",
            "tickets",
            "source",
        ] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(v["tickets"][0]["decisionWeight"], 15);
        assert_eq!(v["tickets"][0]["status"], "in_progress");
        assert_eq!(v["source"], "github");
    }
}
