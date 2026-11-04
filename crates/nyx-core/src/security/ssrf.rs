//! SSRF guard for every outbound URL the core or a plugin wants to fetch.
//!
//! Design (threat model T-NET-1..3):
//! 1. [`UrlPolicy::check_url`] is a pure syntactic gate: scheme, no userinfo, port allow-list,
//!    optional host allow-list, literal IPs classified, well-known internal names refused.
//!    The `url` crate (WHATWG) normalises decimal/hex/octal/short IPv4 spellings
//!    (`2130706433`, `0x7f.1`, `127.1`) into real IPs before classification.
//! 2. [`UrlPolicy::resolve_pinned`] resolves the host through an injectable [`Resolver`] and
//!    requires EVERY returned address to pass, then returns a [`PinnedTarget`]. **The HTTP client
//!    must connect to those exact addresses** (keeping `Host`/SNI from the URL). Resolving twice
//!    (check, then let the client resolve again) is the DNS-rebinding hole this design closes.
//! 3. Redirects are re-checked hop by hop with [`UrlPolicy::check_redirect`], capped at
//!    [`MAX_REDIRECTS`].
//!
//! Always blocked, regardless of policy: link-local (incl. cloud metadata `169.254.169.254`,
//! `fd00:ec2::254`, `100.100.100.200`), unspecified, multicast, broadcast, reserved/documentation
//! ranges. IPv4-mapped, compatible, NAT64, 6to4 and Teredo IPv6 forms are unwrapped and the embedded
//! IPv4 is classified.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

use url::{Host, Url};

use crate::{Error, Result};

/// Maximum redirect hops a caller should follow.
pub const MAX_REDIRECTS: usize = 3;

/// Coarse address class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpClass {
    /// Globally routable.
    Public,
    /// `127.0.0.0/8`, `::1`.
    Loopback,
    /// RFC 1918, CGNAT, ULA: reachable only inside a LAN.
    Private,
    /// Never allowed (metadata, link-local, multicast, reserved...).
    Blocked(&'static str),
}

fn classify_v4(ip: Ipv4Addr) -> IpClass {
    let [a, b, c, _] = ip.octets();
    if ip.octets() == [169, 254, 169, 254]
        || ip.octets() == [100, 100, 100, 200]
        || ip.octets() == [192, 0, 0, 192]
    {
        return IpClass::Blocked("cloud metadata endpoint");
    }
    match (a, b, c) {
        (0, ..) => IpClass::Blocked("unspecified/this-network"),
        (127, ..) => IpClass::Loopback,
        (10, ..) | (192, 168, _) | (172, 16..=31, _) | (100, 64..=127, _) => IpClass::Private,
        (169, 254, _) => IpClass::Blocked("link-local"),
        (192, 0, 0 | 2) | (198, 51, 100) | (203, 0, 113) | (192, 88, 99) => {
            IpClass::Blocked("reserved/documentation")
        }
        (198, 18 | 19, _) => IpClass::Blocked("benchmarking"),
        (224..=239, ..) => IpClass::Blocked("multicast"),
        (240..=255, ..) => IpClass::Blocked("reserved/broadcast"),
        _ => IpClass::Public,
    }
}

fn embedded_v4(seg: [u16; 8], start: usize) -> Ipv4Addr {
    let hi = seg[start].to_be_bytes();
    let lo = seg[start + 1].to_be_bytes();
    Ipv4Addr::new(hi[0], hi[1], lo[0], lo[1])
}

fn classify_v6(ip: Ipv6Addr) -> IpClass {
    let s = ip.segments();
    if ip.is_unspecified() {
        return IpClass::Blocked("unspecified");
    }
    if ip.is_loopback() {
        return IpClass::Loopback;
    }
    // ::ffff:a.b.c.d (mapped)
    if s[..5] == [0; 5] && s[5] == 0xffff {
        return classify_v4(embedded_v4(s, 6));
    }
    // ::a.b.c.d (deprecated IPv4-compatible)
    if s[..6] == [0; 6] {
        return classify_v4(embedded_v4(s, 6));
    }
    // 64:ff9b::/96 NAT64 well-known prefix
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        return classify_v4(embedded_v4(s, 6));
    }
    if s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1 {
        return IpClass::Blocked("local-use NAT64");
    }
    // 2002::/16 6to4: embedded v4 is s[1], s[2]
    if s[0] == 0x2002 {
        return match classify_v4(embedded_v4(s, 1)) {
            IpClass::Public => IpClass::Blocked("6to4 relay"),
            other => other,
        };
    }
    // 2001::/32 Teredo
    if s[0] == 0x2001 && s[1] == 0 {
        return IpClass::Blocked("teredo");
    }
    if s[0] == 0x2001 && s[1] == 0x0db8 {
        return IpClass::Blocked("documentation");
    }
    if s[0] == 0x0100 && s[1..4] == [0; 3] {
        return IpClass::Blocked("discard-only");
    }
    if s == [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254] {
        return IpClass::Blocked("cloud metadata endpoint");
    }
    match s[0] {
        0xfe80..=0xfebf => IpClass::Blocked("link-local"),
        0xfec0..=0xfeff => IpClass::Blocked("site-local"),
        0xff00..=0xffff => IpClass::Blocked("multicast"),
        0xfc00..=0xfdff => IpClass::Private,
        _ => IpClass::Public,
    }
}

/// Classify any IP address (IPv6 forms embedding IPv4 are unwrapped).
#[must_use]
pub fn classify_ip(ip: IpAddr) -> IpClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

/// What an outbound request is allowed to reach.
#[derive(Debug, Clone)]
pub struct UrlPolicy {
    /// Permit plain `http` (default: https only).
    pub allow_http: bool,
    /// Permit loopback targets (e.g. a local Ollama). Default false.
    pub allow_loopback: bool,
    /// Permit RFC 1918 / CGNAT / ULA targets. Default false.
    pub allow_private: bool,
    /// If set, only these ports (default: 80/443 implied by scheme only when `None` is replaced).
    pub allowed_ports: Option<Vec<u16>>,
    /// If set, the host must equal or be a subdomain of one of these (lowercase).
    pub allowed_hosts: Option<Vec<String>>,
}

impl Default for UrlPolicy {
    fn default() -> Self {
        Self::strict()
    }
}

/// A URL that passed [`UrlPolicy::check_url`].
#[derive(Debug, Clone)]
pub struct UrlTarget {
    /// Parsed, normalised URL.
    pub url: Url,
    /// Effective port.
    pub port: u16,
}

/// A URL plus the vetted socket addresses the client must connect to.
#[derive(Debug, Clone)]
pub struct PinnedTarget {
    /// The checked target.
    pub target: UrlTarget,
    /// Vetted addresses: connect ONLY to these.
    pub addrs: Vec<SocketAddr>,
}

/// Name resolution seam (DNS in production, a map in tests).
pub trait Resolver {
    /// Resolve `host` to IP addresses.
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>>;
}

/// OS resolver (`getaddrinfo`). Blocking.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok((host, port).to_socket_addrs()?.map(|a| a.ip()).collect())
    }
}

fn blocked(msg: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("url blocked: {msg}"))
}

const INTERNAL_SUFFIXES: [&str; 6] = [
    ".localhost",
    ".local",
    ".internal",
    ".localdomain",
    ".home.arpa",
    ".lan",
];

impl UrlPolicy {
    /// https only, public addresses only.
    #[must_use]
    pub fn strict() -> Self {
        Self {
            allow_http: false,
            allow_loopback: false,
            allow_private: false,
            allowed_ports: None,
            allowed_hosts: None,
        }
    }

    /// Strict, but also allow `http(s)://localhost`-style loopback (local model servers).
    #[must_use]
    pub fn allow_loopback_http() -> Self {
        Self {
            allow_http: true,
            allow_loopback: true,
            ..Self::strict()
        }
    }

    /// Restrict to a host allow-list (exact or subdomain match).
    #[must_use]
    pub fn with_hosts(mut self, hosts: &[&str]) -> Self {
        self.allowed_hosts = Some(hosts.iter().map(|h| h.to_ascii_lowercase()).collect());
        self
    }

    fn ip_allowed(&self, ip: IpAddr) -> Result<()> {
        match classify_ip(ip) {
            IpClass::Public => Ok(()),
            IpClass::Loopback if self.allow_loopback => Ok(()),
            IpClass::Private if self.allow_private => Ok(()),
            IpClass::Loopback => Err(blocked(format!("{ip} is loopback"))),
            IpClass::Private => Err(blocked(format!("{ip} is a private-network address"))),
            IpClass::Blocked(why) => Err(blocked(format!("{ip}: {why}"))),
        }
    }

    /// Syntactic check. Does not touch the network.
    pub fn check_url(&self, raw: &str) -> Result<UrlTarget> {
        if raw.len() > 4096 || raw.chars().any(char::is_control) {
            return Err(blocked("malformed"));
        }
        let url = Url::parse(raw.trim()).map_err(|e| blocked(format!("unparsable ({e})")))?;
        match url.scheme() {
            "https" => {}
            "http" if self.allow_http => {}
            s => return Err(blocked(format!("scheme `{s}` not allowed"))),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(blocked("credentials in URL"));
        }
        let port = url
            .port_or_known_default()
            .ok_or_else(|| blocked("no port"))?;
        if let Some(ports) = &self.allowed_ports {
            if !ports.contains(&port) {
                return Err(blocked(format!("port {port} not allowed")));
            }
        }
        let host = url.host().ok_or_else(|| blocked("no host"))?;
        match host {
            Host::Ipv4(ip) => self.ip_allowed(IpAddr::V4(ip))?,
            Host::Ipv6(ip) => self.ip_allowed(IpAddr::V6(ip))?,
            Host::Domain(d) => self.check_domain(d)?,
        }
        Ok(UrlTarget { url, port })
    }

    fn check_domain(&self, d: &str) -> Result<()> {
        let d = d.trim_end_matches('.').to_ascii_lowercase();
        if d.is_empty() {
            return Err(blocked("empty host"));
        }
        if let Some(list) = &self.allowed_hosts {
            let ok = list
                .iter()
                .any(|h| d == *h || d.ends_with(&format!(".{h}")));
            if !ok {
                return Err(blocked(format!("host `{d}` not in allow-list")));
            }
        }
        let is_localhost = d == "localhost" || d.ends_with(".localhost");
        if is_localhost && !self.allow_loopback {
            return Err(blocked("localhost"));
        }
        if !is_localhost && !self.allow_private {
            if d == "metadata.google.internal"
                || d == "metadata"
                || INTERNAL_SUFFIXES.iter().any(|s| d.ends_with(s))
            {
                return Err(blocked(format!("internal hostname `{d}`")));
            }
            // Single-label names resolve via search domains to internal hosts.
            if !d.contains('.') {
                return Err(blocked(format!("single-label hostname `{d}`")));
            }
        }
        Ok(())
    }

    /// Check, resolve, and vet every address. Connect only to [`PinnedTarget::addrs`].
    pub fn resolve_pinned(&self, raw: &str, resolver: &dyn Resolver) -> Result<PinnedTarget> {
        let target = self.check_url(raw)?;
        let port = target.port;
        let ips: Vec<IpAddr> = match target.url.host().ok_or_else(|| blocked("no host"))? {
            Host::Ipv4(ip) => vec![IpAddr::V4(ip)],
            Host::Ipv6(ip) => vec![IpAddr::V6(ip)],
            Host::Domain(d) => {
                // `localhost` resolves via the OS; pin it to loopback explicitly when permitted.
                let d = d.trim_end_matches('.');
                resolver
                    .resolve(d, port)
                    .map_err(|e| blocked(format!("dns failure ({e})")))?
            }
        };
        if ips.is_empty() {
            return Err(blocked("host did not resolve"));
        }
        // Every answer must pass: one private A record among public ones is a rebinding trick.
        for ip in &ips {
            self.ip_allowed(*ip)?;
        }
        let addrs = ips
            .into_iter()
            .map(|ip| SocketAddr::new(ip, port))
            .collect();
        Ok(PinnedTarget { target, addrs })
    }

    /// Validate a redirect `Location` (absolute or relative to `from`) after `hops` redirects.
    pub fn check_redirect(&self, from: &Url, location: &str, hops: usize) -> Result<UrlTarget> {
        if hops >= MAX_REDIRECTS {
            return Err(blocked("too many redirects"));
        }
        let next = from
            .join(location)
            .map_err(|e| blocked(format!("bad redirect ({e})")))?;
        if from.scheme() == "https" && next.scheme() != "https" {
            return Err(blocked("https to http downgrade"));
        }
        self.check_url(next.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Fake(HashMap<&'static str, Vec<&'static str>>);
    impl Resolver for Fake {
        fn resolve(&self, host: &str, _port: u16) -> std::io::Result<Vec<IpAddr>> {
            self.0
                .get(host)
                .map(|v| v.iter().map(|s| s.parse().unwrap()).collect())
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "nxdomain"))
        }
    }

    fn ip(s: &str) -> IpClass {
        classify_ip(s.parse().unwrap())
    }

    #[test]
    fn ipv4_ranges() {
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
        ] {
            assert_eq!(ip(s), IpClass::Public, "{s}");
        }
        for s in ["127.0.0.1", "127.255.255.254"] {
            assert_eq!(ip(s), IpClass::Loopback, "{s}");
        }
        for s in [
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.255.255",
        ] {
            assert_eq!(ip(s), IpClass::Private, "{s}");
        }
        for s in [
            "0.0.0.0",
            "169.254.169.254",
            "169.254.0.1",
            "100.100.100.200",
            "192.0.0.192",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
            "203.0.113.9",
        ] {
            assert!(matches!(ip(s), IpClass::Blocked(_)), "{s}");
        }
    }

    #[test]
    fn ipv6_ranges_and_embedded_v4() {
        assert_eq!(ip("2606:4700:4700::1111"), IpClass::Public);
        assert_eq!(ip("::1"), IpClass::Loopback);
        assert!(matches!(ip("::"), IpClass::Blocked(_)));
        assert!(matches!(ip("fe80::1"), IpClass::Blocked(_)));
        assert!(matches!(ip("febf::1"), IpClass::Blocked(_)));
        assert!(matches!(ip("ff02::1"), IpClass::Blocked(_)));
        assert!(matches!(ip("fd00:ec2::254"), IpClass::Blocked(_)));
        assert_eq!(ip("fd12:3456::1"), IpClass::Private);
        assert_eq!(ip("fc00::1"), IpClass::Private);
        assert!(matches!(ip("2001:db8::1"), IpClass::Blocked(_)));
        assert!(matches!(
            ip("2001:0:4136:e378:8000:63bf:3fff:fdd2"),
            IpClass::Blocked(_)
        ));
        // mapped / compatible / NAT64 / 6to4 embedding
        assert_eq!(ip("::ffff:127.0.0.1"), IpClass::Loopback);
        assert_eq!(ip("::ffff:7f00:1"), IpClass::Loopback);
        assert_eq!(ip("::ffff:10.1.2.3"), IpClass::Private);
        assert!(matches!(ip("::ffff:169.254.169.254"), IpClass::Blocked(_)));
        assert_eq!(ip("::ffff:8.8.8.8"), IpClass::Public);
        assert_eq!(ip("::127.0.0.1"), IpClass::Loopback);
        assert!(matches!(ip("64:ff9b::a9fe:a9fe"), IpClass::Blocked(_)));
        assert_eq!(ip("64:ff9b::808:808"), IpClass::Public);
        assert_eq!(ip("2002:7f00:1::"), IpClass::Loopback);
        assert!(matches!(ip("2002:0808:0808::"), IpClass::Blocked(_)));
    }

    #[test]
    fn url_gate_basics() {
        let p = UrlPolicy::strict();
        assert!(p.check_url("https://example.com/path?q=1").is_ok());
        for bad in [
            "http://example.com",
            "ftp://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "https://user:pw@example.com",
            "https://user@example.com",
            "https://localhost/",
            "https://LOCALHOST./",
            "https://a.localhost/",
            "https://printer.local/",
            "https://metadata.google.internal/",
            "https://intranet/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[::ffff:a9fe:a9fe]/",
            "https://169.254.169.254/latest/meta-data",
            "https://[fd00:ec2::254]/",
            "https://10.0.0.5/",
            "https://0.0.0.0/",
            "",
            "not a url",
        ] {
            assert!(p.check_url(bad).is_err(), "should block {bad:?}");
        }
    }

    #[test]
    fn obfuscated_ipv4_spellings_are_normalised_and_blocked() {
        let p = UrlPolicy::strict();
        for bad in [
            "https://2130706433/",
            "https://0x7f000001/",
            "https://0x7f.0.0.1/",
            "https://017700000001/",
            "https://127.1/",
            "https://0/",
            "https://2852039166/",
            "https://0xA9FEA9FE/",
        ] {
            assert!(p.check_url(bad).is_err(), "should block {bad:?}");
        }
    }

    #[test]
    fn loopback_policy_opt_in_but_metadata_never() {
        let p = UrlPolicy::allow_loopback_http();
        assert!(p.check_url("http://localhost:11434/api").is_ok());
        assert!(p.check_url("http://127.0.0.1:8080").is_ok());
        assert!(p.check_url("http://[::1]:8080").is_ok());
        assert!(p.check_url("http://10.0.0.1").is_err());
        assert!(p.check_url("http://169.254.169.254").is_err());
        let lan = UrlPolicy {
            allow_private: true,
            ..UrlPolicy::strict()
        };
        assert!(lan.check_url("https://192.168.0.2").is_ok());
        assert!(lan.check_url("https://169.254.169.254").is_err());
    }

    #[test]
    fn ports_and_hosts() {
        let p = UrlPolicy {
            allowed_ports: Some(vec![443]),
            ..UrlPolicy::strict()
        }
        .with_hosts(&["api.example.com"]);
        assert!(p.check_url("https://api.example.com/x").is_ok());
        assert!(p.check_url("https://v2.api.example.com/x").is_ok());
        assert!(p.check_url("https://evilapi.example.com/x").is_err());
        assert!(p.check_url("https://api.example.com.evil.io/x").is_err());
        assert!(p.check_url("https://api.example.com:8443/x").is_err());
    }

    #[test]
    fn dns_pinning_requires_all_answers_public() {
        let r = Fake(HashMap::from([
            (
                "ok.example.com",
                vec!["93.184.216.34", "2606:2800:220:1::1"],
            ),
            ("rebind.example.com", vec!["93.184.216.34", "127.0.0.1"]),
            ("meta.example.com", vec!["169.254.169.254"]),
            ("mapped.example.com", vec!["::ffff:10.0.0.1"]),
            ("empty.example.com", vec![]),
        ]));
        let p = UrlPolicy::strict();
        let ok = p.resolve_pinned("https://ok.example.com/x", &r).unwrap();
        assert_eq!(ok.addrs.len(), 2);
        assert!(ok.addrs.iter().all(|a| a.port() == 443));
        for h in ["rebind", "meta", "mapped", "empty", "nxdomain"] {
            assert!(
                p.resolve_pinned(&format!("https://{h}.example.com/"), &r)
                    .is_err(),
                "{h}"
            );
        }
        // IP literals bypass DNS but not classification.
        assert!(p.resolve_pinned("https://93.184.216.34/", &r).is_ok());
        assert!(p.resolve_pinned("https://127.0.0.1/", &r).is_err());
    }

    #[test]
    fn redirects_are_rechecked() {
        let p = UrlPolicy::strict();
        let from = Url::parse("https://example.com/a").unwrap();
        assert!(p.check_redirect(&from, "/b", 0).is_ok());
        assert!(p
            .check_redirect(&from, "https://other.example.org/", 2)
            .is_ok());
        assert!(p
            .check_redirect(&from, "https://169.254.169.254/", 0)
            .is_err());
        assert!(p.check_redirect(&from, "http://example.com/", 0).is_err());
        assert!(p.check_redirect(&from, "//127.0.0.1/", 0).is_err());
        assert!(p.check_redirect(&from, "/b", MAX_REDIRECTS).is_err());
    }
}
