//! Import of an existing Postgres export (AI-60 acceptance criterion).
//!
//! Input is JSON of the shape `{ "<table>": [ { "<column>": value, ... }, ... ], ... }` using the
//! Postgres column names from `apps/api/src/db/schema.ts`. A typical export:
//!
//! ```text
//! psql "$DATABASE_URL" -At -c "select json_build_object(
//!   'users',(select coalesce(json_agg(t),'[]') from users t),
//!   'teams',(select coalesce(json_agg(t),'[]') from teams t), ... )" > export.json
//! ```
//!
//! Conversions: `timestamptz` strings (RFC 3339 or Postgres `YYYY-MM-DD HH:MM:SS[.f]+TZ`) become unix
//! ms; `jsonb` values are stored as JSON text; `boolean` becomes 0/1; pgvector `"[0.1,0.2]"` text (or a
//! JSON array) becomes a little-endian f32 BLOB. Tables not in the Rust model (agent, Stripe,
//! credits, chat, ...) are listed under `ignored_tables`, unknown columns are dropped, and credits
//! are never imported (fresh start per spec section 8). Rows that violate a constraint (for example
//! the removed `agent_workflow` audit type) are skipped and reported, not fatal.

use std::collections::BTreeMap;

use rusqlite::types::Value as Sql;
use rusqlite::Connection;
use serde_json::Value;

use super::db::Db;
use crate::error::{Error, Result};
use crate::model::encode_embedding;

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Int,
    Bool,
    Ts,
    Json,
    Vector,
}
use Kind::{Bool, Int, Json, Text, Ts, Vector};

type Cols = &'static [(&'static str, Kind)];

const TABLES: &[(&str, Cols)] = &[
    (
        "users",
        &[
            ("id", Text),
            ("email", Text),
            ("name", Text),
            ("avatar_url", Text),
            ("created_at", Ts),
            ("updated_at", Ts),
        ],
    ),
    (
        "teams",
        &[
            ("id", Text),
            ("name", Text),
            ("slug", Text),
            ("created_at", Ts),
            ("updated_at", Ts),
        ],
    ),
    (
        "team_members",
        &[
            ("id", Text),
            ("team_id", Text),
            ("user_id", Text),
            ("role", Text),
            ("joined_at", Ts),
        ],
    ),
    (
        "lifecycles",
        &[
            ("id", Text),
            ("slug", Text),
            ("label", Text),
            ("description", Text),
            ("icon", Text),
            ("is_default", Bool),
            ("sort_order", Int),
            ("created_at", Ts),
        ],
    ),
    (
        "lifecycle_stages",
        &[
            ("id", Text),
            ("lifecycle_id", Text),
            ("slug", Text),
            ("sort_order", Int),
            ("label", Text),
            ("abbreviation", Text),
            ("subtitle", Text),
            ("color", Text),
            ("text_color", Text),
            ("dot_color", Text),
            ("border_color", Text),
            ("hex", Text),
            ("who", Text),
            ("description", Text),
            ("icon", Text),
            ("ai", Text),
            ("output", Text),
            ("docs", Json),
        ],
    ),
    (
        "integrations",
        &[
            ("id", Text),
            ("team_id", Text),
            ("type", Text),
            ("config", Json),
            ("created_at", Ts),
            ("updated_at", Ts),
        ],
    ),
    (
        "documents",
        &[
            ("id", Text),
            ("title", Text),
            ("content", Text),
            ("path", Text),
            ("team_id", Text),
            ("created_by_id", Text),
            ("stage", Text),
            ("lifecycle_id", Text),
            ("created_at", Ts),
            ("updated_at", Ts),
            ("deleted_at", Ts),
        ],
    ),
    (
        "document_versions",
        &[
            ("id", Text),
            ("document_id", Text),
            ("version", Int),
            ("content", Text),
            ("message", Text),
            ("created_by_id", Text),
            ("created_at", Ts),
        ],
    ),
    (
        "document_branches",
        &[
            ("id", Text),
            ("document_id", Text),
            ("name", Text),
            ("base_version_id", Text),
            ("content", Text),
            ("created_by_id", Text),
            ("status", Text),
            ("reviewed_by_id", Text),
            ("created_at", Ts),
            ("merged_at", Ts),
        ],
    ),
    (
        "snapshots",
        &[
            ("id", Text),
            ("document_id", Text),
            ("integration_id", Text),
            ("external_ref", Text),
            ("content", Text),
            ("captured_at", Ts),
        ],
    ),
    (
        "tickets",
        &[
            ("id", Text),
            ("document_id", Text),
            ("provider", Text),
            ("external_id", Text),
            ("external_url", Text),
            ("title", Text),
            ("body", Text),
            ("status", Text),
            ("claude_insights", Json),
            ("created_by_id", Text),
            ("created_at", Ts),
            ("updated_at", Ts),
        ],
    ),
    (
        "audit_trail",
        &[
            ("id", Text),
            ("team_id", Text),
            ("event_type", Text),
            ("actor_id", Text),
            ("document_id", Text),
            ("snapshot_id", Text),
            ("ticket_id", Text),
            ("commit_sha", Text),
            ("parent_event_id", Text),
            ("metadata", Json),
            ("created_at", Ts),
        ],
    ),
    (
        "doc_chunks",
        &[
            ("id", Text),
            ("doc_id", Text),
            ("org_id", Text),
            ("content", Text),
            ("embedding", Vector),
            ("version", Int),
            ("chunk_index", Int),
            ("created_at", Ts),
        ],
    ),
    (
        "code_chunks",
        &[
            ("id", Text),
            ("team_id", Text),
            ("file_path", Text),
            ("content", Text),
            ("embedding", Vector),
            ("repo_full_name", Text),
            ("commit_sha", Text),
            ("chunk_index", Int),
            ("created_at", Ts),
        ],
    ),
];

/// A row that could not be imported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedRow {
    /// Table.
    pub table: String,
    /// Row id, if present.
    pub id: Option<String>,
    /// Why it was skipped.
    pub reason: String,
}

/// Outcome of an import.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportReport {
    /// Rows inserted per table.
    pub inserted: BTreeMap<String, usize>,
    /// Rows skipped with reasons.
    pub skipped: Vec<SkippedRow>,
    /// Export tables with no Rust counterpart.
    pub ignored_tables: Vec<String>,
}

/// Import a Postgres JSON export into `db` in a single transaction.
pub fn import_postgres_json(db: &mut Db, export: &Value) -> Result<ImportReport> {
    let obj = export
        .as_object()
        .ok_or_else(|| Error::Invalid("export must be a JSON object of tables".into()))?;
    db.transaction(|conn| {
        let mut report = ImportReport::default();
        for name in obj.keys() {
            if !TABLES.iter().any(|(t, _)| t == name) {
                report.ignored_tables.push(name.clone());
            }
        }
        for (table, cols) in TABLES {
            let Some(rows) = obj.get(*table) else {
                continue;
            };
            let rows = rows
                .as_array()
                .ok_or_else(|| Error::Invalid(format!("table {table} must be an array")))?;
            let mut pending: Vec<&Value> = rows.iter().collect();
            // Two passes so rows referencing later rows of the same table (audit parents) still land.
            for pass in 0..2 {
                let mut failed: Vec<(&Value, String)> = Vec::new();
                for row in pending {
                    match insert_row(conn, table, cols, row) {
                        Ok(()) => *report.inserted.entry((*table).to_owned()).or_default() += 1,
                        Err(reason) => failed.push((row, reason)),
                    }
                }
                if failed.is_empty() || pass == 1 {
                    for (row, reason) in failed {
                        report.skipped.push(SkippedRow {
                            table: (*table).to_owned(),
                            id: row.get("id").and_then(Value::as_str).map(str::to_owned),
                            reason,
                        });
                    }
                    break;
                }
                pending = failed.into_iter().map(|(r, _)| r).collect();
            }
        }
        Ok(report)
    })
}

fn insert_row(
    conn: &Connection,
    table: &str,
    cols: Cols,
    row: &Value,
) -> std::result::Result<(), String> {
    let obj = row.as_object().ok_or("row is not an object")?;
    let mut names: Vec<&str> = Vec::new();
    let mut values: Vec<Sql> = Vec::new();
    for (name, kind) in cols {
        let Some(v) = obj.get(*name) else { continue };
        if v.is_null() {
            continue; // let the column default (or NULL) apply
        }
        if matches!(kind, Vector) {
            let vec = parse_vector(v)?;
            names.extend(["embedding", "embedding_dim", "embedding_model"]);
            values.push(Sql::Blob(encode_embedding(&vec)));
            values.push(Sql::Integer(i64::try_from(vec.len()).unwrap_or(i64::MAX)));
            values.push(Sql::Text("imported-pgvector".into()));
        } else {
            names.push(name);
            values.push(convert(*kind, v).map_err(|e| format!("{name}: {e}"))?);
        }
    }
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        names.join(","),
        (1..=names.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    conn.execute(&sql, rusqlite::params_from_iter(values))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn convert(kind: Kind, v: &Value) -> std::result::Result<Sql, String> {
    Ok(match kind {
        Text => Sql::Text(v.as_str().map_or_else(|| v.to_string(), str::to_owned)),
        Int => Sql::Integer(v.as_i64().ok_or("expected integer")?),
        Bool => Sql::Integer(match v {
            Value::Bool(b) => i64::from(*b),
            Value::String(s) if s == "t" || s == "true" => 1,
            Value::String(s) if s == "f" || s == "false" => 0,
            Value::Number(n) => i64::from(n.as_i64() == Some(1)),
            _ => return Err("expected boolean".into()),
        }),
        Ts => Sql::Integer(match v {
            Value::Number(n) => n.as_i64().ok_or("expected integer timestamp")?,
            Value::String(s) => parse_timestamp(s)?,
            _ => return Err("expected timestamp".into()),
        }),
        Json => {
            // jsonb may arrive as a JSON value or as an already-serialised string.
            let parsed = match v {
                Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or_else(|_| v.clone()),
                other => other.clone(),
            };
            Sql::Text(parsed.to_string())
        }
        Vector => unreachable!("handled by caller"),
    })
}

fn parse_vector(v: &Value) -> std::result::Result<Vec<f32>, String> {
    let nums: Vec<Value> = match v {
        Value::Array(a) => a.clone(),
        Value::String(s) => serde_json::from_str(s).map_err(|e| format!("embedding: {e}"))?,
        _ => return Err("embedding: expected array or pgvector text".into()),
    };
    nums.iter()
        .map(|n| {
            n.as_f64()
                .map(|f| f as f32)
                .filter(|f| f.is_finite())
                .ok_or_else(|| "embedding: non-numeric".to_owned())
        })
        .collect()
}

/// Parse RFC 3339 / Postgres timestamptz text to unix milliseconds (UTC).
pub fn parse_timestamp(s: &str) -> std::result::Result<i64, String> {
    let bad = || format!("unparseable timestamp '{s}'");
    let s = s.trim();
    let (date, rest) = s.split_once(['T', ' ']).ok_or_else(bad)?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (
        d.next().and_then(|x| x.parse().ok()).ok_or_else(bad)?,
        d.next().and_then(|x| x.parse().ok()).ok_or_else(bad)?,
        d.next().and_then(|x| x.parse().ok()).ok_or_else(bad)?,
    );
    // Split time from zone: zone starts at Z, '+', or a '-' after the time digits.
    let zone_at = rest.find(['Z', 'z', '+', '-']).unwrap_or(rest.len());
    let (time, zone) = rest.split_at(zone_at);
    let mut t = time.split(':');
    let h: i64 = t.next().and_then(|x| x.parse().ok()).ok_or_else(bad)?;
    let mi: i64 = t.next().and_then(|x| x.parse().ok()).ok_or_else(bad)?;
    let sec_str = t.next().unwrap_or("0");
    let (sec, frac) = sec_str.split_once('.').unwrap_or((sec_str, ""));
    let sec: i64 = sec.parse().map_err(|_| bad())?;
    let mut ms: i64 = 0;
    if !frac.is_empty() {
        let digits: String = frac.chars().take(3).collect();
        ms = digits.parse::<i64>().map_err(|_| bad())?
            * 10_i64.pow(3 - u32::try_from(digits.len()).map_err(|_| bad())?);
    }
    let offset_min = match zone.chars().next() {
        None | Some('Z' | 'z') => 0,
        Some(sign) => {
            let body = &zone[1..];
            let (hh, mm) = body
                .split_once(':')
                .unwrap_or((body.get(..2).unwrap_or(body), body.get(2..).unwrap_or("")));
            let total = hh.parse::<i64>().map_err(|_| bad())? * 60
                + if mm.is_empty() {
                    0
                } else {
                    mm.parse::<i64>().map_err(|_| bad())?
                };
            if sign == '-' {
                -total
            } else {
                total
            }
        }
    };
    // days_from_civil (Howard Hinnant)
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok(((days * 24 + h) * 60 + mi - offset_min) * 60_000 + sec * 1000 + ms)
}
