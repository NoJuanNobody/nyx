//! Blocking, SSRF-guarded [`HttpTransport`] over `ureq`.
//!
//! # What it guarantees
//!
//! - **Every URL is vetted.** `UrlPolicy::strict()` (https only, no credentials in the URL, public
//!   addresses only, no internal host names) runs on the request URL and again on every redirect
//!   target. `http://`, loopback, RFC 1918, link-local and cloud-metadata addresses are refused
//!   with [`NetError::Blocked`] before any socket is opened.
//! - **DNS answers are pinned.** `ureq` is built with a custom resolver, so the addresses the
//!   guard vetted are the addresses the socket connects to (no second lookup, no rebinding
//!   window). A host that resolves to even one forbidden address is refused. Hostnames the guard
//!   did not vet cannot be resolved at all (fail closed).
//! - **Redirects are followed by us, not by `ureq`.** Max 3 hops, no https to http downgrade,
//!   `Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key` and any `*token*` header are
//!   dropped when the next hop is a different origin (scheme, host or port), `301`/`302`/`303`
//!   turn the request into a body-less `GET`, and a request body is never replayed to another
//!   origin.
//! - **Bounded.** Response bodies are capped ([`DEFAULT_MAX_RESPONSE_BYTES`], 16 MiB) and a
//!   `Content-Length` over the cap is refused without reading. One overall deadline covers all
//!   hops (request `timeout_secs`, else [`NetConfig::default_timeout`]).
//! - **Honest errors.** Non-2xx is a normal [`HttpResponse`]; headers (including `Retry-After`,
//!   read with [`HttpResponse::retry_after_secs`]) are preserved. Only the lack of a response is a
//!   [`NetError`]. Error text never contains request headers or the URL query.
//!
//! # Proxies
//!
//! `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` (and `NO_PROXY`) are honoured by default
//! ([`NetConfig::use_env_proxy`]). The proxy itself is trusted configuration and is not subject
//! to the policy. **Through a proxy the proxy resolves the target host, so DNS pinning cannot
//! apply**: only the syntactic checks (scheme, literal IPs, internal names) protect the target.
//!
//! # Not covered
//!
//! No system trust store (embedded Mozilla roots only, so a TLS-intercepting corporate proxy needs
//! its CA added in a follow-up), no HTTP/2, no cookie jar, no response decompression (no
//! `Accept-Encoding` is sent), and loopback hosts such as a local Ollama are refused by design.

use std::collections::HashSet;
use std::io;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use nyx_core::net::{
    is_sensitive_header, Headers, HttpMethod, HttpRequest, HttpResponse, HttpTransport, NetError,
};
use nyx_core::security::ssrf::{Resolver, UrlPolicy, MAX_REDIRECTS};
use ureq::http;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver as UreqResolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use ureq::AsSendBody;
use url::Url;

/// Default response body cap: 16 MiB.
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// Tunables of [`UreqTransport`]. The SSRF policy is deliberately not configurable here: it is
/// always `UrlPolicy::strict()`, optionally narrowed with [`Self::allowed_hosts`].
#[derive(Debug, Clone)]
pub struct NetConfig {
    /// `User-Agent` sent when the request has none. Default `nyx/<version>`.
    pub user_agent: String,
    /// TCP connect (and DNS) timeout per hop.
    pub connect_timeout: Duration,
    /// Overall deadline when the request sets no `timeout_secs`.
    pub default_timeout: Duration,
    /// Largest response body accepted.
    pub max_response_bytes: usize,
    /// Redirect hops followed (clamped to the guard's maximum of 3). `0` returns 3xx as is.
    pub max_redirects: usize,
    /// Read `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` from the environment.
    pub use_env_proxy: bool,
    /// Optional host allow-list (exact or subdomain match), applied on top of the strict policy.
    pub allowed_hosts: Option<Vec<String>>,
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            user_agent: crate::USER_AGENT.to_owned(),
            connect_timeout: Duration::from_secs(10),
            default_timeout: Duration::from_secs(60),
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            max_redirects: MAX_REDIRECTS,
            use_env_proxy: true,
            allowed_hosts: None,
        }
    }
}

impl NetConfig {
    /// Restrict outbound requests to these hosts (and their subdomains).
    #[must_use]
    pub fn allowed_hosts(mut self, hosts: &[&str]) -> Self {
        self.allowed_hosts = Some(hosts.iter().map(|h| h.to_ascii_lowercase()).collect());
        self
    }

    /// Ignore proxy environment variables.
    #[must_use]
    pub fn without_env_proxy(mut self) -> Self {
        self.use_env_proxy = false;
        self
    }

    /// Set the response body cap.
    #[must_use]
    pub fn max_response_bytes(mut self, n: usize) -> Self {
        self.max_response_bytes = n;
        self
    }
}

/// Real [`HttpTransport`]. Cheap to share: wrap in an `Arc` (the agent pools connections).
pub struct UreqTransport {
    agent: ureq::Agent,
    cfg: NetConfig,
    policy: UrlPolicy,
}

impl std::fmt::Debug for UreqTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UreqTransport")
            .field("user_agent", &self.cfg.user_agent)
            .field("max_response_bytes", &self.cfg.max_response_bytes)
            .field("max_redirects", &self.cfg.max_redirects)
            .finish_non_exhaustive()
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new(NetConfig::default())
    }
}

impl UreqTransport {
    /// Production transport: strict SSRF policy.
    #[must_use]
    pub fn new(cfg: NetConfig) -> Self {
        let mut policy = UrlPolicy::strict();
        policy.allowed_hosts.clone_from(&cfg.allowed_hosts);
        Self::build(cfg, policy)
    }

    /// TEST ONLY. Allows plain `http` and loopback so the unit tests can talk to a mock server on
    /// `127.0.0.1`. Compiled out of every non-test build: no configuration, feature or API can
    /// switch the guard off in a release.
    #[cfg(test)]
    pub(crate) fn allow_loopback_for_tests(cfg: NetConfig) -> Self {
        let mut policy = UrlPolicy::allow_loopback_http();
        policy.allowed_hosts.clone_from(&cfg.allowed_hosts);
        Self::build(cfg.without_env_proxy(), policy)
    }

    fn build(cfg: NetConfig, policy: UrlPolicy) -> Self {
        let proxy = if cfg.use_env_proxy {
            ureq::Proxy::try_from_env()
        } else {
            None
        };
        let resolver = GuardedResolver {
            policy: policy.clone(),
            proxy_authority: proxy
                .as_ref()
                .and_then(|p| p.uri().authority().map(|a| a.as_str().to_ascii_lowercase())),
        };
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .https_only(false) // scheme policy is enforced by `UrlPolicy`
            .proxy(proxy)
            .user_agent(cfg.user_agent.as_str())
            .timeout_connect(Some(cfg.connect_timeout))
            .timeout_global(Some(cfg.default_timeout))
            .build();
        let agent = ureq::Agent::with_parts(config, DefaultConnector::default(), resolver);
        Self { agent, cfg, policy }
    }

    fn blocked(e: nyx_core::Error) -> NetError {
        match e {
            nyx_core::Error::Invalid(m) => NetError::Blocked(m),
            other => NetError::Blocked(other.to_string()),
        }
    }

    /// One hop: no redirect handling.
    fn hop(
        &self,
        method: HttpMethod,
        url: &Url,
        headers: &Headers,
        body: Option<&[u8]>,
        remaining: Duration,
    ) -> Result<HttpResponse, NetError> {
        let mut b = http::Request::builder()
            .method(method.as_str())
            .uri(url.as_str());
        for (k, v) in headers.iter() {
            // Framing headers are owned by the HTTP layer.
            if ["content-length", "transfer-encoding", "connection", "host"]
                .iter()
                .any(|h| k.eq_ignore_ascii_case(h))
            {
                continue;
            }
            b = b.header(k, v);
        }
        let result = match body {
            Some(bytes) => self.run(b.body(bytes.to_vec()), remaining),
            None => self.run(b.body(()), remaining),
        };
        let resp = result?;
        let (parts, mut rbody) = resp.into_parts();
        let status = parts.status.as_u16();
        let out_headers = Headers::from_pairs(parts.headers.iter().map(|(k, v)| {
            (
                k.as_str(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        }));
        if (300..400).contains(&status) {
            // Redirect bodies are never needed; dropping the body closes the connection.
            return Ok(HttpResponse::new(status, out_headers, Vec::new()));
        }
        let cap = self.cfg.max_response_bytes;
        if out_headers
            .get("content-length")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .is_some_and(|n| n > cap as u64)
        {
            return Err(NetError::TooLarge { limit: cap });
        }
        let bytes = rbody
            .with_config()
            .limit(cap as u64)
            .read_to_vec()
            .map_err(map_ureq_error)?;
        Ok(HttpResponse::new(status, out_headers, bytes))
    }

    fn run<B: AsSendBody>(
        &self,
        request: Result<http::Request<B>, http::Error>,
        remaining: Duration,
    ) -> Result<http::Response<ureq::Body>, NetError> {
        let request = request.map_err(|e| NetError::Blocked(format!("malformed request: {e}")))?;
        let request = self
            .agent
            .configure_request(request)
            .timeout_global(Some(remaining))
            .build();
        self.agent.run(request).map_err(map_ureq_error)
    }
}

impl HttpTransport for UreqTransport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, NetError> {
        let started = Instant::now();
        let budget = req
            .timeout_secs
            .map_or(self.cfg.default_timeout, Duration::from_secs);
        let max_hops = self.cfg.max_redirects.min(MAX_REDIRECTS);

        let mut method = req.method;
        let mut headers = req.headers.clone();
        let mut body = req.body.clone();
        let mut target = self.policy.check_url(&req.url).map_err(Self::blocked)?;

        for hop in 0..=max_hops {
            let remaining = budget.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(NetError::Transport("timed out".into()));
            }
            let resp = self.hop(method, &target.url, &headers, body.as_deref(), remaining)?;
            if !matches!(resp.status, 301 | 302 | 303 | 307 | 308) {
                return Ok(resp);
            }
            let Some(location) = resp.headers.get("location").map(str::to_owned) else {
                return Ok(resp);
            };
            if hop == max_hops {
                return if max_hops == 0 {
                    Ok(resp)
                } else {
                    Err(NetError::Blocked("too many redirects".into()))
                };
            }
            let next = self
                .policy
                .check_redirect(&target.url, &location, hop)
                .map_err(Self::blocked)?;
            let same_origin = same_origin(&target.url, &next.url);
            if !same_origin {
                strip_cross_origin(&mut headers);
            }
            match resp.status {
                301..=303 if method != HttpMethod::Get => {
                    method = HttpMethod::Get;
                    drop_body(&mut headers, &mut body);
                }
                301..=303 => drop_body(&mut headers, &mut body),
                _ => {
                    // 307/308 replay method and body, but never to another origin.
                    if body.is_some() && !same_origin {
                        return Err(NetError::Blocked(
                            "refusing to replay a request body to a different origin".into(),
                        ));
                    }
                }
            }
            target = next;
        }
        Err(NetError::Blocked("too many redirects".into()))
    }
}

fn drop_body(headers: &mut Headers, body: &mut Option<Vec<u8>>) {
    *body = None;
    headers.remove("content-type");
    headers.remove("content-length");
}

/// Same scheme, host and port.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Remove every credential-bearing header (see [`is_sensitive_header`]).
fn strip_cross_origin(headers: &mut Headers) {
    let names: HashSet<String> = headers
        .iter()
        .filter(|(k, _)| is_sensitive_header(k))
        .map(|(k, _)| k.to_owned())
        .collect();
    for n in names {
        headers.remove(&n);
    }
}

fn map_ureq_error(e: ureq::Error) -> NetError {
    match e {
        ureq::Error::Timeout(t) => NetError::Transport(format!("timed out ({t})")),
        ureq::Error::BodyExceedsLimit(limit) => NetError::TooLarge {
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
        },
        ureq::Error::HostNotFound => NetError::Transport("host not found".into()),
        ureq::Error::Io(io) if io.kind() == io::ErrorKind::PermissionDenied => {
            let msg = io.to_string();
            if msg.contains("dns failure") {
                NetError::Transport(msg)
            } else {
                NetError::Blocked(msg)
            }
        }
        other => NetError::Transport(other.to_string()),
    }
}

// ---------------------------------------------------------------- DNS pinning

/// Resolve `uri` through the guard: every address must pass; the vetted addresses are returned.
///
/// # Errors
/// [`io::ErrorKind::PermissionDenied`] when the guard refuses; other kinds for DNS failures.
fn pin(policy: &UrlPolicy, uri: &str, resolver: &dyn Resolver) -> io::Result<Vec<SocketAddr>> {
    policy
        .resolve_pinned(uri, resolver)
        .map(|p| p.addrs)
        .map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, e.to_string()))
}

/// Blocking system resolver with a deadline (a stuck resolver must not outlive the request).
struct DeadlineResolver {
    limit: Option<Duration>,
}

impl Resolver for DeadlineResolver {
    fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
        let query = format!("{host}:{port}");
        let lookup = move || -> io::Result<Vec<IpAddr>> {
            Ok(query.to_socket_addrs()?.map(|a| a.ip()).collect())
        };
        let Some(limit) = self.limit else {
            return lookup();
        };
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || tx.send(lookup()).ok());
        rx.recv_timeout(limit)
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "dns lookup timed out"))?
    }
}

/// `ureq` resolver that only ever returns guard-vetted addresses.
#[derive(Debug)]
struct GuardedResolver {
    policy: UrlPolicy,
    /// `host[:port]` of the configured proxy, which is trusted operator configuration.
    proxy_authority: Option<String>,
}

impl UreqResolver for GuardedResolver {
    fn resolve(
        &self,
        uri: &http::Uri,
        _config: &ureq::config::Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let authority = uri
            .authority()
            .ok_or_else(|| ureq::Error::BadUri("no authority".into()))?;
        let limit = timeout.not_zero().map(|d| *d);
        let resolver = DeadlineResolver { limit };
        let addrs = if self.proxy_authority.as_deref()
            == Some(authority.as_str().to_ascii_lowercase().as_str())
        {
            let port = authority.port_u16().unwrap_or(80);
            resolver
                .resolve(authority.host(), port)?
                .into_iter()
                .map(|ip| SocketAddr::new(ip, port))
                .collect()
        } else {
            pin(&self.policy, &uri.to_string(), &resolver)?
        };
        let mut out = ResolvedSocketAddrs::from_fn(|_| SocketAddr::from(([0, 0, 0, 0], 0)));
        for a in addrs.into_iter().take(16) {
            out.push(a);
        }
        if out.is_empty() {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests;
