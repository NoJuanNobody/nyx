//! Tickets management page: list by team with document title and repo info, status sync from the
//! tracker, and the webhook-driven status update. Port of the read / sync half of
//! `ticket.service.ts` (`listByTeam`, `syncStatus`, `syncAllForTeam`, `updateStatus`,
//! `updateStatusByExternalId`). Creating tickets is [`super::review::post`].

use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::tracker::{Destination, TrackerKind, TrackerSet};
use crate::error::{Error, Result};
use crate::model::{Ticket, TicketProvider, TicketStatus};
use crate::store::{SqliteTickets, TicketRepo};

/// A ticket row enriched for the board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardTicket {
    /// The ticket.
    pub ticket: Ticket,
    /// Title of the source document.
    pub document_title: String,
    /// `owner/repo` (git hosts) or project key (Jira); empty when not derivable.
    pub repo_name: String,
    /// Repository / site URL; empty when not derivable.
    pub repo_url: String,
}

/// Board filters.
#[derive(Debug, Clone, Copy, Default)]
pub struct BoardFilter {
    /// Only this status.
    pub status: Option<TicketStatus>,
    /// Only this provider.
    pub provider: Option<TicketProvider>,
}

/// `owner/repo` or Jira project key from a ticket's external URL
/// (`extractRepoName`). GitLab / Bitbucket are derived too (TS returned empty).
#[must_use]
pub fn extract_repo_name(external_url: &str, provider: TicketProvider) -> String {
    let cap = |re: &str| {
        Regex::new(re)
            .ok()
            .and_then(|r| r.captures(external_url).map(|c| c[1].to_owned()))
            .unwrap_or_default()
    };
    match provider {
        TicketProvider::Github => cap(r"github\.com/([^/]+/[^/]+)"),
        TicketProvider::Jira => cap(r"/browse/([A-Z][A-Z0-9_]+)-\d+"),
        TicketProvider::Gitlab => cap(r"^https?://[^/]+/(.+?)/-/issues/"),
        TicketProvider::Bitbucket => cap(r"bitbucket\.org/([^/]+/[^/]+)"),
        // Workspace slug: https://linear.app/<workspace>/issue/ENG-42/title
        TicketProvider::Linear => cap(r"^https?://linear\.app/([^/]+)/issue/"),
    }
}

/// Repository or site URL from the external URL (`extractRepoUrl`). For Jira that is the site
/// origin, as in TS.
#[must_use]
pub fn extract_repo_url(external_url: &str, provider: TicketProvider) -> String {
    let cap = |re: &str| {
        Regex::new(re)
            .ok()
            .and_then(|r| r.captures(external_url).map(|c| c[1].to_owned()))
            .unwrap_or_default()
    };
    match provider {
        TicketProvider::Github => cap(r"(https?://github\.com/[^/]+/[^/]+)"),
        TicketProvider::Jira => cap(r"(https?://[^/]+)"),
        TicketProvider::Gitlab => cap(r"^(https?://[^/]+/.+?)/-/issues/"),
        TicketProvider::Bitbucket => cap(r"(https?://bitbucket\.org/[^/]+/[^/]+)"),
        TicketProvider::Linear => cap(r"^(https?://linear\.app/[^/]+)/issue/"),
    }
}

/// All tickets of a team's documents (deleted documents included, as in TS), with filters.
///
/// # Errors
/// Database failure.
pub fn list_for_team(
    conn: &Connection,
    team_id: &str,
    filter: &BoardFilter,
) -> Result<Vec<BoardTicket>> {
    let mut s = conn
        .prepare("SELECT id, title FROM documents WHERE team_id = ?1 ORDER BY created_at, rowid")?;
    let docs: Vec<(String, String)> = s
        .query_map([team_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let repo = SqliteTickets::new(conn);
    let mut out = Vec::new();
    for (id, title) in docs {
        for t in repo.list_by_document(&id)? {
            if filter.status.is_some_and(|s| s != t.status)
                || filter.provider.is_some_and(|p| p != t.provider)
            {
                continue;
            }
            out.push(BoardTicket {
                repo_name: extract_repo_name(&t.external_url, t.provider),
                repo_url: extract_repo_url(&t.external_url, t.provider),
                document_title: title.clone(),
                ticket: t,
            });
        }
    }
    Ok(out)
}

/// Rebuild the destination a ticket was posted to from its URL / id. (The TS used the team's
/// *first* configured repo, which was wrong for tickets posted elsewhere.)
#[must_use]
pub fn destination_of(t: &Ticket) -> Option<Destination> {
    let name = extract_repo_name(&t.external_url, t.provider);
    if name.is_empty() {
        return None;
    }
    let split = |n: &str| {
        n.rsplit_once('/')
            .map(|(o, r)| (o.to_owned(), r.to_owned()))
    };
    Some(match t.provider {
        TicketProvider::Github => {
            let (owner, repo) = split(&name)?;
            Destination::Github { owner, repo }
        }
        TicketProvider::Gitlab => {
            let (owner, repo) = split(&name)?;
            Destination::Gitlab { owner, repo }
        }
        TicketProvider::Bitbucket => {
            let (owner, repo) = split(&name)?;
            Destination::Bitbucket { owner, repo }
        }
        TicketProvider::Jira => Destination::Jira { project_key: name },
        // The URL carries the workspace, not the team id. The identifier prefix (`ENG` of
        // `ENG-42`) is the team *key*; status sync only needs the tracker kind.
        TicketProvider::Linear => Destination::Linear {
            team_id: t
                .external_id
                .rsplit_once('-')
                .map(|(k, _)| k)
                .filter(|k| !k.is_empty())?
                .to_owned(),
        },
    })
}

fn kind_of(p: TicketProvider) -> TrackerKind {
    match p {
        TicketProvider::Github => TrackerKind::Github,
        TicketProvider::Gitlab => TrackerKind::Gitlab,
        TicketProvider::Bitbucket => TrackerKind::Bitbucket,
        TicketProvider::Jira => TrackerKind::Jira,
        TicketProvider::Linear => TrackerKind::Linear,
    }
}

/// Pull the ticket's status from its tracker and store it. With no tracker configured for the
/// provider (or an undecodable URL) the ticket is returned unchanged, as the TS did without an
/// integration.
///
/// # Errors
/// [`Error::NotFound`] for an unknown ticket; tracker errors as [`Error::Invalid`].
pub fn sync_status(conn: &Connection, trackers: &TrackerSet, ticket_id: &str) -> Result<Ticket> {
    let repo = SqliteTickets::new(conn);
    let t = repo.get(ticket_id)?;
    let Some(dest) = destination_of(&t) else {
        return Ok(t);
    };
    let Ok(tracker) = trackers.for_destination(&dest) else {
        return Ok(t);
    };
    debug_assert_eq!(tracker.kind(), kind_of(t.provider));
    let status = tracker.fetch_status(&dest, &t.external_id)?;
    repo.set_status(ticket_id, status)
}

/// Sync every ticket of a team, best effort. Returns how many were synced; tickets whose tracker
/// is not configured or failed are skipped (TS counted the unconfigured ones as synced).
///
/// # Errors
/// Database failure listing the tickets.
pub fn sync_all(conn: &Connection, trackers: &TrackerSet, team_id: &str) -> Result<usize> {
    let mut n = 0;
    for b in list_for_team(conn, team_id, &BoardFilter::default())? {
        let Some(dest) = destination_of(&b.ticket) else {
            continue;
        };
        if trackers.for_destination(&dest).is_err() {
            continue;
        }
        if sync_status(conn, trackers, &b.ticket.id).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Manual status change (`PATCH /tickets/:id/status`).
///
/// # Errors
/// [`Error::NotFound`].
pub fn update_status(conn: &Connection, ticket_id: &str, status: TicketStatus) -> Result<Ticket> {
    SqliteTickets::new(conn).set_status(ticket_id, status)
}

/// Webhook-driven change: every ticket with this provider + external id (ids are per-repo, so a
/// webhook for repo A can only be matched by id alone if the caller passes `external_url_prefix`
/// to disambiguate; `None` reproduces the TS behaviour of matching on id alone). Returns the
/// updated tickets (TS returned the first or null).
///
/// # Errors
/// Database failure.
pub fn update_status_by_external_id(
    conn: &Connection,
    provider: TicketProvider,
    external_id: &str,
    external_url_prefix: Option<&str>,
    status: TicketStatus,
) -> Result<Vec<Ticket>> {
    let repo = SqliteTickets::new(conn);
    let mut s = conn.prepare(
        "SELECT id FROM tickets WHERE provider = ?1 AND external_id = ?2
           AND (?3 IS NULL OR external_url LIKE ?3 || '%') ORDER BY created_at, rowid",
    )?;
    let ids: Vec<String> = s
        .query_map(params![provider, external_id, external_url_prefix], |r| {
            r.get(0)
        })?
        .collect::<std::result::Result<_, _>>()?;
    ids.iter()
        .map(|i| repo.set_status(i, status))
        .collect::<Result<Vec<_>>>()
        .map_err(|e| match e {
            Error::NotFound(m) => Error::NotFound(m),
            other => other,
        })
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use crate::model::NewTicket;
    use crate::tickets::tracker::FakeTracker;
    use crate::vcs::testutil::{doc, fx};
    use std::sync::Arc;

    #[test]
    fn repo_extraction_matches_ts_and_extends() {
        use TicketProvider as P;
        let gh = "https://github.com/acme/web/issues/12";
        assert_eq!(extract_repo_name(gh, P::Github), "acme/web");
        assert_eq!(
            extract_repo_url(gh, P::Github),
            "https://github.com/acme/web"
        );
        let jira = "https://acme.atlassian.net/browse/PROJ-123";
        assert_eq!(extract_repo_name(jira, P::Jira), "PROJ");
        assert_eq!(
            extract_repo_url(jira, P::Jira),
            "https://acme.atlassian.net"
        );
        assert_eq!(
            extract_repo_name("https://acme.atlassian.net/browse/A1_B-7", P::Jira),
            "A1_B"
        );
        assert_eq!(
            extract_repo_name("https://acme.atlassian.net/browse/lower-1", P::Jira),
            ""
        );
        assert_eq!(extract_repo_name("not a url", P::Github), "");
        assert_eq!(extract_repo_url("not a url", P::Jira), "");
        let gl = "https://gitlab.com/grp/sub/proj/-/issues/3";
        assert_eq!(extract_repo_name(gl, P::Gitlab), "grp/sub/proj");
        assert_eq!(
            extract_repo_url(gl, P::Gitlab),
            "https://gitlab.com/grp/sub/proj"
        );
        let bb = "https://bitbucket.org/ws/repo/issues/9";
        assert_eq!(extract_repo_name(bb, P::Bitbucket), "ws/repo");
    }

    #[test]
    fn destination_roundtrip_from_ticket() {
        let mk = |p, url: &str| Ticket {
            id: "t".into(),
            document_id: "d".into(),
            provider: p,
            external_id: "1".into(),
            external_url: url.into(),
            title: String::new(),
            body: String::new(),
            status: TicketStatus::Open,
            insights: None,
            created_by_id: "u".into(),
            created_at: 0,
            updated_at: 0,
        };
        assert_eq!(
            destination_of(&mk(
                TicketProvider::Github,
                "https://github.com/acme/web/issues/1"
            )),
            Some(Destination::Github {
                owner: "acme".into(),
                repo: "web".into()
            })
        );
        assert_eq!(
            destination_of(&mk(
                TicketProvider::Gitlab,
                "https://gitlab.com/g/s/p/-/issues/1"
            )),
            Some(Destination::Gitlab {
                owner: "g/s".into(),
                repo: "p".into()
            })
        );
        assert_eq!(
            destination_of(&mk(
                TicketProvider::Jira,
                "https://x.atlassian.net/browse/PROJ-1"
            )),
            Some(Destination::Jira {
                project_key: "PROJ".into()
            })
        );
        assert_eq!(destination_of(&mk(TicketProvider::Github, "junk")), None);
    }

    fn add(
        f: &crate::vcs::testutil::Fx,
        doc_id: &str,
        p: TicketProvider,
        ext: &str,
        url: &str,
    ) -> Ticket {
        SqliteTickets::new(f.db.conn())
            .create(&NewTicket {
                document_id: doc_id.into(),
                provider: p,
                external_id: ext.into(),
                external_url: url.into(),
                title: format!("T{ext}"),
                body: String::new(),
                insights: None,
                created_by_id: f.user.id.clone(),
            })
            .unwrap()
    }

    #[test]
    fn list_filters_and_enriches() {
        let f = fx();
        let d = doc(&f, "content");
        add(
            &f,
            &d.id,
            TicketProvider::Github,
            "1",
            "https://github.com/acme/web/issues/1",
        );
        let j = add(
            &f,
            &d.id,
            TicketProvider::Jira,
            "PROJ-2",
            "https://x.atlassian.net/browse/PROJ-2",
        );
        update_status(f.db.conn(), &j.id, TicketStatus::Closed).unwrap();
        let c = f.db.conn();
        let all = list_for_team(c, &f.team.id, &BoardFilter::default()).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|b| b.document_title == "Spec"));
        // (tickets created in the same millisecond have no stable relative order)
        let gh_row = all
            .iter()
            .find(|b| b.ticket.provider == TicketProvider::Github)
            .unwrap();
        assert_eq!(gh_row.repo_name, "acme/web");
        assert_eq!(gh_row.repo_url, "https://github.com/acme/web");
        let closed = list_for_team(
            c,
            &f.team.id,
            &BoardFilter {
                status: Some(TicketStatus::Closed),
                provider: None,
            },
        )
        .unwrap();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].repo_name, "PROJ");
        let gh = list_for_team(
            c,
            &f.team.id,
            &BoardFilter {
                status: None,
                provider: Some(TicketProvider::Github),
            },
        )
        .unwrap();
        assert_eq!(gh.len(), 1);
        assert!(list_for_team(c, "other-team", &BoardFilter::default())
            .unwrap()
            .is_empty());
        assert!(matches!(
            update_status(c, "nope", TicketStatus::Open),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn sync_status_from_tracker_and_skips_unconfigured() {
        let f = fx();
        let d = doc(&f, "content");
        let t = add(
            &f,
            &d.id,
            TicketProvider::Github,
            "7",
            "https://github.com/acme/web/issues/7",
        );
        let j = add(
            &f,
            &d.id,
            TicketProvider::Jira,
            "PROJ-2",
            "https://x.atlassian.net/browse/PROJ-2",
        );
        let gh = Arc::new(FakeTracker::new(TrackerKind::Github));
        gh.set_status("7", TicketStatus::Closed);
        let set = TrackerSet::new().with(gh);
        let c = f.db.conn();
        assert_eq!(
            sync_status(c, &set, &t.id).unwrap().status,
            TicketStatus::Closed
        );
        // Jira has no tracker: unchanged, not an error.
        assert_eq!(
            sync_status(c, &set, &j.id).unwrap().status,
            TicketStatus::Open
        );
        assert_eq!(sync_all(c, &set, &f.team.id).unwrap(), 1);
        assert!(matches!(
            sync_status(c, &set, "nope"),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn linear_tickets_reach_the_board_and_sync() {
        use TicketProvider as P;
        let url = "https://linear.app/acme/issue/ENG-42/fix-login";
        assert_eq!(extract_repo_name(url, P::Linear), "acme");
        assert_eq!(extract_repo_url(url, P::Linear), "https://linear.app/acme");
        assert_eq!(extract_repo_name("https://linear.app/acme", P::Linear), "");

        let f = fx();
        let d = doc(&f, "content");
        let t = add(&f, &d.id, P::Linear, "ENG-42", url);
        let c = f.db.conn();
        let rows = list_for_team(
            c,
            &f.team.id,
            &BoardFilter {
                status: None,
                provider: Some(P::Linear),
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].repo_name, "acme");
        assert_eq!(
            destination_of(&t),
            Some(Destination::Linear {
                team_id: "ENG".into()
            })
        );

        let lin = Arc::new(FakeTracker::new(TrackerKind::Linear));
        lin.set_status("ENG-42", TicketStatus::InProgress);
        let set = TrackerSet::new().with(lin);
        assert_eq!(
            sync_status(c, &set, &t.id).unwrap().status,
            TicketStatus::InProgress
        );
        assert_eq!(sync_all(c, &set, &f.team.id).unwrap(), 1);
        // an id with no team prefix cannot be turned back into a destination
        let odd = add(&f, &d.id, P::Linear, "42", url);
        assert_eq!(destination_of(&odd), None);
    }

    #[test]
    fn webhook_update_by_external_id_can_be_scoped() {
        let f = fx();
        let d = doc(&f, "content");
        add(
            &f,
            &d.id,
            TicketProvider::Github,
            "5",
            "https://github.com/acme/web/issues/5",
        );
        add(
            &f,
            &d.id,
            TicketProvider::Github,
            "5",
            "https://github.com/acme/api/issues/5",
        );
        let c = f.db.conn();
        let all = update_status_by_external_id(
            c,
            TicketProvider::Github,
            "5",
            None,
            TicketStatus::Closed,
        )
        .unwrap();
        assert_eq!(all.len(), 2); // id alone is ambiguous across repos
        let scoped = update_status_by_external_id(
            c,
            TicketProvider::Github,
            "5",
            Some("https://github.com/acme/api/"),
            TicketStatus::InProgress,
        )
        .unwrap();
        assert_eq!(scoped.len(), 1);
        assert!(update_status_by_external_id(
            c,
            TicketProvider::Jira,
            "x",
            None,
            TicketStatus::Open
        )
        .unwrap()
        .is_empty());
    }
}
