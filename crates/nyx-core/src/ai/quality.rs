//! Score interpretation for the quality surfaces (`AIQualityPanel.tsx`, `AIAdvisor.tsx`) and the
//! quality gate (GH #130): thresholds live here so every front-end shows the same verdict.

use serde::{Deserialize, Serialize};

use super::parse::SpecQuality;

/// Scores at or above this are "good" (green in the UI).
pub const GOOD_THRESHOLD: f64 = 7.0;
/// Scores at or above this (and below good) "need improvement" (amber).
pub const NEEDS_IMPROVEMENT_THRESHOLD: f64 = 4.0;

/// Verdict band for a 0-10 score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityBand {
    /// 7 and above.
    Good,
    /// 4 up to 7.
    NeedsImprovement,
    /// Below 4.
    SignificantIssues,
}

impl QualityBand {
    /// Band for a score.
    #[must_use]
    pub fn of(score: f64) -> Self {
        if score >= GOOD_THRESHOLD {
            Self::Good
        } else if score >= NEEDS_IMPROVEMENT_THRESHOLD {
            Self::NeedsImprovement
        } else {
            Self::SignificantIssues
        }
    }

    /// Human label used by the panel.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Good => "Good quality",
            Self::NeedsImprovement => "Needs improvement",
            Self::SignificantIssues => "Significant issues",
        }
    }
}

/// Outcome of checking a score against a gate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateResult {
    /// Did the document pass?
    pub passed: bool,
    /// Score checked.
    pub score: f64,
    /// Threshold applied.
    pub min_score: f64,
    /// Verdict band.
    pub band: QualityBand,
    /// What to fix (the assessment's suggestions) when it did not pass; empty on pass.
    pub blocking_suggestions: Vec<String>,
}

/// A minimum-score gate, e.g. before promoting a doc to the next lifecycle stage.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct QualityGate {
    /// Minimum passing score (default [`GOOD_THRESHOLD`]).
    pub min_score: f64,
}

impl Default for QualityGate {
    fn default() -> Self {
        Self {
            min_score: GOOD_THRESHOLD,
        }
    }
}

impl QualityGate {
    /// Gate with a custom threshold, clamped to 0-10.
    #[must_use]
    pub fn new(min_score: f64) -> Self {
        Self {
            min_score: if min_score.is_finite() {
                min_score.clamp(0.0, 10.0)
            } else {
                GOOD_THRESHOLD
            },
        }
    }

    /// Check an assessment.
    #[must_use]
    pub fn check(&self, q: &SpecQuality) -> GateResult {
        let passed = q.score >= self.min_score;
        GateResult {
            passed,
            score: q.score,
            min_score: self.min_score,
            band: QualityBand::of(q.score),
            blocking_suggestions: if passed {
                Vec::new()
            } else {
                q.suggestions.clone()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(score: f64) -> SpecQuality {
        SpecQuality {
            score,
            suggestions: vec!["fix".into()],
        }
    }

    #[test]
    fn bands_match_ui_thresholds() {
        assert_eq!(QualityBand::of(10.0), QualityBand::Good);
        assert_eq!(QualityBand::of(7.0), QualityBand::Good);
        assert_eq!(QualityBand::of(6.9), QualityBand::NeedsImprovement);
        assert_eq!(QualityBand::of(4.0), QualityBand::NeedsImprovement);
        assert_eq!(QualityBand::of(3.9), QualityBand::SignificantIssues);
        assert_eq!(QualityBand::of(0.0).label(), "Significant issues");
        assert_eq!(QualityBand::Good.label(), "Good quality");
    }

    #[test]
    fn gate_pass_and_fail() {
        let g = QualityGate::default();
        let ok = g.check(&q(8.0));
        assert!(ok.passed && ok.blocking_suggestions.is_empty());
        let bad = g.check(&q(5.0));
        assert!(!bad.passed);
        assert_eq!(bad.blocking_suggestions, vec!["fix"]);
        assert_eq!(bad.band, QualityBand::NeedsImprovement);
        assert!(QualityGate::new(5.0).check(&q(5.0)).passed);
        assert_eq!(QualityGate::new(99.0).min_score, 10.0);
        assert_eq!(QualityGate::new(f64::NAN).min_score, GOOD_THRESHOLD);
    }
}
