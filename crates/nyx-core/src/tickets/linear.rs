//! Linear ticket adapter: GraphQL `issueCreate` mutation builder + response parser, and a thin
//! [`LinearTracker`] over an [`HttpTransport`].
//!
//! Linear authenticates a personal API key with a bare `Authorization: <key>` header (no
//! `Bearer`; OAuth tokens use `Bearer`). Labels are not sent: Linear wants label *ids*, which the
//! pipeline does not have; they are appended to the description instead.
//!
//! Request shapes follow Linear's public GraphQL schema and are covered by fixture tests; they
//! have not been exercised against a live workspace.

use std::sync::Arc;

use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};

use super::sprint::{SprintItem, SprintOrigin, SprintSnapshot, SprintSource, SprintStatus};
use super::tracker::{
    check_response, title_key, Destination, NewIssue, RemoteIssue, TicketTracker, TrackerError,
    TrackerKind,
};
use crate::model::TicketStatus;
use crate::net::{HttpMethod, HttpRequest, HttpResponse, HttpTransport};

/// Default GraphQL endpoint.
pub const LINEAR_ENDPOINT: &str = "https://api.linear.app/graphql";

/// `issueCreate` mutation document.
pub const CREATE_MUTATION: &str = "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }";

/// Issue-by-identifier query (state type drives the status mapping).
pub const ISSUE_QUERY: &str =
    "query Issue($id: String!) { issue(id: $id) { id identifier title url state { name type } } }";

/// Title search within a team.
pub const SEARCH_QUERY: &str = "query Find($teamId: ID!, $title: String!) { issues(first: 50, filter: { team: { id: { eq: $teamId } }, title: { containsIgnoreCase: $title } }) { nodes { id identifier title url } } }";

/// Body text sent to Linear: the markdown plus a trailing label line (see module docs).
#[must_use]
pub fn description_with_labels(issue: &NewIssue) -> String {
    if issue.labels.is_empty() {
        return issue.body.clone();
    }
    let labels = issue
        .labels
        .iter()
        .map(|l| format!("`{l}`"))
        .collect::<Vec<_>>()
        .join(" ");
    if issue.body.trim().is_empty() {
        format!("Labels: {labels}")
    } else {
        format!("{}\n\nLabels: {labels}", issue.body.trim_end())
    }
}

fn graphql(endpoint: &str, key: &SecretString, query: &str, variables: &Value) -> HttpRequest {
    HttpRequest::new(HttpMethod::Post, endpoint)
        .header("Authorization", key.expose_secret())
        .header("Accept", "application/json")
        .json(&json!({"query": query, "variables": variables}))
}

/// `issueCreate` request for a team.
#[must_use]
pub fn create_issue_request(
    endpoint: &str,
    key: &SecretString,
    team_id: &str,
    issue: &NewIssue,
) -> HttpRequest {
    graphql(
        endpoint,
        key,
        CREATE_MUTATION,
        &json!({"input": {
            "teamId": team_id,
            "title": issue.title,
            "description": description_with_labels(issue),
        }}),
    )
}

/// GraphQL errors arrive with HTTP 200; surface them.
fn data_of(resp: HttpResponse) -> Result<Value, TrackerError> {
    let resp = check_response(resp)?;
    let v: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| TrackerError::Parse(format!("linear: {e}")))?;
    if let Some(errs) = v
        .get("errors")
        .and_then(Value::as_array)
        .filter(|e| !e.is_empty())
    {
        let msg = errs
            .iter()
            .filter_map(|e| e.get("message").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("; ");
        let auth = errs.iter().any(|e| {
            matches!(
                e.pointer("/extensions/code").and_then(Value::as_str),
                Some("AUTHENTICATION_ERROR" | "FORBIDDEN")
            )
        });
        let ratelimited = errs
            .iter()
            .any(|e| e.pointer("/extensions/code").and_then(Value::as_str) == Some("RATELIMITED"));
        return Err(if auth {
            TrackerError::Auth(msg)
        } else if ratelimited {
            TrackerError::RateLimited {
                retry_after_secs: None,
            }
        } else {
            TrackerError::Rejected {
                status: 200,
                body: msg,
            }
        });
    }
    v.get("data")
        .cloned()
        .filter(|d| !d.is_null())
        .ok_or_else(|| TrackerError::Parse("linear: response has no data".into()))
}

fn remote(n: &Value) -> Option<RemoteIssue> {
    Some(RemoteIssue {
        kind: TrackerKind::Linear,
        external_id: n.get("identifier")?.as_str()?.to_owned(),
        external_url: n.get("url")?.as_str()?.to_owned(),
        title: n
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    })
}

/// Parse an `issueCreate` response.
///
/// # Errors
/// GraphQL errors, `success: false`, or a missing identifier / url.
pub fn parse_create_response(resp: HttpResponse) -> Result<RemoteIssue, TrackerError> {
    let data = data_of(resp)?;
    let payload = data
        .get("issueCreate")
        .ok_or_else(|| TrackerError::Parse("linear: no issueCreate in response".into()))?;
    if payload.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(TrackerError::Rejected {
            status: 200,
            body: "issueCreate returned success=false".into(),
        });
    }
    payload
        .get("issue")
        .and_then(remote)
        .ok_or_else(|| TrackerError::Parse("linear: issueCreate has no issue".into()))
}

/// Issue lookup request (`id` may be a uuid or an identifier like `ENG-42`).
#[must_use]
pub fn get_issue_request(endpoint: &str, key: &SecretString, id: &str) -> HttpRequest {
    graphql(endpoint, key, ISSUE_QUERY, &json!({"id": id}))
}

/// Map a Linear workflow state type to Nyx's states: `completed` / `canceled` -> closed,
/// `started` -> in progress, everything else (`triage`, `backlog`, `unstarted`) -> open.
#[must_use]
pub fn map_state_type(t: &str) -> TicketStatus {
    match t {
        "completed" | "canceled" => TicketStatus::Closed,
        "started" => TicketStatus::InProgress,
        _ => TicketStatus::Open,
    }
}

/// Parse an issue lookup into a status.
///
/// # Errors
/// GraphQL errors, or `issue: null` (Linear answers an unknown id with an error, but a null is
/// handled too).
pub fn parse_status_response(resp: HttpResponse) -> Result<TicketStatus, TrackerError> {
    let data = data_of(resp)?;
    let t = data
        .pointer("/issue/state/type")
        .and_then(Value::as_str)
        .ok_or_else(|| TrackerError::Parse("linear: issue has no state type".into()))?;
    Ok(map_state_type(t))
}

/// Title search request for a team.
#[must_use]
pub fn search_request(
    endpoint: &str,
    key: &SecretString,
    team_id: &str,
    title: &str,
) -> HttpRequest {
    graphql(
        endpoint,
        key,
        SEARCH_QUERY,
        &json!({"teamId": team_id, "title": title}),
    )
}

/// Parse a title search, keeping the first exact (whitespace / case-insensitive) title match.
///
/// # Errors
/// GraphQL errors or a malformed body.
pub fn parse_search_response(
    resp: HttpResponse,
    title: &str,
) -> Result<Option<RemoteIssue>, TrackerError> {
    let data = data_of(resp)?;
    let nodes = data
        .pointer("/issues/nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| TrackerError::Parse("linear: no issues.nodes".into()))?;
    let want = title_key(title);
    Ok(nodes
        .iter()
        .filter_map(remote)
        .find(|r| title_key(&r.title) == want))
}

/// [`TicketTracker`] for Linear.
#[derive(Debug, Clone)]
pub struct LinearTracker {
    key: SecretString,
    transport: Arc<dyn HttpTransport>,
    endpoint: String,
}

impl LinearTracker {
    /// New tracker against [`LINEAR_ENDPOINT`].
    #[must_use]
    pub fn new(api_key: SecretString, transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            key: api_key,
            transport,
            endpoint: LINEAR_ENDPOINT.into(),
        }
    }

    /// Override the endpoint (tests, proxies).
    #[must_use]
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    fn team(dest: &Destination) -> Result<&str, TrackerError> {
        match dest {
            Destination::Linear { team_id } => Ok(team_id),
            other => Err(TrackerError::Invalid(format!(
                "linear tracker cannot post to {}",
                other.key()
            ))),
        }
    }

    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TrackerError> {
        self.transport
            .send(req)
            .map_err(|e| TrackerError::Transport(e.to_string()))
    }
}

impl TicketTracker for LinearTracker {
    fn kind(&self) -> TrackerKind {
        TrackerKind::Linear
    }

    fn create_issue(
        &self,
        dest: &Destination,
        issue: &NewIssue,
    ) -> Result<RemoteIssue, TrackerError> {
        let team = Self::team(dest)?;
        let req = create_issue_request(&self.endpoint, &self.key, team, issue);
        parse_create_response(self.send(&req)?)
    }

    fn find_by_title(
        &self,
        dest: &Destination,
        title: &str,
    ) -> Result<Option<RemoteIssue>, TrackerError> {
        let team = Self::team(dest)?;
        let req = search_request(&self.endpoint, &self.key, team, title);
        parse_search_response(self.send(&req)?, title)
    }

    fn fetch_status(
        &self,
        _dest: &Destination,
        external_id: &str,
    ) -> Result<TicketStatus, TrackerError> {
        let req = get_issue_request(&self.endpoint, &self.key, external_id);
        parse_status_response(self.send(&req)?)
    }
}

/// Team issues query for the sprint view (active cycle if there is one, else the team backlog is
/// not fetched: `cycle` filter keeps this to "current sprint").
pub const CYCLE_QUERY: &str = "query Cycle($teamId: String!) { team(id: $teamId) { activeCycle { name number issues(first: 100) { nodes { identifier title labels { nodes { name } } state { type } } } } } }";

/// Active-cycle request for a team.
#[must_use]
pub fn cycle_request(endpoint: &str, key: &SecretString, team_id: &str) -> HttpRequest {
    graphql(endpoint, key, CYCLE_QUERY, &json!({"teamId": team_id}))
}

/// Parse the active cycle into a snapshot; `None` when the team has no active cycle.
///
/// # Errors
/// GraphQL errors or a malformed body.
pub fn parse_cycle_response(resp: HttpResponse) -> Result<Option<SprintSnapshot>, TrackerError> {
    let data = data_of(resp)?;
    let team = data
        .get("team")
        .ok_or_else(|| TrackerError::Parse("linear: no team in response".into()))?;
    let Some(cycle) = team.get("activeCycle").filter(|c| !c.is_null()) else {
        return Ok(None);
    };
    let nodes = cycle
        .pointer("/issues/nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| TrackerError::Parse("linear: cycle has no issues".into()))?;
    let name = cycle
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| cycle.get("number").map(|n| format!("Cycle {n}")))
        .unwrap_or_else(|| "Linear Cycle".into());
    let items = nodes
        .iter()
        .filter_map(|n| {
            Some(SprintItem {
                key: n.get("identifier")?.as_str()?.to_owned(),
                title: n.get("title")?.as_str()?.to_owned(),
                labels: n
                    .pointer("/labels/nodes")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|l| {
                                l.get("name").and_then(Value::as_str).map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                status: match n.pointer("/state/type").and_then(Value::as_str) {
                    Some("completed" | "canceled") => SprintStatus::Done,
                    Some("started") => SprintStatus::InProgress,
                    _ => SprintStatus::Todo,
                },
            })
        })
        .collect();
    Ok(Some(SprintSnapshot {
        name,
        items,
        origin: SprintOrigin::Linear,
    }))
}

/// [`SprintSource`] over a Linear team's active cycle.
#[derive(Debug, Clone)]
pub struct LinearSprintSource {
    key: SecretString,
    transport: Arc<dyn HttpTransport>,
    endpoint: String,
    team_id: String,
}

impl LinearSprintSource {
    /// New source.
    #[must_use]
    pub fn new(key: SecretString, transport: Arc<dyn HttpTransport>, team_id: String) -> Self {
        Self {
            key,
            transport,
            endpoint: LINEAR_ENDPOINT.into(),
            team_id,
        }
    }
}

impl SprintSource for LinearSprintSource {
    fn origin(&self) -> SprintOrigin {
        SprintOrigin::Linear
    }

    fn fetch(&self) -> Result<Option<SprintSnapshot>, TrackerError> {
        let req = cycle_request(&self.endpoint, &self.key, &self.team_id);
        let resp = self
            .transport
            .send(&req)
            .map_err(|e| TrackerError::Transport(e.to_string()))?;
        parse_cycle_response(resp)
    }
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use crate::git_provider::{FakeTransport, Headers};

    fn key() -> SecretString {
        SecretString::from("lin_api_secret")
    }

    fn issue() -> NewIssue {
        NewIssue {
            title: "Add login".into(),
            body: "Body".into(),
            labels: vec!["backend".into()],
        }
    }

    fn resp(body: &str) -> HttpResponse {
        HttpResponse::new(200, Headers::new(), body)
    }

    #[test]
    fn create_request_fixture() {
        let req = create_issue_request(LINEAR_ENDPOINT, &key(), "team-1", &issue());
        assert_eq!(req.url, LINEAR_ENDPOINT);
        assert_eq!(req.headers.get("authorization"), Some("lin_api_secret"));
        let b: Value = serde_json::from_str(&req.body_text().unwrap()).unwrap();
        assert!(b["query"].as_str().unwrap().contains("issueCreate"));
        assert_eq!(b["variables"]["input"]["teamId"], "team-1");
        assert_eq!(b["variables"]["input"]["title"], "Add login");
        assert_eq!(
            b["variables"]["input"]["description"],
            "Body\n\nLabels: `backend`"
        );
        // Debug never leaks the key.
        assert!(!format!("{req:?}").contains("lin_api_secret"));
    }

    #[test]
    fn description_label_folding() {
        let mut i = issue();
        i.labels.clear();
        assert_eq!(description_with_labels(&i), "Body");
        i.labels = vec!["a".into(), "b".into()];
        i.body = String::new();
        assert_eq!(description_with_labels(&i), "Labels: `a` `b`");
    }

    #[test]
    fn parse_create_fixture_and_failures() {
        let ok = resp(
            r#"{"data":{"issueCreate":{"success":true,"issue":{"id":"u1","identifier":"ENG-42","title":"Add login","url":"https://linear.app/acme/issue/ENG-42/add-login"}}}}"#,
        );
        let r = parse_create_response(ok).unwrap();
        assert_eq!(r.external_id, "ENG-42");
        assert_eq!(
            r.external_url,
            "https://linear.app/acme/issue/ENG-42/add-login"
        );
        assert_eq!(r.kind, TrackerKind::Linear);

        let not_ok = resp(r#"{"data":{"issueCreate":{"success":false,"issue":null}}}"#);
        assert!(matches!(
            parse_create_response(not_ok),
            Err(TrackerError::Rejected { .. })
        ));
        let gql_err = resp(
            r#"{"errors":[{"message":"Argument Validation Error","extensions":{"code":"INVALID_INPUT"}}],"data":null}"#,
        );
        match parse_create_response(gql_err).unwrap_err() {
            TrackerError::Rejected { body, .. } => assert!(body.contains("Validation")),
            e => panic!("{e:?}"),
        }
        let auth =
            resp(r#"{"errors":[{"message":"nope","extensions":{"code":"AUTHENTICATION_ERROR"}}]}"#);
        assert!(matches!(
            parse_create_response(auth),
            Err(TrackerError::Auth(_))
        ));
        let rl = resp(r#"{"errors":[{"message":"slow","extensions":{"code":"RATELIMITED"}}]}"#);
        assert!(parse_create_response(rl).unwrap_err().retryable());
        assert!(matches!(
            parse_create_response(resp("not json")),
            Err(TrackerError::Parse(_))
        ));
        assert!(matches!(
            parse_create_response(resp(r#"{"data":{}}"#)),
            Err(TrackerError::Parse(_))
        ));
        assert!(matches!(
            parse_create_response(HttpResponse::new(401, Headers::new(), "")),
            Err(TrackerError::Auth(_))
        ));
    }

    #[test]
    fn state_type_mapping() {
        assert_eq!(map_state_type("completed"), TicketStatus::Closed);
        assert_eq!(map_state_type("canceled"), TicketStatus::Closed);
        assert_eq!(map_state_type("started"), TicketStatus::InProgress);
        assert_eq!(map_state_type("unstarted"), TicketStatus::Open);
        assert_eq!(map_state_type("backlog"), TicketStatus::Open);
        assert_eq!(map_state_type("triage"), TicketStatus::Open);
        let r = resp(
            r#"{"data":{"issue":{"identifier":"ENG-1","state":{"name":"In Review","type":"started"}}}}"#,
        );
        assert_eq!(parse_status_response(r).unwrap(), TicketStatus::InProgress);
        assert!(parse_status_response(resp(r#"{"data":{"issue":null}}"#)).is_err());
    }

    #[test]
    fn search_matches_exact_title() {
        let r = resp(
            r#"{"data":{"issues":{"nodes":[{"identifier":"ENG-1","title":"Add login page","url":"u1"},{"identifier":"ENG-2","title":"add  LOGIN","url":"u2"}]}}}"#,
        );
        assert_eq!(
            parse_search_response(r, "Add login")
                .unwrap()
                .unwrap()
                .external_id,
            "ENG-2"
        );
        let r = resp(r#"{"data":{"issues":{"nodes":[]}}}"#);
        assert!(parse_search_response(r, "x").unwrap().is_none());
    }

    #[test]
    fn cycle_parsing() {
        let r = resp(
            r#"{"data":{"team":{"activeCycle":{"name":null,"number":7,"issues":{"nodes":[
                {"identifier":"ENG-1","title":"A","labels":{"nodes":[{"name":"bug"}]},"state":{"type":"started"}},
                {"identifier":"ENG-2","title":"B","labels":{"nodes":[]},"state":{"type":"canceled"}},
                {"identifier":"ENG-3","title":"C","state":{"type":"backlog"}}]}}}}}"#,
        );
        let snap = parse_cycle_response(r).unwrap().unwrap();
        assert_eq!(snap.name, "Cycle 7");
        let st: Vec<_> = snap.items.iter().map(|i| i.status).collect();
        assert_eq!(
            st,
            [
                SprintStatus::InProgress,
                SprintStatus::Done,
                SprintStatus::Todo
            ]
        );
        assert_eq!(snap.items[0].labels, ["bug"]);
        let none = resp(r#"{"data":{"team":{"activeCycle":null}}}"#);
        assert!(parse_cycle_response(none).unwrap().is_none());
        assert!(parse_cycle_response(resp(r#"{"data":{}}"#)).is_err());
    }

    #[test]
    fn tracker_over_fake_transport() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(
            200,
            &[],
            r#"{"data":{"issueCreate":{"success":true,"issue":{"identifier":"ENG-9","title":"Add login","url":"https://linear.app/x"}}}}"#,
        );
        let tracker = LinearTracker::new(key(), t.clone()).with_endpoint("https://proxy.test/gql");
        let dest = Destination::Linear {
            team_id: "team-1".into(),
        };
        let r = tracker.create_issue(&dest, &issue()).unwrap();
        assert_eq!(r.external_id, "ENG-9");
        assert_eq!(t.requests()[0].url, "https://proxy.test/gql");
        assert!(matches!(
            tracker.create_issue(
                &Destination::Jira {
                    project_key: "P".into()
                },
                &issue()
            ),
            Err(TrackerError::Invalid(_))
        ));
    }
}
