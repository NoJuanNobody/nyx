#![allow(clippy::unwrap_used, clippy::expect_used, clippy::too_many_lines)]

use std::collections::HashMap;
use std::sync::Arc;

use super::*;
use crate::testutil::{MockServer, Reply, Req};

fn local() -> UreqTransport {
    UreqTransport::allow_loopback_for_tests(NetConfig::default())
}

fn get(url: &str) -> HttpRequest {
    HttpRequest::new(HttpMethod::Get, url)
}

fn ok_server() -> MockServer {
    MockServer::start(|_| Reply::new(200, "ok"))
}

// ---------------------------------------------------------------- basics

#[test]
fn get_roundtrip_sends_default_user_agent_and_returns_status_headers_body() {
    let srv = MockServer::start(|_| Reply::new(200, r#"{"a":1}"#).header("X-Thing", "yes"));
    let resp = local()
        .send(&get(&srv.url("/v1/x?q=1")).header("Accept", "application/json"))
        .unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.text(), r#"{"a":1}"#);
    assert_eq!(resp.headers.get("x-thing"), Some("yes"));
    let seen = &srv.requests()[0];
    assert_eq!(seen.method, "GET");
    assert_eq!(seen.target, "/v1/x?q=1");
    assert_eq!(seen.header("accept"), Some("application/json"));
    let ua = seen.header("user-agent").unwrap();
    assert_eq!(ua, concat!("nyx/", env!("CARGO_PKG_VERSION")));
    assert_eq!(ua, crate::USER_AGENT);
}

#[test]
fn caller_user_agent_wins_and_all_verbs_with_bodies_work() {
    let srv = MockServer::start(|r| Reply::new(200, format!("{} {}", r.method, r.body.len())));
    let t = local();
    for (m, name) in [
        (HttpMethod::Post, "POST"),
        (HttpMethod::Put, "PUT"),
        (HttpMethod::Patch, "PATCH"),
        (HttpMethod::Delete, "DELETE"),
    ] {
        let r = HttpRequest::new(m, srv.url("/x"))
            .header("User-Agent", "custom/1")
            .json(&serde_json::json!({"k": "v"}));
        let resp = t.send(&r).unwrap();
        assert_eq!(resp.text(), format!("{name} 9"));
    }
    let reqs = srv.requests();
    assert!(reqs
        .iter()
        .all(|r| r.header("user-agent") == Some("custom/1")));
    assert!(reqs
        .iter()
        .all(|r| r.header("content-type") == Some("application/json")));
    assert_eq!(reqs[0].body, br#"{"k":"v"}"#);
}

#[test]
fn non_2xx_is_a_response_not_an_error_and_retry_after_is_surfaced() {
    let srv = MockServer::start(|r| match r.target.as_str() {
        "/limited" => Reply::new(429, "slow down").header("Retry-After", "7"),
        "/date" => Reply::new(503, "").header("Retry-After", "Wed, 21 Oct 2099 07:28:00 GMT"),
        _ => Reply::new(404, "nope"),
    });
    let t = local();
    let r = t.send(&get(&srv.url("/limited"))).unwrap();
    assert_eq!(r.status, 429);
    assert!(!r.is_success());
    assert_eq!(r.retry_after_secs(), Some(7));
    assert_eq!(r.text(), "slow down");
    // HTTP-date form is converted to seconds from now (far future: large, not None)
    let r = t.send(&get(&srv.url("/date"))).unwrap();
    assert!(r.retry_after_secs().unwrap() > 86_400);
    let r = t.send(&get(&srv.url("/missing"))).unwrap();
    assert_eq!((r.status, r.retry_after_secs()), (404, None));
}

#[test]
fn connection_refused_is_a_transport_error() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let e = local()
        .send(&get(&format!("http://127.0.0.1:{port}/")).with_timeout(5))
        .unwrap_err();
    assert!(matches!(e, NetError::Transport(_)), "{e:?}");
}

// ---------------------------------------------------------------- size cap and timeout

#[test]
fn content_length_over_the_cap_is_refused_and_under_the_cap_passes() {
    let srv = MockServer::start(|r| {
        let n = if r.target == "/big" { 2000 } else { 50 };
        Reply::new(200, vec![b'x'; n])
    });
    let t = UreqTransport::allow_loopback_for_tests(NetConfig::default().max_response_bytes(1000));
    assert_eq!(t.send(&get(&srv.url("/small"))).unwrap().body.len(), 50);
    assert_eq!(
        t.send(&get(&srv.url("/big"))).unwrap_err(),
        NetError::TooLarge { limit: 1000 }
    );
}

#[test]
fn an_unframed_stream_is_cut_off_at_the_cap() {
    let srv = MockServer::start(|_| Reply::new(200, vec![b'y'; 50_000]).unframed());
    let t = UreqTransport::allow_loopback_for_tests(NetConfig::default().max_response_bytes(1000));
    assert_eq!(
        t.send(&get(&srv.url("/stream"))).unwrap_err(),
        NetError::TooLarge { limit: 1000 }
    );
}

#[test]
fn a_slow_server_times_out_at_the_request_deadline() {
    let srv = MockServer::start(|_| Reply::new(200, "late").delay(Duration::from_secs(4)));
    let started = Instant::now();
    let e = local()
        .send(&get(&srv.url("/slow")).with_timeout(1))
        .unwrap_err();
    assert!(
        matches!(&e, NetError::Transport(m) if m.contains("timed out")),
        "{e:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn the_deadline_spans_redirect_hops() {
    let a = MockServer::start(|_| Reply::new(200, "end").delay(Duration::from_secs(4)));
    let a_url = a.url("/end");
    let b = MockServer::start(move |_| Reply::redirect(302, &a_url));
    let started = Instant::now();
    let e = local()
        .send(&get(&b.url("/start")).with_timeout(1))
        .unwrap_err();
    assert!(matches!(e, NetError::Transport(_)));
    assert!(started.elapsed() < Duration::from_secs(3));
}

// ---------------------------------------------------------------- redirects

fn creds(r: HttpRequest) -> HttpRequest {
    r.header("Authorization", "Bearer sekrit")
        .header("X-Api-Key", "key")
        .header("Cookie", "s=1")
        .header("X-Auth-Token", "tok")
        .header("Accept", "text/plain")
}

fn echo_headers(r: &Req) -> Reply {
    let names = [
        "authorization",
        "x-api-key",
        "cookie",
        "x-auth-token",
        "accept",
    ];
    let got: Vec<String> = names
        .iter()
        .map(|n| format!("{n}={}", r.header(n).unwrap_or("-")))
        .collect();
    Reply::new(200, got.join(";"))
}

#[test]
fn same_origin_redirect_keeps_credentials_and_follows_relative_locations() {
    let srv = MockServer::start(|r| match r.target.as_str() {
        "/a" => Reply::redirect(302, "/b"),
        _ => echo_headers(r),
    });
    let resp = local().send(&creds(get(&srv.url("/a")))).unwrap();
    assert_eq!(
        resp.text(),
        "authorization=Bearer sekrit;x-api-key=key;cookie=s=1;x-auth-token=tok;accept=text/plain"
    );
    assert_eq!(srv.requests().len(), 2);
}

#[test]
fn cross_origin_redirect_strips_every_credential_header_but_keeps_the_rest() {
    let dest = MockServer::start(echo_headers);
    let dest_url = dest.url("/landing");
    let origin = MockServer::start(move |_| Reply::redirect(302, &dest_url));
    let resp = local().send(&creds(get(&origin.url("/go")))).unwrap();
    assert_eq!(
        resp.text(),
        "authorization=-;x-api-key=-;cookie=-;x-auth-token=-;accept=text/plain"
    );
    // the first hop did receive them
    let first = &origin.requests()[0];
    assert_eq!(first.header("authorization"), Some("Bearer sekrit"));
    assert_eq!(dest.requests()[0].header("authorization"), None);
}

#[test]
fn post_becomes_get_without_body_on_302_and_303() {
    for status in [302, 303] {
        let dest = MockServer::start(|r| {
            Reply::new(
                200,
                format!(
                    "{} len={} ct={}",
                    r.method,
                    r.body.len(),
                    r.header("content-type").unwrap_or("-")
                ),
            )
        });
        let dest_url = dest.url("/d");
        let origin = MockServer::start(move |_| Reply::redirect(status, &dest_url));
        let req =
            HttpRequest::new(HttpMethod::Post, origin.url("/p")).json(&serde_json::json!({"a": 1}));
        let resp = local().send(&req).unwrap();
        assert_eq!(resp.text(), "GET len=0 ct=-", "status {status}");
        assert_eq!(origin.requests()[0].body.len(), 7);
    }
}

#[test]
fn a_307_replays_method_and_body_on_the_same_origin_only() {
    let srv = MockServer::start(|r| match r.target.as_str() {
        "/p" => Reply::redirect(307, "/q"),
        _ => Reply::new(
            200,
            format!("{} {}", r.method, String::from_utf8_lossy(&r.body)),
        ),
    });
    let req = HttpRequest::new(HttpMethod::Put, srv.url("/p")).with_body("payload");
    assert_eq!(local().send(&req).unwrap().text(), "PUT payload");

    let dest = MockServer::start(|_| Reply::new(200, "should not be reached"));
    let dest_url = dest.url("/steal");
    let origin = MockServer::start(move |_| Reply::redirect(307, &dest_url));
    let req = HttpRequest::new(HttpMethod::Post, origin.url("/p")).with_body("secret body");
    let e = local().send(&req).unwrap_err();
    assert!(
        matches!(&e, NetError::Blocked(m) if m.contains("different origin")),
        "{e:?}"
    );
    assert!(dest.requests().is_empty());
}

#[test]
fn redirect_loops_stop_after_three_hops() {
    let srv = MockServer::start(|_| Reply::redirect(302, "/again"));
    let e = local().send(&get(&srv.url("/again"))).unwrap_err();
    assert!(
        matches!(&e, NetError::Blocked(m) if m.contains("too many redirects")),
        "{e:?}"
    );
    assert_eq!(
        srv.requests().len(),
        4,
        "first request plus three followed hops"
    );
}

#[test]
fn zero_redirects_returns_the_3xx_response() {
    let srv = MockServer::start(|_| Reply::redirect(302, "/elsewhere"));
    let cfg = NetConfig {
        max_redirects: 0,
        ..NetConfig::default()
    };
    let r = UreqTransport::allow_loopback_for_tests(cfg)
        .send(&get(&srv.url("/")))
        .unwrap();
    assert_eq!(
        (r.status, r.headers.get("location")),
        (302, Some("/elsewhere"))
    );
}

#[test]
fn redirect_without_location_is_returned_as_is() {
    let srv = MockServer::start(|_| Reply::new(304, ""));
    assert_eq!(local().send(&get(&srv.url("/"))).unwrap().status, 304);
}

#[test]
fn redirects_to_forbidden_targets_are_blocked_before_connecting() {
    for target in [
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/admin",
        "file:///etc/passwd",
        "http://user:pw@127.0.0.1:1/",
    ] {
        let t = target.to_owned();
        let srv = MockServer::start(move |_| Reply::redirect(302, &t));
        let e = local().send(&get(&srv.url("/"))).unwrap_err();
        assert!(matches!(e, NetError::Blocked(_)), "{target}: {e:?}");
    }
}

// ---------------------------------------------------------------- SSRF guard on the production transport

#[test]
fn the_production_transport_refuses_loopback_http_and_odd_schemes_without_connecting() {
    let srv = ok_server();
    let prod = UreqTransport::new(NetConfig::default().without_env_proxy());
    for url in [
        srv.url("/"),                                      // http + loopback
        format!("https://127.0.0.1:{}/", srv.addr.port()), // https + loopback
        "https://localhost/".to_owned(),
        "https://[::1]/".to_owned(),
        "https://169.254.169.254/latest/meta-data".to_owned(),
        "https://192.168.1.1/".to_owned(),
        "https://2130706433/".to_owned(), // decimal-encoded 127.0.0.1
        "https://metadata.google.internal/".to_owned(),
        "https://intranet/".to_owned(),
        "ftp://example.com/".to_owned(),
        "https://user:pw@example.com/".to_owned(),
    ] {
        let e = prod.send(&get(&url)).unwrap_err();
        assert!(matches!(e, NetError::Blocked(_)), "{url}: {e:?}");
    }
    assert!(srv.requests().is_empty(), "nothing reached the server");
}

#[test]
fn host_allow_list_narrows_the_policy() {
    let prod = UreqTransport::new(
        NetConfig::default()
            .without_env_proxy()
            .allowed_hosts(&["api.example.com"]),
    );
    let e = prod.send(&get("https://evil.example.org/")).unwrap_err();
    assert!(
        matches!(&e, NetError::Blocked(m) if m.contains("allow-list")),
        "{e:?}"
    );
}

struct FakeDns(HashMap<&'static str, Vec<&'static str>>);
impl Resolver for FakeDns {
    fn resolve(&self, host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
        self.0
            .get(host)
            .map(|v| v.iter().map(|s| s.parse().unwrap()).collect())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "nxdomain"))
    }
}

#[test]
fn dns_answers_are_vetted_and_the_vetted_addresses_are_what_we_connect_to() {
    let dns = FakeDns(HashMap::from([
        ("good.example.com", vec!["93.184.216.34"]),
        ("rebind.example.com", vec!["93.184.216.34", "10.0.0.7"]),
        ("meta.example.com", vec!["169.254.169.254"]),
        ("lo.example.com", vec!["127.0.0.1"]),
    ]));
    let p = UrlPolicy::strict();
    let addrs = pin(&p, "https://good.example.com/x", &dns).unwrap();
    assert_eq!(addrs, vec![SocketAddr::from(([93, 184, 216, 34], 443))]);
    for host in ["rebind", "meta", "lo"] {
        let e = pin(&p, &format!("https://{host}.example.com/"), &dns).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::PermissionDenied, "{host}");
    }
    // an unresolvable name is a DNS failure, reported as transport, not as a policy block
    let e = pin(&p, "https://nx.example.com/", &dns).unwrap_err();
    assert!(e.to_string().contains("dns failure"));
    assert!(matches!(
        map_ureq_error(ureq::Error::Io(e)),
        NetError::Transport(_)
    ));
    let blocked = pin(&p, "https://meta.example.com/", &dns).unwrap_err();
    assert!(matches!(
        map_ureq_error(ureq::Error::Io(blocked)),
        NetError::Blocked(_)
    ));
}

#[test]
fn the_resolver_fails_closed_for_unvetted_hosts_and_trusts_only_the_configured_proxy() {
    let r = GuardedResolver {
        policy: UrlPolicy::strict(),
        proxy_authority: Some("127.0.0.1:3128".into()),
    };
    let cfg = ureq::config::Config::default();
    let never = NextTimeout::default();
    // the configured proxy (loopback!) resolves; the same address as a target does not
    let proxy = r
        .resolve(&"http://127.0.0.1:3128/".parse().unwrap(), &cfg, never)
        .unwrap();
    assert_eq!(proxy[0], SocketAddr::from(([127, 0, 0, 1], 3128)));
    assert!(r
        .resolve(&"https://127.0.0.1:3129/".parse().unwrap(), &cfg, never)
        .is_err());
    assert!(r
        .resolve(&"https://10.1.2.3/".parse().unwrap(), &cfg, never)
        .is_err());
}

#[test]
fn origin_and_header_helpers() {
    let u = |s: &str| Url::parse(s).unwrap();
    assert!(same_origin(
        &u("https://a.com/x"),
        &u("https://A.com:443/y")
    ));
    assert!(!same_origin(
        &u("https://a.com/"),
        &u("https://a.com:8443/")
    ));
    assert!(!same_origin(&u("https://a.com/"), &u("https://b.com/")));
    assert!(!same_origin(&u("http://a.com/"), &u("https://a.com/")));
    let mut h = Headers::from_pairs([
        ("Authorization", "x"),
        ("proxy-authorization", "x"),
        ("Cookie", "x"),
        ("X-Api-Key", "x"),
        ("X-Session-Token", "x"),
        ("Accept", "keep"),
    ]);
    strip_cross_origin(&mut h);
    assert_eq!(h.len(), 1);
    assert_eq!(h.get("accept"), Some("keep"));
}

#[test]
fn debug_output_has_no_secrets_and_is_object_safe() {
    let t: Arc<dyn HttpTransport> = Arc::new(local());
    let d = format!("{t:?}");
    assert!(d.contains("UreqTransport") && d.contains("nyx/"));
}
