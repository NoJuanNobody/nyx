//! Governance policy evaluation (`governance.service.ts`).
//!
//! Rules, in TS order: (1) `publish` with content passes a quality gate (score >= 7) through a
//! [`QualityAnalyzer`]; (2) `edit`/`create` content is scanned for secrets; (3) `delete` needs
//! admin intent. Principle warnings come from the constitution when one is loaded. Extensions:
//! forbidden paths, per-action approval rules, and [`PolicyEngine::evaluate_gated`] which checks
//! the approval ledger.

use std::path::Path;
use std::sync::Arc;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::approvals::{ApprovalRule, ApprovalService, ApprovalStatus};
use super::secrets::detect_secrets;
use crate::error::Result;
use crate::model::Id;

/// Minimum spec quality score required to publish.
pub const MIN_QUALITY_SCORE: f64 = 7.0;

/// A constitution principle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Principle {
    /// Stable id (`security-first`).
    pub id: String,
    /// Title.
    pub title: String,
    /// Description.
    #[serde(default)]
    pub description: String,
}

/// A path pattern agents and tools must not touch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForbiddenPath {
    /// Pattern; `*` matches any run of characters. No `/` means "match the file name".
    pub pattern: String,
    /// Pattern that is allowed even though `pattern` matches.
    #[serde(default)]
    pub exception: Option<String>,
    /// Why.
    #[serde(default)]
    pub reason: String,
}

/// Quality-gate result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QualityReport {
    /// Score 0 to 10.
    pub score: f64,
    /// Improvement suggestions.
    pub suggestions: Vec<String>,
}

/// Scores spec quality. The LLM-backed implementation belongs to the `LlmProvider` ticket (AI-75);
/// until it is unified, implement this trait over it. [`FixedQuality`] serves tests.
pub trait QualityAnalyzer: Send + Sync {
    /// Analyse content, optionally for a lifecycle stage.
    fn analyze_spec_quality(&self, content: &str, stage: Option<&str>) -> Result<QualityReport>;
}

/// Analyzer returning a fixed report and recording the stage it was called with.
#[derive(Debug)]
pub struct FixedQuality {
    report: std::result::Result<QualityReport, String>,
    stages: std::sync::Mutex<Vec<Option<String>>>,
}

impl FixedQuality {
    /// Always returns this score and suggestions.
    #[must_use]
    pub fn score(score: f64, suggestions: &[&str]) -> Self {
        Self {
            report: Ok(QualityReport {
                score,
                suggestions: suggestions.iter().map(ToString::to_string).collect(),
            }),
            stages: std::sync::Mutex::default(),
        }
    }

    /// Always fails with this message.
    #[must_use]
    pub fn failing(message: &str) -> Self {
        Self {
            report: Err(message.into()),
            stages: std::sync::Mutex::default(),
        }
    }

    /// Stages seen so far.
    #[must_use]
    pub fn stages(&self) -> Vec<Option<String>> {
        self.stages.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl QualityAnalyzer for FixedQuality {
    fn analyze_spec_quality(&self, _content: &str, stage: Option<&str>) -> Result<QualityReport> {
        if let Ok(mut g) = self.stages.lock() {
            g.push(stage.map(ToString::to_string));
        }
        self.report.clone().map_err(crate::error::Error::Invalid)
    }
}

/// Governed action. Unknown actions pass through with no rule applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Publish a document.
    Publish,
    /// Edit a document.
    Edit,
    /// Create a document.
    Create,
    /// Delete something.
    Delete,
    /// Any other action name.
    Other(String),
}

impl Action {
    /// Parse the wire name.
    #[must_use]
    pub fn parse(s: &str) -> Self {
        match s {
            "publish" => Self::Publish,
            "edit" => Self::Edit,
            "create" => Self::Create,
            "delete" => Self::Delete,
            other => Self::Other(other.into()),
        }
    }

    /// Wire name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Publish => "publish",
            Self::Edit => "edit",
            Self::Create => "create",
            Self::Delete => "delete",
            Self::Other(s) => s,
        }
    }
}

/// An action to validate.
#[derive(Debug, Clone)]
pub struct ActionRequest {
    /// What is being done.
    pub action: Action,
    /// Content being written, if any.
    pub content: Option<String>,
    /// Lifecycle stage (passed to the quality analyzer).
    pub stage: Option<String>,
    /// Team.
    pub team_id: Id,
    /// Whether the caller acts with admin authority (lets `delete` through).
    pub is_admin: bool,
    /// File path touched, checked against forbidden paths.
    pub path: Option<String>,
}

impl ActionRequest {
    /// Request with only action and team.
    #[must_use]
    pub fn new(action: &str, team_id: &str) -> Self {
        Self {
            action: Action::parse(action),
            content: None,
            stage: None,
            team_id: team_id.into(),
            is_admin: false,
            path: None,
        }
    }

    /// Attach content.
    #[must_use]
    pub fn with_content(mut self, content: &str) -> Self {
        self.content = Some(content.into());
        self
    }
}

/// Outcome of a policy evaluation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    /// True iff there are no violations.
    pub allowed: bool,
    /// Blocking problems.
    pub violations: Vec<String>,
    /// Non-blocking notes.
    pub warnings: Vec<String>,
    /// The approval rule that applies to this action, if any.
    pub approval: Option<ApprovalRule>,
}

/// Loaded policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyConfig {
    /// Publish quality threshold.
    pub min_quality_score: f64,
    /// Constitution principles; `None` means no constitution loaded (no principle warnings).
    pub principles: Option<Vec<Principle>>,
    /// Forbidden paths.
    pub forbidden_paths: Vec<ForbiddenPath>,
    /// Files exempt from forbidden-path rules (`.env.example`).
    pub allowed_files: Vec<String>,
    /// Approval rules by action.
    pub approval_rules: Vec<ApprovalRule>,
    /// Raw constitution document, for `rules()`.
    pub constitution: Option<Value>,
    /// Raw governance document, for `rules()`.
    pub governance: Option<Value>,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            min_quality_score: MIN_QUALITY_SCORE,
            principles: None,
            forbidden_paths: vec![],
            allowed_files: vec![],
            approval_rules: vec![],
            constitution: None,
            governance: None,
        }
    }
}

fn read_json(dir: &Path, name: &str) -> Option<Value> {
    let raw = std::fs::read_to_string(dir.join(name)).ok()?;
    serde_json::from_str(&raw).ok()
}

impl PolicyConfig {
    /// Load `constitution.json` and `governance.json` from an `.agentpolicy` directory. Missing or
    /// malformed files are ignored, like the TS `readAgentPolicyFile`.
    #[must_use]
    pub fn from_agentpolicy_dir(dir: &Path) -> Self {
        let constitution = read_json(dir, "constitution.json");
        let governance = read_json(dir, "governance.json");
        let principles = constitution
            .as_ref()
            .and_then(|c| c.get("principles"))
            .and_then(|p| serde_json::from_value(p.clone()).ok());
        let forbidden_paths = governance
            .as_ref()
            .and_then(|g| g.get("forbidden_paths"))
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .unwrap_or_default();
        let allowed_files = governance
            .as_ref()
            .and_then(|g| g.get("allowed_env_files"))
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .unwrap_or_default();
        let approval_rules = governance
            .as_ref()
            .and_then(|g| g.get("approval_rules"))
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .unwrap_or_default();
        Self {
            principles,
            forbidden_paths,
            allowed_files,
            approval_rules,
            constitution,
            governance,
            ..Self::default()
        }
    }

    /// Raw rule documents (`GET /governance/rules`).
    #[must_use]
    pub fn rules(&self) -> (Option<&Value>, Option<&Value>) {
        (self.constitution.as_ref(), self.governance.as_ref())
    }
}

/// `*` wildcard match over the whole string.
fn glob(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut rest = text;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            let Some(r) = rest.strip_prefix(part) else {
                return false;
            };
            rest = r;
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            let Some(pos) = rest.find(part) else {
                return false;
            };
            rest = &rest[pos + part.len()..];
        }
    }
    true
}

fn path_matches(pattern: &str, path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if pattern.contains('/') {
        glob(pattern, &normalized)
    } else {
        glob(
            pattern,
            normalized.rsplit('/').next().unwrap_or(&normalized),
        )
    }
}

/// Policy engine.
pub struct PolicyEngine {
    config: PolicyConfig,
    analyzer: Option<Arc<dyn QualityAnalyzer>>,
}

impl PolicyEngine {
    /// New engine without a quality analyzer.
    #[must_use]
    pub fn new(config: PolicyConfig) -> Self {
        Self {
            config,
            analyzer: None,
        }
    }

    /// Attach the quality analyzer.
    #[must_use]
    pub fn with_analyzer(mut self, analyzer: Arc<dyn QualityAnalyzer>) -> Self {
        self.analyzer = Some(analyzer);
        self
    }

    /// The loaded policy.
    #[must_use]
    pub fn config(&self) -> &PolicyConfig {
        &self.config
    }

    /// Reason a path is forbidden, if it is.
    #[must_use]
    pub fn forbidden_path(&self, path: &str) -> Option<String> {
        let base = path.replace('\\', "/");
        let base = base.rsplit('/').next().unwrap_or(&base);
        if self.config.allowed_files.iter().any(|f| f == base) {
            return None;
        }
        self.config
            .forbidden_paths
            .iter()
            .find(|f| {
                path_matches(&f.pattern, path)
                    && !f
                        .exception
                        .as_deref()
                        .is_some_and(|e| path_matches(e, path))
            })
            .map(|f| format!("Path '{path}' is forbidden by policy: {}", f.reason))
    }

    /// Evaluate an action against the policy (TS `validateAction`).
    #[must_use]
    pub fn validate_action(&self, req: &ActionRequest) -> Decision {
        let mut violations = Vec::new();
        let mut warnings = Vec::new();
        let content = req.content.as_deref().filter(|c| !c.is_empty());

        // Rule 1: publish quality gate.
        if req.action == Action::Publish {
            if let Some(content) = content {
                match &self.analyzer {
                    Some(a) => match a.analyze_spec_quality(content, req.stage.as_deref()) {
                        Ok(q) if q.score < self.config.min_quality_score => violations.push(format!(
                            "Quality score {}/10 is below the minimum threshold of {}. Suggestions: {}",
                            q.score,
                            self.config.min_quality_score,
                            q.suggestions.join("; ")
                        )),
                        Ok(_) => {}
                        Err(e) => warnings.push(format!("Could not run quality analysis: {e}")),
                    },
                    None => warnings.push(
                        "Could not run quality analysis: no quality analyzer configured".into(),
                    ),
                }
            }
        }

        // Rule 2: secrets in written content.
        if matches!(req.action, Action::Edit | Action::Create) {
            if let Some(content) = content {
                violations.extend(detect_secrets(content));
            }
        }

        // Rule 3: delete needs admin intent.
        if req.action == Action::Delete && !req.is_admin {
            violations.push(
                "Delete actions require admin-level authorization. Ensure the requesting context has admin privileges."
                    .into(),
            );
        }

        if let Some(path) = &req.path {
            if let Some(v) = self.forbidden_path(path) {
                violations.push(v);
            }
        }

        // Principle warnings (only when a constitution is loaded).
        if self.config.principles.is_some() {
            if content.is_some_and(|c| !detect_secrets(c).is_empty()) {
                warnings.push(
                    "Potential violation of \"Security First\" principle: content may contain secrets"
                        .into(),
                );
            }
            if req.action == Action::Delete {
                warnings.push(
                    "Deletion actions should be reviewed against \"Stay Scoped and Respect Sequencing\" principle"
                        .into(),
                );
            }
        }

        let approval = self
            .config
            .approval_rules
            .iter()
            .find(|r| r.action == req.action.as_str())
            .cloned();

        Decision {
            allowed: violations.is_empty(),
            violations,
            warnings,
            approval,
        }
    }

    /// Like [`validate_action`](Self::validate_action), but when an approval rule applies also
    /// consults the approval ledger for `resource_id`: a missing, pending, rejected or expired
    /// approval becomes a violation, an approved one lets the action through.
    pub fn evaluate_gated(
        &self,
        conn: &Connection,
        req: &ActionRequest,
        resource_id: &str,
    ) -> Result<Decision> {
        let mut d = self.validate_action(req);
        if d.approval.is_some() {
            let latest =
                ApprovalService::new(conn).check(req.action.as_str(), resource_id, &req.team_id)?;
            match latest.map(|a| a.status) {
                Some(ApprovalStatus::Approved) => {}
                Some(ApprovalStatus::Pending) => {
                    d.violations.push(format!(
                        "Approval for '{}' is still pending.",
                        req.action.as_str()
                    ));
                }
                Some(s) => d.violations.push(format!(
                    "Latest approval for '{}' is {s}; request a new one.",
                    req.action.as_str()
                )),
                None => d.violations.push(format!(
                    "Action '{}' requires approval before it can proceed.",
                    req.action.as_str()
                )),
            }
            d.allowed = d.violations.is_empty();
        }
        Ok(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches() {
        assert!(glob(".env.*", ".env.local"));
        assert!(!glob(".env.*", ".env"));
        assert!(glob("*.md", "README.md"));
        assert!(glob("a*c", "abc"));
        assert!(!glob("a*c", "abd"));
        assert!(glob(".env", ".env"));
    }
}
