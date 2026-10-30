//! Small pure helpers: percent-encoding, HMAC-SHA256, constant-time compare.

use sha2::{Digest, Sha256};

/// Percent-encode everything except RFC 3986 unreserved characters.
#[must_use]
pub fn encode_component(s: &str) -> String {
    encode_with(s, false)
}

/// Like [`encode_component`] but keeps `/` (for file paths inside a URL path).
#[must_use]
pub fn encode_path(s: &str) -> String {
    encode_with(s, true)
}

fn encode_with(s: &str, keep_slash: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'.' | b'_' | b'~')
            || (keep_slash && b == b'/')
        {
            out.push(char::from(b));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 0x0f)]));
        }
    }
    out
}

/// Build `a=b&c=d` with encoded values (keys are assumed safe literals).
#[must_use]
pub fn query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", encode_component(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// HMAC-SHA256 (RFC 2104).
#[must_use]
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

/// Constant-time byte equality (length is not secret).
#[must_use]
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Truncate to at most `max` chars (for error bodies).
#[must_use]
pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Count added/removed lines in unified-diff hunks. Everything before the first
/// `@@` line (file headers) is ignored; `\ No newline` markers are skipped.
#[must_use]
pub fn count_patch_lines(patch: &str) -> (u64, u64) {
    let mut in_hunk = false;
    let (mut add, mut del) = (0u64, 0u64);
    for line in patch.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk {
            if line.starts_with('+') {
                add += 1;
            } else if line.starts_with('-') {
                del += 1;
            }
        }
    }
    (add, del)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_patch_lines() {
        let p =
            "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n\\ No newline at end of file\n";
        assert_eq!(count_patch_lines(p), (1, 1));
        assert_eq!(count_patch_lines("no hunks"), (0, 0));
    }

    #[test]
    fn encodes() {
        assert_eq!(encode_component("a/b c"), "a%2Fb%20c");
        assert_eq!(encode_path("src/a b.rs"), "src/a%20b.rs");
        assert_eq!(
            query(&[("q", "state=\"new\" OR x")]),
            "q=state%3D%22new%22%20OR%20x"
        );
    }

    #[test]
    fn hmac_rfc4231_case1_and_2() {
        let key = [0x0bu8; 20];
        assert_eq!(
            hex::encode(hmac_sha256(&key, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hmac_long_key_case6() {
        let key = [0xaau8; 131];
        assert_eq!(
            hex::encode(hmac_sha256(
                &key,
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn ct_eq_basic() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }
}
