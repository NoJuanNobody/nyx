//! Pagination helpers: RFC 8288 `Link` headers (GitHub, GitLab) and Bitbucket's
//! body-level `next` URL, plus a same-origin guard so a hostile `next` link can
//! never receive the bearer token.

use super::transport::{HttpRequest, HttpResponse};
use super::{GitError, GitResult};

/// Maximum pages any `fetch_pages` call will follow.
pub const DEFAULT_MAX_PAGES: usize = 10;

/// Extract the `rel="next"` URL from a `Link` header value.
#[must_use]
pub fn next_from_link_header(link: &str) -> Option<String> {
    for part in link.split(',') {
        let mut segs = part.split(';');
        let url = segs.next()?.trim();
        let is_next = segs.any(|s| {
            let s = s.trim().replace(' ', "");
            s == "rel=\"next\"" || s == "rel=next"
        });
        if is_next {
            let url = url.strip_prefix('<')?.strip_suffix('>')?;
            return Some(url.to_owned());
        }
    }
    None
}

/// Next-page URL from a response's `Link` header.
#[must_use]
pub fn next_link(resp: &HttpResponse) -> Option<String> {
    resp.headers.get("link").and_then(next_from_link_header)
}

/// Next-page URL from a Bitbucket-style `{"next": "..."}` body.
#[must_use]
pub fn next_bitbucket(resp: &HttpResponse) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&resp.body).ok()?;
    v.get("next")?.as_str().map(str::to_owned)
}

fn origin(url: &str) -> Option<&str> {
    let after = url.find("://")? + 3;
    let end = url[after..].find('/').map_or(url.len(), |i| after + i);
    Some(&url[..end])
}

/// True if both URLs share scheme + host + port.
#[must_use]
pub fn same_origin(a: &str, b: &str) -> bool {
    match (origin(a), origin(b)) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        _ => false,
    }
}

/// Follow pages starting at `first`.
///
/// `send` performs a request (with auth + error handling), `next` extracts the
/// next URL from a response, `parse` turns a response into items. Stops after
/// `max_pages` pages. A `next` URL on a different origin is a hard error.
///
/// # Errors
/// Propagates `send`/`parse` errors; [`GitError::Parse`] on a cross-origin `next` link.
pub fn fetch_pages<T>(
    first: HttpRequest,
    max_pages: usize,
    mut send: impl FnMut(&HttpRequest) -> GitResult<HttpResponse>,
    next: impl Fn(&HttpResponse) -> Option<String>,
    parse: impl Fn(&HttpResponse) -> GitResult<Vec<T>>,
) -> GitResult<Vec<T>> {
    let mut out = Vec::new();
    let mut req = first;
    for _ in 0..max_pages.max(1) {
        let resp = send(&req)?;
        out.extend(parse(&resp)?);
        match next(&resp) {
            Some(url) => {
                if !same_origin(&req.url, &url) {
                    return Err(GitError::Parse(format!(
                        "refusing cross-origin pagination link: {url}"
                    )));
                }
                req.url = url;
            }
            None => break,
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_provider::transport::{Headers, HttpMethod};

    #[test]
    fn link_header_variants() {
        let l = "<https://api.github.com/user/repos?page=2>; rel=\"next\", <https://api.github.com/user/repos?page=5>; rel=\"last\"";
        assert_eq!(
            next_from_link_header(l).as_deref(),
            Some("https://api.github.com/user/repos?page=2")
        );
        let last_only = "<https://x/?page=5>; rel=\"last\", <https://x/?page=1>; rel=\"first\"";
        assert_eq!(next_from_link_header(last_only), None);
        assert_eq!(next_from_link_header(""), None);
    }

    #[test]
    fn same_origin_checks() {
        assert!(same_origin("https://a.com/x", "https://A.com/y?z"));
        assert!(!same_origin("https://a.com/x", "https://evil.com/x"));
        assert!(!same_origin("https://a.com/x", "http://a.com/x"));
        assert!(!same_origin("https://a.com:8443/x", "https://a.com/x"));
    }

    fn resp(link: Option<&str>, body: &str) -> HttpResponse {
        let mut h = Headers::new();
        if let Some(l) = link {
            h.push("Link", l);
        }
        HttpResponse::new(200, h, body)
    }

    #[test]
    fn follows_pages_and_caps() {
        let mut pages = vec![
            resp(Some("<https://a.com/p?page=2>; rel=\"next\""), "[1,2]"),
            resp(None, "[3]"),
        ]
        .into_iter();
        let mut seen = Vec::new();
        let out: Vec<i64> = fetch_pages(
            HttpRequest::new(HttpMethod::Get, "https://a.com/p"),
            10,
            |r| {
                seen.push(r.url.clone());
                Ok(pages.next().unwrap())
            },
            next_link,
            |r| r.json().map_err(Into::into),
        )
        .unwrap();
        assert_eq!(out, vec![1, 2, 3]);
        assert_eq!(seen, vec!["https://a.com/p", "https://a.com/p?page=2"]);

        let out: Vec<i64> = fetch_pages(
            HttpRequest::new(HttpMethod::Get, "https://a.com/p"),
            2,
            |_| Ok(resp(Some("<https://a.com/p?page=9>; rel=\"next\""), "[1]")),
            next_link,
            |r| r.json().map_err(Into::into),
        )
        .unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn rejects_cross_origin() {
        let r: GitResult<Vec<i64>> = fetch_pages(
            HttpRequest::new(HttpMethod::Get, "https://a.com/p"),
            3,
            |_| Ok(resp(Some("<https://evil.test/p>; rel=\"next\""), "[1]")),
            next_link,
            |r| r.json().map_err(Into::into),
        );
        assert!(matches!(r, Err(GitError::Parse(_))));
    }

    #[test]
    fn bitbucket_next() {
        let r = resp(
            None,
            r#"{"values":[],"next":"https://api.bitbucket.org/2.0/x?page=2"}"#,
        );
        assert_eq!(
            next_bitbucket(&r).as_deref(),
            Some("https://api.bitbucket.org/2.0/x?page=2")
        );
        assert_eq!(next_bitbucket(&resp(None, r#"{"values":[]}"#)), None);
    }
}
