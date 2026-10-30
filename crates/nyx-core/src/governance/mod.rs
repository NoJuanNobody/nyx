//! Governance: policy evaluation, approvals, compliance checks, audit queries and feedback.
//! Ported from `governance.service.ts`, `compliance.service.ts`, `audit.service.ts`,
//! `feedback.service.ts` and `approval.service.ts`.
//!
//! - [`policy`]: [`PolicyEngine`] decides whether an action is allowed (quality gate, secret scan,
//!   delete authorization, forbidden paths, approval rules).
//! - [`approvals`]: approval requests with rules and required reviewers.
//! - [`compliance`]: spec compliance check behind retriever and analyzer traits.
//! - [`audit`]: [`AuditService`] query, filter and export over the append-only audit log.
//! - [`feedback`]: feedback formatting, rate limiting and records.
//! - [`secrets`]: secret detection.

pub mod approvals;
pub mod audit;
pub mod compliance;
pub mod feedback;
pub mod policy;
pub mod secrets;

pub use approvals::{
    Approval, ApprovalReview, ApprovalRule, ApprovalService, ApprovalStatus, NewApproval,
};
pub use audit::{AuditEntry, AuditFilter, AuditService, ExportFormat};
pub use compliance::{
    check_compliance, ComplianceAnalyzer, ComplianceResult, ComplianceViolation, Severity,
    SpecChunk, SpecRetriever,
};
pub use feedback::{
    FeedbackFormatter, FeedbackRecord, FeedbackService, FormattedFeedback, HeuristicFormatter,
    IssueSubmitter, RateLimit, SubmitOutcome, SubmittedIssue,
};
pub use policy::{
    Action, ActionRequest, Decision, ForbiddenPath, PolicyConfig, PolicyEngine, Principle,
    QualityAnalyzer, QualityReport,
};
pub use secrets::detect_secrets;
