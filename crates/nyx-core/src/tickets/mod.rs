//! Ticket generation, review and posting (GitHub Issues, GitLab, Bitbucket, Jira, Linear), the
//! tickets board, Sprint capacity and the Sprint Gatekeeper.
//!
//! Ticket AI-69. Ported from `ticket.service.ts`, `suggestion.service.ts` (the review half),
//! `sprint.service.ts`, `gatekeeper.service.ts` and the non-agent part of
//! `orchestration.service.ts`; see `docs/rust-core/tickets.md` for the mapping and parity gaps.
//!
//! Flow: [`draft::TicketGenerator`] (LLM via [`crate::ai::Advisor`]) -> [`review::DraftStore`]
//! (dedupe, review, destination, approve) -> [`review::post`] / [`review::post_batch`] through a
//! [`tracker::TrackerSet`] -> [`board`] (listing, status sync). [`sprint`] and [`gatekeeper`] are
//! independent of the posting path.
//!
//! Modules: [`tracker`] ([`tracker::TicketTracker`] trait, destinations, git-host adapter, fake),
//! [`jira`] (REST v3 + ADF), [`linear`] (GraphQL), [`draft`], [`review`], [`board`], [`sprint`],
//! [`gatekeeper`], [`orchestration`].
//!
//! Reuse: git hosts go through [`crate::git_provider::GitProvider`]; the HTTP seam for Jira and
//! Linear is [`crate::git_provider::HttpTransport`]; [`TrackerSink`] adapts a destination to the
//! [`crate::vcs::proposal::TicketSink`] used when pushing change proposals.

pub mod board;
pub mod draft;
pub mod gatekeeper;
pub mod jira;
pub mod linear;
pub mod orchestration;
pub mod review;
pub mod sprint;
pub mod tracker;

use crate::error::{Error, Result};
use crate::vcs::proposal::{ExternalTicket, SuggestedTicket, TicketSink};

use tracker::{Destination, NewIssue, TrackerSet};

/// [`TicketSink`] bound to one destination, so change-proposal pushes
/// ([`crate::vcs::proposal::push`]) can post through any tracker. The sink is stateless and
/// non-idempotent (the proposal's `pushed` status is what prevents repeats); use
/// [`review::post`] when you need idempotency and traceability.
///
/// Linear destinations are rejected: [`ExternalTicket`] carries a `TicketProvider`, which cannot
/// represent Linear.
#[derive(Debug)]
pub struct TrackerSink<'a> {
    trackers: &'a TrackerSet,
    destination: Destination,
}

impl<'a> TrackerSink<'a> {
    /// Sink posting to `destination`.
    #[must_use]
    pub fn new(trackers: &'a TrackerSet, destination: Destination) -> Self {
        Self {
            trackers,
            destination,
        }
    }
}

impl TicketSink for TrackerSink<'_> {
    fn create_ticket(&self, document_id: &str, ticket: &SuggestedTicket) -> Result<ExternalTicket> {
        let provider = self.destination.kind().ticket_provider().ok_or_else(|| {
            Error::Invalid("Linear tickets cannot be recorded through a proposal push".into())
        })?;
        let tracker = self.trackers.for_destination(&self.destination)?;
        let d = draft::draft_from_parts(
            &ticket.title,
            &ticket.description,
            &ticket.priority,
            &ticket.labels,
        );
        let body = draft::with_traceability(
            &d.description,
            "Nyx document",
            &draft::TraceRef {
                document_id: document_id.to_owned(),
                draft_id: String::new(),
            },
        );
        let issue = tracker.create_issue(
            &self.destination,
            &NewIssue {
                title: d.title,
                body,
                labels: d.labels,
            },
        )?;
        Ok(ExternalTicket {
            provider,
            external_id: issue.external_id,
            external_url: issue.external_url,
        })
    }
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tracker::{FakeTracker, TrackerKind};

    #[test]
    fn sink_posts_via_tracker_and_maps_provider() {
        let fake = Arc::new(FakeTracker::new(TrackerKind::Jira));
        let set = TrackerSet::new().with(fake.clone());
        let sink = TrackerSink::new(
            &set,
            Destination::Jira {
                project_key: "PROJ".into(),
            },
        );
        let s = SuggestedTicket {
            title: "Do it".into(),
            description: "Because".into(),
            priority: "high".into(),
            labels: vec!["a".into()],
        };
        let e = sink.create_ticket("doc-1", &s).unwrap();
        assert_eq!(e.provider, crate::model::TicketProvider::Jira);
        assert_eq!(e.external_id, "PROJ-1");
        let sent = &fake.created()[0].1;
        assert_eq!(sent.labels, ["a", "priority:high"]);
        assert!(sent.body.contains("nyx://document/doc-1"));
    }

    #[test]
    fn sink_rejects_linear_and_missing_tracker() {
        let set = TrackerSet::new();
        let s = SuggestedTicket {
            title: "t".into(),
            description: String::new(),
            priority: String::new(),
            labels: vec![],
        };
        let lin = TrackerSink::new(
            &set,
            Destination::Linear {
                team_id: "t".into(),
            },
        );
        assert!(matches!(lin.create_ticket("d", &s), Err(Error::Invalid(_))));
        let gh = TrackerSink::new(
            &set,
            Destination::Github {
                owner: "a".into(),
                repo: "b".into(),
            },
        );
        assert!(gh.create_ticket("d", &s).is_err());
    }
}
