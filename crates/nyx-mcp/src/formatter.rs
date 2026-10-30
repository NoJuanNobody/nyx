//! Human-readable text for tool results, ported from `packages/mcp-server/src/formatter.ts`.
//! Tools without a dedicated renderer fall back to pretty JSON. Deviations from the TS output:
//! timestamps arrive as unix ms (rendered as dates), version and timeline lines also carry ids.

use serde_json::Value;

fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false)) && v.as_str() != Some("")
}

/// `YYYY-MM-DD` of a unix-millisecond timestamp (civil-from-days, proleptic Gregorian).
fn date(ms: i64) -> String {
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn when(v: &Value) -> String {
    v.as_i64().map_or_else(|| s(v).split('T').next().unwrap_or("").to_owned(), date)
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn list<'a>(v: &'a Value, key: &str) -> Vec<&'a Value> {
    v.as_array()
        .or_else(|| v.get(key).and_then(Value::as_array))
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

/// Render a tool result as text.
#[must_use]
pub fn format_tool_result(tool: &str, r: &Value) -> String {
    if let Value::String(x) = r {
        return x.clone();
    }
    if r.is_null() {
        return "(no result)".into();
    }
    fmt(tool, r).unwrap_or_else(|| serde_json::to_string_pretty(r).unwrap_or_default())
}

#[allow(clippy::too_many_lines)]
fn fmt(tool: &str, r: &Value) -> Option<String> {
    Some(match tool {
        "nyx_search_docs" => {
            let docs = list(r, "documents");
            if docs.is_empty() {
                return Some("No documents found.".into());
            }
            let lines: Vec<String> = docs
                .iter()
                .map(|d| {
                    let status = if truthy(&d["status"]) { format!(" [{}]", s(&d["status"])) } else { String::new() };
                    let path = if truthy(&d["path"]) { format!("  {}", s(&d["path"])) } else { String::new() };
                    format!("• {}{status}{path}  ({})", s(&d["title"]), s(&d["id"]))
                })
                .collect();
            format!("{}:\n{}", plural(docs.len(), "document"), lines.join("\n"))
        }
        "nyx_read_doc" => {
            let stage = if truthy(&r["status"]) { format!(" · {}", s(&r["status"])) } else { String::new() };
            let path = if truthy(&r["path"]) { format!(" · {}", s(&r["path"])) } else { String::new() };
            let body = if truthy(&r["content"]) { s(&r["content"]) } else { "(no content)".into() };
            format!("# {}{stage}{path}  (id: {})\n\n{body}", s(&r["title"]), s(&r["id"]))
        }
        "nyx_create_doc" => {
            let path = if truthy(&r["path"]) { format!("\nPath: {}", s(&r["path"])) } else { String::new() };
            format!("Document created: \"{}\"  (id: {}){path}", s(&r["title"]), s(&r["id"]))
        }
        "nyx_update_doc" => {
            let title = if truthy(&r["title"]) { format!("\nTitle: {}", s(&r["title"])) } else { String::new() };
            format!("Document updated (id: {}).{title}", s(&r["id"]))
        }
        "nyx_delete_doc" => {
            if r["success"] == true { "Document deleted.".into() } else { format!("Delete result: {r}") }
        }
        "nyx_list_versions" => {
            let vs = list(r, "versions");
            if vs.is_empty() {
                return Some("No versions found.".into());
            }
            let lines: Vec<String> = vs
                .iter()
                .map(|v| {
                    let msg = if truthy(&v["message"]) { format!(" — {}", s(&v["message"])) } else { String::new() };
                    let ts = if truthy(&v["createdAt"]) { format!(" ({})", when(&v["createdAt"])) } else { String::new() };
                    format!("• v{}{msg}{ts}  (id: {})", s(&v["version"]), s(&v["id"]))
                })
                .collect();
            format!("{}:\n{}", plural(vs.len(), "version"), lines.join("\n"))
        }
        "nyx_get_timeline" => {
            let ev = list(r, "events");
            if ev.is_empty() {
                return Some("No timeline events.".into());
            }
            let lines: Vec<String> = ev
                .iter()
                .map(|e| format!("• [{}] {}: {}", when(&e["createdAt"]), s(&e["type"]), s(&e["description"])))
                .collect();
            format!("{}:\n{}", plural(ev.len(), "event"), lines.join("\n"))
        }
        "nyx_list_teams" => {
            let ts = list(r, "teams");
            if ts.is_empty() {
                return Some("No teams found.".into());
            }
            let lines: Vec<String> = ts
                .iter()
                .map(|t| {
                    let role = if truthy(&t["role"]) { format!(" ({})", s(&t["role"])) } else { String::new() };
                    format!("• {}  /{}{role}  ({})", s(&t["name"]), s(&t["slug"]), s(&t["id"]))
                })
                .collect();
            format!("{}:\n{}", plural(ts.len(), "team"), lines.join("\n"))
        }
        "nyx_get_team" => {
            let members = r["members"].as_array().map_or_else(String::new, |m| format!("\nMembers: {}", m.len()));
            format!("Team: {}  (/{})  id: {}{members}", s(&r["name"]), s(&r["slug"]), s(&r["id"]))
        }
        "nyx_create_team" => format!("Team created: \"{}\"  (/{})  id: {}", s(&r["name"]), s(&r["slug"]), s(&r["id"])),
        "nyx_create_ticket" => {
            let url = if truthy(&r["url"]) { format!("\nURL: {}", s(&r["url"])) } else { String::new() };
            format!("Ticket created: \"{}\"{url}  (id: {})", s(&r["title"]), s(&r["id"]))
        }
        "nyx_check_quality" => {
            let head = if r.get("score").is_some() { format!("Quality score: {}/10", s(&r["score"])) } else { "Quality analysis:".into() };
            let sug = list(&r["suggestions"], "");
            if sug.is_empty() {
                return Some(format!("{head}\nNo suggestions."));
            }
            let b: Vec<String> = sug.iter().map(|x| format!("• {}", s(x))).collect();
            format!("{head}\n\nSuggestions:\n{}", b.join("\n"))
        }
        "nyx_detect_drift" => {
            let score = if r.get("driftScore").is_some() { format!("Drift score: {}", s(&r["driftScore"])) } else { String::new() };
            let has = if r.get("hasDrift").is_some() { format!("\nDrift detected: {}", s(&r["hasDrift"])) } else { String::new() };
            let details = if truthy(&r["details"]) { format!("\n\nDetails:\n{}", s(&r["details"])) } else { String::new() };
            let sug = list(&r["suggestions"], "");
            let sug = if sug.is_empty() {
                String::new()
            } else {
                format!("\n\nSuggestions:\n{}", sug.iter().map(|x| format!("• {}", s(x))).collect::<Vec<_>>().join("\n"))
            };
            let out = format!("{score}{has}{details}{sug}");
            if out.trim().is_empty() { serde_json::to_string_pretty(r).ok()? } else { out.trim().to_owned() }
        }
        "nyx_web_search" => {
            let results = list(&r["results"], "");
            if results.is_empty() {
                return Some(format!("No results for: {}", s(&r["query"])));
            }
            let lines: Vec<String> = results
                .iter()
                .enumerate()
                .map(|(i, x)| format!("{}. **{}**\n   {}\n   {}", i + 1, s(&x["title"]), s(&x["url"]), s(&x["snippet"])))
                .collect();
            format!("Search: {}\n\n{}", s(&r["query"]), lines.join("\n\n"))
        }
        "nyx_read_file" => {
            format!("File: {}  ({})\n{}\n{}", s(&r["path"]), s(&r["extension"]), "─".repeat(40), s(&r["content"]))
        }
        "nyx_list_files" => {
            let es = list(r, "");
            if es.is_empty() {
                return Some("(empty directory)".into());
            }
            es.iter()
                .map(|e| format!("{} {}", if e["type"] == "directory" { "[dir] " } else { "[file]" }, s(&e["name"])))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dates() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1_709_251_200_000), "2024-03-01");
        assert_eq!(date(951_782_400_000), "2000-02-29");
    }

    #[test]
    fn list_and_fallback() {
        let out = format_tool_result("nyx_search_docs", &json!([{"id": "1", "title": "A", "status": "draft", "path": "/x"}]));
        assert_eq!(out, "1 document:\n• A [draft]  /x  (1)");
        assert_eq!(format_tool_result("nyx_search_docs", &json!([])), "No documents found.");
        assert!(format_tool_result("nyx_credits_balance", &json!({"balance": 3})).contains("\"balance\": 3"));
        assert_eq!(format_tool_result("x", &Value::Null), "(no result)");
    }
}
