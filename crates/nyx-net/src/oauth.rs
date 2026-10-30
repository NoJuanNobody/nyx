//! One-shot loopback listener for the desktop OAuth flow (RFC 8252 section 7.3).
//!
//! [`LoopbackListener::bind`] takes an ephemeral port on `127.0.0.1` (never `0.0.0.0`, never
//! `localhost`, which can resolve to a non-loopback address). The app puts
//! [`CallbackReceiver::redirect_uri`] in the authorise URL, opens the browser and calls
//! [`CallbackReceiver::wait_for_code`], which validates the redirect with
//! `nyx_core::integrations::oauth::parse_callback` (constant-time `state` comparison, provider
//! `error=` handling) and returns the authorisation `code`.
//!
//! Behaviour:
//! - **One-shot.** The first request to `/callback` ends the flow, successful or not; a second
//!   `wait_for_code` fails. A state mismatch is therefore final: start a new flow.
//! - **Other requests are ignored**, not consumed: wrong path (`/favicon.ico`) gets 404, a
//!   non-`GET` gets 405, a `Host` header other than `127.0.0.1:<port>` / `localhost:<port>` gets 400
//!   (DNS-rebinding guard). None of them can complete or abort the flow.
//! - **Timeout.** `wait_for_code` gives up after the caller's deadline; slow or silent clients
//!   cannot hold it past that (per-connection read timeout, 16 KiB request cap).
//! - **Tiny pages.** The browser sees a static "you can close this tab" page (or a static error
//!   page). Nothing from the request is echoed back, so there is no reflected-content surface, and
//!   the pages carry `no-store`, `no-referrer` and a `default-src 'none'` CSP so the `code` does not
//!   leak via cache or `Referer`.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use nyx_core::integrations::oauth::{loopback_redirect_uri, parse_callback, CallbackReceiver};
use nyx_core::integrations::{IntegrationError, Result};

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const POLL: Duration = Duration::from_millis(20);

const OK_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Nyx</title>\
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}\
main{text-align:center}</style></head><body><main><h1>You are connected</h1>\
<p>You can close this tab and return to Nyx.</p></main></body></html>";

const ERR_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Nyx</title>\
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}\
main{text-align:center}</style></head><body><main><h1>Connection failed</h1>\
<p>The sign-in could not be completed. You can close this tab and try again from Nyx.</p>\
</main></body></html>";

/// Listener bound to `127.0.0.1:<ephemeral>`. See the [module docs](self).
#[derive(Debug)]
pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
    used: AtomicBool,
}

impl LoopbackListener {
    /// Bind an ephemeral port on the IPv4 loopback interface.
    ///
    /// # Errors
    /// The socket could not be bound.
    pub fn bind() -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        Ok(Self {
            listener,
            port,
            used: AtomicBool::new(false),
        })
    }

    /// The bound port.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }
}

/// A parsed request head.
struct Head {
    method: String,
    target: String,
    host: Option<String>,
}

fn read_head(stream: &mut TcpStream, deadline: Instant) -> io::Result<Head> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        stream.set_read_timeout(Some(left.min(Duration::from_secs(2))))?;
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > MAX_REQUEST_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let (method, target) = (
        first.next().unwrap_or("").to_owned(),
        first.next().unwrap_or("").to_owned(),
    );
    let host = lines.take_while(|l| !l.is_empty()).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("host").then(|| v.trim().to_owned())
    });
    Ok(Head {
        method,
        target,
        host,
    })
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n\
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(msg.as_bytes());
    let _ = stream.flush();
}

fn host_ok(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|h| {
        let h = h.to_ascii_lowercase();
        h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")
    })
}

impl CallbackReceiver for LoopbackListener {
    fn redirect_uri(&self) -> String {
        loopback_redirect_uri(self.port)
    }

    fn wait_for_code(&self, expected_state: &str, timeout: Duration) -> Result<String> {
        if self.used.swap(true, Ordering::SeqCst) {
            return Err(IntegrationError::Invalid(
                "this callback listener was already used; start a new sign-in".into(),
            ));
        }
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err(IntegrationError::Transport(
                    "timed out waiting for the browser sign-in to finish".into(),
                ));
            }
            let mut stream = match self.listener.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(POLL);
                    continue;
                }
                Err(e) => return Err(IntegrationError::Transport(format!("accept failed: {e}"))),
            };
            let _ = stream.set_nonblocking(false);
            let Ok(head) = read_head(&mut stream, deadline) else {
                continue; // silent or malformed client: ignore, keep waiting
            };
            if !host_ok(head.host.as_deref(), self.port) {
                respond(&mut stream, "400 Bad Request", ERR_PAGE);
                continue;
            }
            if head.method != "GET" {
                respond(&mut stream, "405 Method Not Allowed", ERR_PAGE);
                continue;
            }
            let path = head.target.split('?').next().unwrap_or("");
            if path != "/callback" {
                respond(&mut stream, "404 Not Found", ERR_PAGE);
                continue;
            }
            let result = parse_callback(&head.target, expected_state);
            match &result {
                Ok(_) => respond(&mut stream, "200 OK", OK_PAGE),
                Err(_) => respond(&mut stream, "400 Bad Request", ERR_PAGE),
            }
            return result;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Send raw bytes, return the whole response text.
    fn http(port: u16, req: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    fn get(port: u16, target: &str) -> String {
        http(
            port,
            &format!(
                "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            ),
        )
    }

    fn spawn_wait(
        l: &Arc<LoopbackListener>,
        state: &str,
        secs: u64,
    ) -> std::thread::JoinHandle<Result<String>> {
        let (l, state) = (l.clone(), state.to_owned());
        std::thread::spawn(move || l.wait_for_code(&state, Duration::from_secs(secs)))
    }

    #[test]
    fn binds_loopback_only_on_an_ephemeral_port() {
        let l = LoopbackListener::bind().unwrap();
        assert!(l.listener.local_addr().unwrap().ip().is_loopback());
        assert_ne!(l.port(), 0);
        assert_eq!(
            l.redirect_uri(),
            format!("http://127.0.0.1:{}/callback", l.port())
        );
        let other = LoopbackListener::bind().unwrap();
        assert_ne!(l.port(), other.port());
    }

    #[test]
    fn returns_the_code_and_serves_the_close_tab_page() {
        let l = Arc::new(LoopbackListener::bind().unwrap());
        let h = spawn_wait(&l, "state-1", 5);
        let page = get(l.port(), "/callback?code=abc123&state=state-1");
        assert_eq!(h.join().unwrap().unwrap(), "abc123");
        assert!(page.starts_with("HTTP/1.1 200 OK"));
        assert!(page.contains("close this tab"));
        assert!(page.contains("no-store") && page.contains("no-referrer"));
        assert!(!page.contains("abc123"), "the code is never reflected");
    }

    #[test]
    fn state_mismatch_is_final_and_reflects_nothing() {
        let l = Arc::new(LoopbackListener::bind().unwrap());
        let h = spawn_wait(&l, "expected", 5);
        let page = get(l.port(), "/callback?code=stolen&state=%3Cscript%3Eevil");
        let err = h.join().unwrap().unwrap_err();
        assert!(matches!(err, IntegrationError::OAuth(m) if m.contains("state")));
        assert!(page.starts_with("HTTP/1.1 400"));
        assert!(!page.contains("stolen") && !page.contains("script"));
        // one-shot: the listener is spent
        assert!(matches!(
            l.wait_for_code("expected", Duration::from_secs(1)),
            Err(IntegrationError::Invalid(_))
        ));
    }

    #[test]
    fn missing_state_and_provider_errors_are_rejected() {
        let l = Arc::new(LoopbackListener::bind().unwrap());
        let h = spawn_wait(&l, "s", 5);
        get(l.port(), "/callback?code=abc");
        assert!(matches!(
            h.join().unwrap(),
            Err(IntegrationError::Invalid(_))
        ));

        let l = Arc::new(LoopbackListener::bind().unwrap());
        let h = spawn_wait(&l, "s", 5);
        get(l.port(), "/callback?error=access_denied&state=s");
        assert!(
            matches!(h.join().unwrap(), Err(IntegrationError::OAuth(m)) if m.contains("access_denied"))
        );
    }

    #[test]
    fn stray_requests_do_not_consume_the_flow() {
        let l = Arc::new(LoopbackListener::bind().unwrap());
        let h = spawn_wait(&l, "s", 5);
        let port = l.port();
        assert!(get(port, "/favicon.ico").starts_with("HTTP/1.1 404"));
        assert!(get(port, "/").starts_with("HTTP/1.1 404"));
        let posted = http(
            port,
            &format!("POST /callback?code=x&state=s HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        );
        assert!(posted.starts_with("HTTP/1.1 405"));
        let rebind = http(
            port,
            "GET /callback?code=x&state=s HTTP/1.1\r\nHost: evil.example\r\n\r\n",
        );
        assert!(rebind.starts_with("HTTP/1.1 400"));
        // garbage / silent connection is ignored too
        drop(TcpStream::connect(("127.0.0.1", port)).unwrap());
        assert!(get(port, "/callback?code=good&state=s").starts_with("HTTP/1.1 200"));
        assert_eq!(h.join().unwrap().unwrap(), "good");
    }

    #[test]
    fn times_out_when_nobody_comes() {
        let l = LoopbackListener::bind().unwrap();
        let t = Instant::now();
        let err = l
            .wait_for_code("s", Duration::from_millis(300))
            .unwrap_err();
        assert!(matches!(err, IntegrationError::Transport(m) if m.contains("timed out")));
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_silent_client_cannot_hold_the_listener_past_the_deadline() {
        let l = LoopbackListener::bind().unwrap();
        let _silent = TcpStream::connect(("127.0.0.1", l.port())).unwrap();
        let t = Instant::now();
        assert!(l.wait_for_code("s", Duration::from_millis(500)).is_err());
        assert!(t.elapsed() < Duration::from_secs(4));
    }
}
