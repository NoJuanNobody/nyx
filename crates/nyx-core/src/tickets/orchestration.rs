//! Step sequencing and document locks for multi-step workflows.
//!
//! Port of the non-agent half of `orchestration.service.ts`: pipelines made of steps with
//! dependencies, a claim / complete / fail protocol, per-document exclusive locks with a TTL, and
//! a shared key/value state. The "session" that claims a step is just an opaque claimant string
//! here (it was an agent session in TS); nothing in this module knows about agents, so it also
//! serves as the lock + sequencing layer for CLI / MCP callers that drive Nyx from outside.
//!
//! State is in memory, as in TS. Time is explicit (`*_at` methods take unix ms) so expiry is
//! testable; the plain methods use the wall clock.
//!
//! Divergence: TS `createPipeline` stored `dependsOn` verbatim, which made in-pipeline
//! dependencies impossible to express (step ids are generated). Here an entry of `depends_on`
//! that matches the *name* of a step in the same pipeline is resolved to that step's id; anything
//! else is kept verbatim (so the TS behaviour of dangling ids that never complete is preserved).

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{new_id, now_ms};

/// Lock lifetime (TS: 5 minutes).
pub const LOCK_TTL_MS: i64 = 5 * 60 * 1000;

/// Pipeline state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineStatus {
    /// Nothing claimed yet.
    Pending,
    /// At least one step was claimed.
    Running,
    /// Every step completed or was skipped.
    Completed,
    /// A step failed.
    Failed,
}

/// Step state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// Waiting to be claimed.
    Pending,
    /// Reserved (unused by the claim protocol, kept for parity with the TS enum).
    Locked,
    /// Claimed.
    Running,
    /// Done.
    Completed,
    /// Failed.
    Failed,
    /// Skipped.
    Skipped,
}

impl StepStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Locked => "locked",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

/// Input step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepSpec {
    /// Name.
    pub name: String,
    /// Workflow to run.
    pub workflow_id: String,
    /// Dependencies: names of earlier steps in this pipeline, or raw step ids.
    pub depends_on: Vec<String>,
}

impl StepSpec {
    /// Step without dependencies.
    #[must_use]
    pub fn new(name: &str, workflow_id: &str) -> Self {
        Self {
            name: name.into(),
            workflow_id: workflow_id.into(),
            depends_on: Vec::new(),
        }
    }

    /// Add a dependency.
    #[must_use]
    pub fn after(mut self, dep: &str) -> Self {
        self.depends_on.push(dep.into());
        self
    }
}

/// A step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Workflow.
    pub workflow_id: String,
    /// State.
    pub status: StepStatus,
    /// Claimant while running.
    pub assigned_session_id: Option<String>,
    /// Step ids that must be completed first.
    pub depends_on: Vec<String>,
    /// Output (or `{"error": ...}` on failure).
    pub output: Option<Value>,
    /// When claimed (unix ms).
    pub locked_at: Option<i64>,
    /// When completed / failed (unix ms).
    pub completed_at: Option<i64>,
}

/// A pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    /// Id.
    pub id: String,
    /// Team.
    pub team_id: String,
    /// Document the steps operate on (and lock).
    pub document_id: String,
    /// Name.
    pub name: String,
    /// State.
    pub status: PipelineStatus,
    /// Steps in order.
    pub steps: Vec<PipelineStep>,
    /// Shared state.
    pub shared_state: BTreeMap<String, Value>,
    /// Created (unix ms).
    pub created_at: i64,
    /// Updated (unix ms).
    pub updated_at: i64,
}

/// Exclusive lock on a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentLock {
    /// Document.
    pub document_id: String,
    /// Holder.
    pub session_id: String,
    /// Pipeline.
    pub pipeline_id: String,
    /// Step.
    pub step_id: String,
    /// Acquired (unix ms).
    pub acquired_at: i64,
    /// Expires (unix ms).
    pub expires_at: i64,
}

impl DocumentLock {
    fn expired(&self, now: i64) -> bool {
        self.expires_at <= now
    }
}

/// Result of [`Orchestrator::claim_step`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimResult {
    /// Claimed?
    pub claimed: bool,
    /// The lock, when claimed.
    pub lock: Option<DocumentLock>,
    /// Why not (the TS strings).
    pub reason: Option<String>,
}

impl ClaimResult {
    fn no(reason: impl Into<String>) -> Self {
        Self {
            claimed: false,
            lock: None,
            reason: Some(reason.into()),
        }
    }
}

/// Pipelines + locks.
#[derive(Debug, Default)]
pub struct Orchestrator {
    pipelines: HashMap<String, Pipeline>,
    order: Vec<String>,
    locks: HashMap<String, DocumentLock>,
}

impl Orchestrator {
    /// Empty.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a pipeline.
    pub fn create_pipeline(
        &mut self,
        team_id: &str,
        document_id: &str,
        name: &str,
        steps: Vec<StepSpec>,
    ) -> Pipeline {
        self.create_pipeline_at(team_id, document_id, name, steps, now_ms())
    }

    /// [`Self::create_pipeline`] with an explicit clock.
    pub fn create_pipeline_at(
        &mut self,
        team_id: &str,
        document_id: &str,
        name: &str,
        steps: Vec<StepSpec>,
        now: i64,
    ) -> Pipeline {
        let ids: Vec<String> = steps.iter().map(|_| new_id()).collect();
        let by_name: HashMap<&str, &str> = steps
            .iter()
            .zip(&ids)
            .map(|(s, id)| (s.name.as_str(), id.as_str()))
            .collect();
        let built: Vec<PipelineStep> = steps
            .iter()
            .zip(&ids)
            .map(|(s, id)| PipelineStep {
                id: id.clone(),
                name: s.name.clone(),
                workflow_id: s.workflow_id.clone(),
                status: StepStatus::Pending,
                assigned_session_id: None,
                depends_on: s
                    .depends_on
                    .iter()
                    .map(|d| {
                        by_name
                            .get(d.as_str())
                            .map_or_else(|| d.clone(), |id| (*id).to_owned())
                    })
                    .collect(),
                output: None,
                locked_at: None,
                completed_at: None,
            })
            .collect();
        let p = Pipeline {
            id: new_id(),
            team_id: team_id.into(),
            document_id: document_id.into(),
            name: name.into(),
            status: PipelineStatus::Pending,
            steps: built,
            shared_state: BTreeMap::new(),
            created_at: now,
            updated_at: now,
        };
        self.order.push(p.id.clone());
        self.pipelines.insert(p.id.clone(), p.clone());
        p
    }

    /// Pipeline by id.
    #[must_use]
    pub fn pipeline(&self, id: &str) -> Option<&Pipeline> {
        self.pipelines.get(id)
    }

    /// Pipelines of a team, in creation order.
    #[must_use]
    pub fn list_pipelines(&self, team_id: &str) -> Vec<&Pipeline> {
        self.order
            .iter()
            .filter_map(|i| self.pipelines.get(i))
            .filter(|p| p.team_id == team_id)
            .collect()
    }

    /// Add a dependency to a step by raw id (what the TS tests did by mutating the object).
    /// Returns false when the pipeline or step does not exist.
    pub fn add_dependency(&mut self, pipeline_id: &str, step_id: &str, dep_id: &str) -> bool {
        self.pipelines
            .get_mut(pipeline_id)
            .and_then(|p| p.steps.iter_mut().find(|s| s.id == step_id))
            .map(|s| s.depends_on.push(dep_id.to_owned()))
            .is_some()
    }

    /// Claim a pending step for `session_id`, taking the document lock.
    pub fn claim_step(
        &mut self,
        pipeline_id: &str,
        step_id: &str,
        session_id: &str,
    ) -> ClaimResult {
        self.claim_step_at(pipeline_id, step_id, session_id, now_ms())
    }

    /// [`Self::claim_step`] with an explicit clock.
    pub fn claim_step_at(
        &mut self,
        pipeline_id: &str,
        step_id: &str,
        session_id: &str,
        now: i64,
    ) -> ClaimResult {
        let Some(p) = self.pipelines.get(pipeline_id) else {
            return ClaimResult::no("Pipeline not found");
        };
        let Some(step) = p.steps.iter().find(|s| s.id == step_id) else {
            return ClaimResult::no("Step not found");
        };
        if step.status != StepStatus::Pending {
            return ClaimResult::no(format!("Step is already {}", step.status.label()));
        }
        let deps_met = step.depends_on.iter().all(|d| {
            p.steps
                .iter()
                .find(|s| &s.id == d)
                .is_some_and(|s| s.status == StepStatus::Completed)
        });
        if !deps_met {
            return ClaimResult::no("Dependencies not met");
        }
        let document_id = p.document_id.clone();
        let Some(lock) = self.acquire_lock_at(&document_id, session_id, pipeline_id, step_id, now)
        else {
            return ClaimResult::no("Document is locked by another session");
        };
        if let Some(p) = self.pipelines.get_mut(pipeline_id) {
            if let Some(s) = p.steps.iter_mut().find(|s| s.id == step_id) {
                s.status = StepStatus::Running;
                s.assigned_session_id = Some(session_id.to_owned());
                s.locked_at = Some(now);
            }
            if p.status == PipelineStatus::Pending {
                p.status = PipelineStatus::Running;
            }
            p.updated_at = now;
        }
        ClaimResult {
            claimed: true,
            lock: Some(lock),
            reason: None,
        }
    }

    /// Complete a running step claimed by `session_id`; releases the lock and completes the
    /// pipeline when every step is completed or skipped. False for unknown ids, a step that is not
    /// running, or the wrong claimant.
    pub fn complete_step(
        &mut self,
        pipeline_id: &str,
        step_id: &str,
        session_id: &str,
        output: Option<Value>,
    ) -> bool {
        self.complete_step_at(pipeline_id, step_id, session_id, output, now_ms())
    }

    /// [`Self::complete_step`] with an explicit clock.
    pub fn complete_step_at(
        &mut self,
        pipeline_id: &str,
        step_id: &str,
        session_id: &str,
        output: Option<Value>,
        now: i64,
    ) -> bool {
        let Some(p) = self.pipelines.get_mut(pipeline_id) else {
            return false;
        };
        let Some(step) = p.steps.iter_mut().find(|s| s.id == step_id) else {
            return false;
        };
        if step.status != StepStatus::Running
            || step.assigned_session_id.as_deref() != Some(session_id)
        {
            return false;
        }
        step.status = StepStatus::Completed;
        step.output = output;
        step.completed_at = Some(now);
        if p.steps
            .iter()
            .all(|s| matches!(s.status, StepStatus::Completed | StepStatus::Skipped))
        {
            p.status = PipelineStatus::Completed;
        }
        p.updated_at = now;
        let doc = p.document_id.clone();
        self.release_lock(&doc, session_id);
        true
    }

    /// Fail a step (only its claimant can); fails the pipeline and releases the lock. Unlike
    /// completion this does not require the step to be running (TS parity). Returns whether
    /// anything changed.
    pub fn fail_step(
        &mut self,
        pipeline_id: &str,
        step_id: &str,
        session_id: &str,
        error: &str,
    ) -> bool {
        self.fail_step_at(pipeline_id, step_id, session_id, error, now_ms())
    }

    /// [`Self::fail_step`] with an explicit clock.
    pub fn fail_step_at(
        &mut self,
        pipeline_id: &str,
        step_id: &str,
        session_id: &str,
        error: &str,
        now: i64,
    ) -> bool {
        let Some(p) = self.pipelines.get_mut(pipeline_id) else {
            return false;
        };
        let Some(step) = p.steps.iter_mut().find(|s| s.id == step_id) else {
            return false;
        };
        if step.assigned_session_id.as_deref() != Some(session_id) {
            return false;
        }
        step.status = StepStatus::Failed;
        step.output = Some(serde_json::json!({ "error": error }));
        step.completed_at = Some(now);
        p.status = PipelineStatus::Failed;
        p.updated_at = now;
        let doc = p.document_id.clone();
        self.release_lock(&doc, session_id);
        true
    }

    /// Take (or renew) the exclusive lock on a document. An expired lock is replaced by anyone;
    /// the holder re-acquiring renews it; otherwise `None`.
    pub fn acquire_lock(
        &mut self,
        document_id: &str,
        session_id: &str,
        pipeline_id: &str,
        step_id: &str,
    ) -> Option<DocumentLock> {
        self.acquire_lock_at(document_id, session_id, pipeline_id, step_id, now_ms())
    }

    /// [`Self::acquire_lock`] with an explicit clock.
    pub fn acquire_lock_at(
        &mut self,
        document_id: &str,
        session_id: &str,
        pipeline_id: &str,
        step_id: &str,
        now: i64,
    ) -> Option<DocumentLock> {
        if let Some(existing) = self.locks.get(document_id) {
            if !existing.expired(now) && existing.session_id != session_id {
                return None;
            }
        }
        let lock = DocumentLock {
            document_id: document_id.into(),
            session_id: session_id.into(),
            pipeline_id: pipeline_id.into(),
            step_id: step_id.into(),
            acquired_at: now,
            expires_at: now + LOCK_TTL_MS,
        };
        self.locks.insert(document_id.into(), lock.clone());
        Some(lock)
    }

    /// Release a lock; false when absent or held by someone else.
    pub fn release_lock(&mut self, document_id: &str, session_id: &str) -> bool {
        match self.locks.get(document_id) {
            Some(l) if l.session_id == session_id => {
                self.locks.remove(document_id);
                true
            }
            _ => false,
        }
    }

    /// Current lock (expired locks are dropped and reported as absent).
    pub fn get_lock(&mut self, document_id: &str) -> Option<DocumentLock> {
        self.get_lock_at(document_id, now_ms())
    }

    /// [`Self::get_lock`] with an explicit clock.
    pub fn get_lock_at(&mut self, document_id: &str, now: i64) -> Option<DocumentLock> {
        match self.locks.get(document_id) {
            Some(l) if l.expired(now) => {
                self.locks.remove(document_id);
                None
            }
            other => other.cloned(),
        }
    }

    /// Shared state of a pipeline (empty for unknown pipelines).
    #[must_use]
    pub fn shared_state(&self, pipeline_id: &str) -> BTreeMap<String, Value> {
        self.pipelines
            .get(pipeline_id)
            .map(|p| p.shared_state.clone())
            .unwrap_or_default()
    }

    /// Set a shared-state key. No-op for unknown pipelines.
    pub fn update_shared_state(&mut self, pipeline_id: &str, key: &str, value: Value) {
        if let Some(p) = self.pipelines.get_mut(pipeline_id) {
            p.shared_state.insert(key.into(), value);
            p.updated_at = now_ms();
        }
    }

    /// Pending steps whose dependencies are all completed.
    #[must_use]
    pub fn next_available_steps(&self, pipeline_id: &str) -> Vec<&PipelineStep> {
        let Some(p) = self.pipelines.get(pipeline_id) else {
            return Vec::new();
        };
        p.steps
            .iter()
            .filter(|s| {
                s.status == StepStatus::Pending
                    && s.depends_on.iter().all(|d| {
                        p.steps
                            .iter()
                            .find(|x| &x.id == d)
                            .is_some_and(|x| x.status == StepStatus::Completed)
                    })
            })
            .collect()
    }
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use serde_json::json;

    fn one(o: &mut Orchestrator, doc: &str) -> Pipeline {
        o.create_pipeline("team-1", doc, "P", vec![StepSpec::new("S1", "wf-1")])
    }

    fn chain(o: &mut Orchestrator) -> Pipeline {
        o.create_pipeline(
            "team-1",
            "doc-1",
            "Chain",
            vec![
                StepSpec::new("A", "wf-a"),
                StepSpec::new("B", "wf-b").after("A"),
                StepSpec::new("C", "wf-c").after("A").after("B"),
            ],
        )
    }

    #[test]
    fn create_resolves_names_and_keeps_raw_ids() {
        let mut o = Orchestrator::new();
        let p = chain(&mut o);
        assert_eq!(p.status, PipelineStatus::Pending);
        assert!(p.steps.iter().all(|s| s.status == StepStatus::Pending));
        assert_eq!(p.steps[0].depends_on, Vec::<String>::new());
        assert_eq!(p.steps[1].depends_on, [p.steps[0].id.clone()]);
        assert_eq!(
            p.steps[2].depends_on,
            [p.steps[0].id.clone(), p.steps[1].id.clone()]
        );
        // Raw / foreign ids are stored verbatim (TS parity).
        let p2 = o.create_pipeline(
            "team-1",
            "doc-2",
            "P2",
            vec![
                StepSpec::new("X", "wf"),
                StepSpec::new("Y", "wf").after(&p.steps[0].id),
            ],
        );
        assert_eq!(p2.steps[1].depends_on, [p.steps[0].id.clone()]);
        assert_eq!(o.pipeline(&p2.id).unwrap(), &p2);
        assert!(o.pipeline("nope").is_none());
    }

    #[test]
    fn list_filters_by_team_in_order() {
        let mut o = Orchestrator::new();
        let a = o.create_pipeline("t1", "d", "a", vec![]);
        o.create_pipeline("t2", "d", "b", vec![]);
        let c = o.create_pipeline("t1", "d", "c", vec![]);
        let names: Vec<_> = o
            .list_pipelines("t1")
            .iter()
            .map(|p| p.id.clone())
            .collect();
        assert_eq!(names, [a.id, c.id]);
        assert!(o.list_pipelines("none").is_empty());
    }

    #[test]
    fn claim_basic_and_failure_reasons() {
        let mut o = Orchestrator::new();
        let p = one(&mut o, "doc-1");
        let s = p.steps[0].id.clone();
        assert_eq!(
            o.claim_step("nope", &s, "a").reason.as_deref(),
            Some("Pipeline not found")
        );
        assert_eq!(
            o.claim_step(&p.id, "nope", "a").reason.as_deref(),
            Some("Step not found")
        );
        let r = o.claim_step(&p.id, &s, "session-1");
        assert!(r.claimed && r.reason.is_none());
        assert_eq!(r.lock.unwrap().session_id, "session-1");
        let step = &o.pipeline(&p.id).unwrap().steps[0];
        assert_eq!(step.status, StepStatus::Running);
        assert_eq!(step.assigned_session_id.as_deref(), Some("session-1"));
        assert_eq!(o.pipeline(&p.id).unwrap().status, PipelineStatus::Running);
        // Concurrent claim of the same step.
        let r = o.claim_step(&p.id, &s, "session-2");
        assert!(!r.claimed);
        assert_eq!(r.reason.as_deref(), Some("Step is already running"));
    }

    #[test]
    fn dependencies_gate_claims_in_order() {
        let mut o = Orchestrator::new();
        let p = chain(&mut o);
        let (a, b, c) = (
            p.steps[0].id.clone(),
            p.steps[1].id.clone(),
            p.steps[2].id.clone(),
        );
        assert_eq!(
            o.claim_step(&p.id, &b, "s").reason.as_deref(),
            Some("Dependencies not met")
        );
        assert_eq!(o.next_available_steps(&p.id).len(), 1);
        assert!(o.claim_step(&p.id, &a, "s").claimed);
        assert!(o.next_available_steps(&p.id).is_empty()); // A running, B waits
        assert!(o.complete_step(&p.id, &a, "s", Some(json!({"ok": 1}))));
        assert_eq!(o.next_available_steps(&p.id).len(), 1);
        assert!(o.claim_step(&p.id, &b, "s").claimed);
        assert!(o.complete_step(&p.id, &b, "s", None));
        assert!(o.claim_step(&p.id, &c, "s").claimed);
        assert!(o.complete_step(&p.id, &c, "s", None));
        let done = o.pipeline(&p.id).unwrap();
        assert_eq!(done.status, PipelineStatus::Completed);
        assert_eq!(done.steps[0].output, Some(json!({"ok": 1})));
        assert!(done.steps[0].completed_at.is_some());
        assert!(o.next_available_steps(&p.id).is_empty());
        assert!(o.next_available_steps("nope").is_empty());
    }

    #[test]
    fn dangling_dependency_never_unblocks() {
        let mut o = Orchestrator::new();
        let p = one(&mut o, "d");
        let s = p.steps[0].id.clone();
        assert!(o.add_dependency(&p.id, &s, "ghost-step-id"));
        assert!(!o.add_dependency(&p.id, "nope", "x"));
        assert_eq!(
            o.claim_step(&p.id, &s, "s").reason.as_deref(),
            Some("Dependencies not met")
        );
        assert!(o.next_available_steps(&p.id).is_empty());
    }

    #[test]
    fn document_lock_blocks_other_sessions_until_release() {
        let mut o = Orchestrator::new();
        let p1 = one(&mut o, "shared-doc");
        let p2 = one(&mut o, "shared-doc");
        assert!(o.claim_step(&p1.id, &p1.steps[0].id, "session-1").claimed);
        let r = o.claim_step(&p2.id, &p2.steps[0].id, "session-2");
        assert_eq!(
            r.reason.as_deref(),
            Some("Document is locked by another session")
        );
        // Failed claim leaves the step pending.
        assert_eq!(
            o.pipeline(&p2.id).unwrap().steps[0].status,
            StepStatus::Pending
        );
        assert!(o.complete_step(&p1.id, &p1.steps[0].id, "session-1", None));
        assert!(o.claim_step(&p2.id, &p2.steps[0].id, "session-2").claimed);
    }

    #[test]
    fn complete_rejects_wrong_session_and_non_running() {
        let mut o = Orchestrator::new();
        let p = one(&mut o, "d");
        let s = p.steps[0].id.clone();
        assert!(!o.complete_step(&p.id, &s, "s", None)); // pending
        o.claim_step(&p.id, &s, "session-1");
        assert!(!o.complete_step(&p.id, &s, "session-2", None));
        assert!(!o.complete_step("nope", &s, "session-1", None));
        assert!(!o.complete_step(&p.id, "nope", "session-1", None));
        assert_eq!(
            o.pipeline(&p.id).unwrap().steps[0].status,
            StepStatus::Running
        );
        // Lock still held by session-1.
        assert!(o.get_lock("d").is_some());
        assert!(o.complete_step(&p.id, &s, "session-1", None));
        assert!(o.get_lock("d").is_none());
        assert!(!o.complete_step(&p.id, &s, "session-1", None)); // already completed
    }

    #[test]
    fn fail_marks_step_and_pipeline_and_releases_lock() {
        let mut o = Orchestrator::new();
        let p = chain(&mut o);
        let a = p.steps[0].id.clone();
        assert!(!o.fail_step(&p.id, &a, "s", "boom")); // never claimed
        o.claim_step(&p.id, &a, "s");
        assert!(!o.fail_step(&p.id, &a, "other", "boom"));
        assert!(o.fail_step(&p.id, &a, "s", "boom"));
        let f = o.pipeline(&p.id).unwrap();
        assert_eq!(f.status, PipelineStatus::Failed);
        assert_eq!(f.steps[0].status, StepStatus::Failed);
        assert_eq!(f.steps[0].output, Some(json!({"error": "boom"})));
        assert!(o.get_lock("doc-1").is_none());
        // Dependents can never run.
        assert_eq!(
            o.claim_step(&p.id, &p.steps[1].id, "s").reason.as_deref(),
            Some("Dependencies not met")
        );
        assert!(!o.fail_step("nope", &a, "s", "x"));
    }

    #[test]
    fn skipped_steps_count_toward_completion() {
        let mut o = Orchestrator::new();
        let p = o.create_pipeline(
            "t",
            "d",
            "p",
            vec![StepSpec::new("A", "w"), StepSpec::new("B", "w")],
        );
        o.pipelines.get_mut(&p.id).unwrap().steps[1].status = StepStatus::Skipped;
        o.claim_step(&p.id, &p.steps[0].id, "s");
        o.complete_step(&p.id, &p.steps[0].id, "s", None);
        assert_eq!(o.pipeline(&p.id).unwrap().status, PipelineStatus::Completed);
    }

    #[test]
    fn lock_acquire_release_renew_and_expiry() {
        let mut o = Orchestrator::new();
        let l = o.acquire_lock_at("doc", "s1", "p1", "st1", 1_000).unwrap();
        assert_eq!(l.expires_at, 1_000 + LOCK_TTL_MS);
        // Another session is refused while the lock is live; the holder renews (new step, new expiry).
        assert!(o.acquire_lock_at("doc", "s2", "p1", "st2", 1_001).is_none());
        let renewed = o.acquire_lock_at("doc", "s1", "p1", "st2", 5_000).unwrap();
        assert_eq!(renewed.step_id, "st2");
        assert_eq!(renewed.expires_at, 5_000 + LOCK_TTL_MS);
        // Wrong session cannot release.
        assert!(!o.release_lock("doc", "s2"));
        assert!(!o.release_lock("other-doc", "s1"));
        // Expiry boundary: at expires_at the lock is gone.
        assert!(o.get_lock_at("doc", renewed.expires_at - 1).is_some());
        assert!(o.get_lock_at("doc", renewed.expires_at).is_none());
        // Expired lock can be taken over by another session.
        o.acquire_lock_at("doc", "s1", "p", "s", 0).unwrap();
        let took = o
            .acquire_lock_at("doc", "s2", "p", "s", LOCK_TTL_MS)
            .unwrap();
        assert_eq!(took.session_id, "s2");
        assert!(o.release_lock("doc", "s2"));
        assert!(o.get_lock_at("doc", 0).is_none());
    }

    #[test]
    fn claim_after_lock_expiry_by_clock() {
        let mut o = Orchestrator::new();
        let p1 = one(&mut o, "doc");
        let p2 = one(&mut o, "doc");
        assert!(o.claim_step_at(&p1.id, &p1.steps[0].id, "s1", 0).claimed);
        assert!(
            !o.claim_step_at(&p2.id, &p2.steps[0].id, "s2", LOCK_TTL_MS - 1)
                .claimed
        );
        assert!(
            o.claim_step_at(&p2.id, &p2.steps[0].id, "s2", LOCK_TTL_MS)
                .claimed
        );
    }

    #[test]
    fn shared_state_roundtrip() {
        let mut o = Orchestrator::new();
        let p = one(&mut o, "d");
        assert!(o.shared_state(&p.id).is_empty());
        o.update_shared_state(&p.id, "k", json!({"n": 1}));
        o.update_shared_state(&p.id, "k2", json!("v"));
        o.update_shared_state(&p.id, "k", json!(2)); // overwrite
        let s = o.shared_state(&p.id);
        assert_eq!(s["k"], json!(2));
        assert_eq!(s.len(), 2);
        o.update_shared_state("nope", "k", json!(1)); // no-op
        assert!(o.shared_state("nope").is_empty());
    }
}
