//! Stage transition planning and validation.
//!
//! The TypeScript API deliberately leaves manual stage changes unrestricted (any stage of the
//! document's lifecycle, forward, backward or skipping; `routes/documents.ts`), after the older
//! sequential gatekeeper (#197) proved too strict. [`TransitionPolicy::Free`] reproduces that;
//! [`TransitionPolicy::Sequential`] is the stricter opt-in used for guided "seed next stage" flows.
//! In both modes the target must be a real stage of the document's pipeline.

use serde::{Deserialize, Serialize};

use super::pipeline::PipelineDef;
use crate::error::{Error, Result};

/// How strictly transitions are checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionPolicy {
    /// Any stage of the pipeline is reachable (TS parity).
    #[default]
    Free,
    /// Forward moves go exactly one stage at a time and a first assignment must be the first
    /// stage. Backward moves and clearing the stage stay allowed.
    Sequential,
}

/// What a transition does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionKind {
    /// No change.
    Unchanged,
    /// Stage assigned to a document that had none (or had one unknown to this pipeline).
    Assign,
    /// Moved to the next stage.
    Advance,
    /// Moved forward past at least one stage.
    Skip,
    /// Moved backward.
    Regress,
    /// Stage cleared (stages are optional).
    Clear,
}

/// A validated transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transition {
    /// Previous stage slug.
    pub from: Option<String>,
    /// New stage slug.
    pub to: Option<String>,
    /// Classification.
    pub kind: TransitionKind,
    /// Stages passed over by a [`TransitionKind::Skip`].
    pub skipped: Vec<String>,
}

/// Validate and classify moving a document from `from` to `to` inside `pipeline`.
///
/// Errors with [`Error::Invalid`] when `to` is not a stage of the pipeline, or (Sequential only)
/// when the move skips ahead or `from` is unknown.
pub fn plan_transition(
    pipeline: &PipelineDef,
    from: Option<&str>,
    to: Option<&str>,
    policy: TransitionPolicy,
) -> Result<Transition> {
    let make = |kind, skipped| Transition {
        from: from.map(str::to_owned),
        to: to.map(str::to_owned),
        kind,
        skipped,
    };
    let Some(to_slug) = to else {
        return Ok(make(
            if from.is_some() {
                TransitionKind::Clear
            } else {
                TransitionKind::Unchanged
            },
            vec![],
        ));
    };
    let Some(to_idx) = pipeline.stage_index(to_slug) else {
        return Err(Error::Invalid(format!(
            "stage '{to_slug}' does not exist in pipeline '{}'",
            pipeline.slug
        )));
    };
    let from_idx = match from {
        None => None,
        Some(f) => match pipeline.stage_index(f) {
            Some(i) => Some(i),
            None if policy == TransitionPolicy::Sequential => {
                return Err(Error::Invalid(format!(
                    "current stage '{f}' is not in pipeline '{}'",
                    pipeline.slug
                )))
            }
            None => None,
        },
    };
    match from_idx {
        None => {
            if policy == TransitionPolicy::Sequential && to_idx != 0 {
                return Err(Error::Invalid(format!(
                    "a first assignment must be '{}', not '{to_slug}'",
                    pipeline.first_stage().slug
                )));
            }
            Ok(make(TransitionKind::Assign, vec![]))
        }
        Some(f) if f == to_idx => Ok(make(TransitionKind::Unchanged, vec![])),
        Some(f) if to_idx < f => Ok(make(TransitionKind::Regress, vec![])),
        Some(f) if to_idx == f + 1 => Ok(make(TransitionKind::Advance, vec![])),
        Some(f) => {
            if policy == TransitionPolicy::Sequential {
                return Err(Error::Invalid(format!(
                    "cannot skip from '{}' to '{to_slug}'; next stage is '{}'",
                    pipeline.stages[f].slug,
                    pipeline.stages[f + 1].slug
                )));
            }
            let skipped = pipeline.stages[f + 1..to_idx]
                .iter()
                .map(|s| s.slug.clone())
                .collect();
            Ok(make(TransitionKind::Skip, skipped))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Registry;

    fn sw() -> &'static PipelineDef {
        Registry::builtin().default_pipeline().unwrap()
    }

    fn kind(from: Option<&str>, to: Option<&str>, p: TransitionPolicy) -> Result<TransitionKind> {
        plan_transition(sw(), from, to, p).map(|t| t.kind)
    }

    #[test]
    fn free_policy_allows_every_stage_move() {
        use TransitionKind::*;
        let f = TransitionPolicy::Free;
        assert_eq!(kind(None, Some("architecture"), f).unwrap(), Assign);
        assert_eq!(
            kind(Some("conception"), Some("definition"), f).unwrap(),
            Advance
        );
        assert_eq!(
            kind(Some("definition"), Some("conception"), f).unwrap(),
            Regress
        );
        assert_eq!(
            kind(Some("execution"), Some("conception"), f).unwrap(),
            Regress
        );
        assert_eq!(
            kind(Some("definition"), Some("definition"), f).unwrap(),
            Unchanged
        );
        assert_eq!(kind(Some("definition"), None, f).unwrap(), Clear);
        assert_eq!(kind(None, None, f).unwrap(), Unchanged);
        // a stale stage from another pipeline is treated like no stage
        assert_eq!(
            kind(Some("pcb_layout"), Some("definition"), f).unwrap(),
            Assign
        );
    }

    #[test]
    fn skip_lists_the_stages_passed_over() {
        let t = plan_transition(
            sw(),
            Some("conception"),
            Some("implementation"),
            TransitionPolicy::Free,
        )
        .unwrap();
        assert_eq!(t.kind, TransitionKind::Skip);
        assert_eq!(t.skipped, ["definition", "architecture"]);
    }

    #[test]
    fn unknown_target_is_always_blocked() {
        for p in [TransitionPolicy::Free, TransitionPolicy::Sequential] {
            assert!(matches!(
                kind(Some("conception"), Some("pcb_layout"), p),
                Err(Error::Invalid(_))
            ));
            assert!(kind(None, Some("nonsense"), p).is_err());
        }
    }

    #[test]
    fn sequential_policy_blocks_skips_and_late_first_assignment() {
        use TransitionKind::*;
        let s = TransitionPolicy::Sequential;
        assert_eq!(kind(None, Some("conception"), s).unwrap(), Assign);
        assert!(kind(None, Some("definition"), s).is_err());
        assert_eq!(
            kind(Some("conception"), Some("definition"), s).unwrap(),
            Advance
        );
        let err = kind(Some("conception"), Some("architecture"), s).unwrap_err();
        assert!(
            err.to_string().contains("next stage is 'definition'"),
            "{err}"
        );
        assert_eq!(
            kind(Some("architecture"), Some("conception"), s).unwrap(),
            Regress
        );
        assert_eq!(kind(Some("architecture"), None, s).unwrap(), Clear);
        assert!(kind(Some("pcb_layout"), Some("definition"), s).is_err());
    }

    #[test]
    fn every_builtin_pipeline_can_be_walked_forward_sequentially() {
        for p in Registry::builtin().list() {
            let mut cur: Option<&str> = None;
            for s in &p.stages {
                let t = plan_transition(p, cur, Some(&s.slug), TransitionPolicy::Sequential)
                    .unwrap_or_else(|e| panic!("{}: {e}", p.slug));
                assert!(matches!(
                    t.kind,
                    TransitionKind::Assign | TransitionKind::Advance
                ));
                cur = Some(&s.slug);
            }
        }
    }
}
