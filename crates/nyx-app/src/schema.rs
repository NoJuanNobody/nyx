//! Minimal JSON-Schema subset used for tool input: `type`, `properties`, `required`,
//! `additionalProperties: false`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `items`,
//! `minItems`. Enough to enforce what the published tool schemas promise.

use serde_json::Value;

const TYPES: [&str; 7] = ["string", "integer", "number", "boolean", "array", "object", "null"];

/// Check that a schema document is well formed (used by tests and by `tools/list` consumers).
///
/// # Errors
/// A description of the first problem found.
pub fn check_schema(schema: &Value) -> Result<(), String> {
    check_node(schema, "$", true)
}

fn check_node(s: &Value, at: &str, root: bool) -> Result<(), String> {
    let o = s.as_object().ok_or_else(|| format!("{at}: schema must be an object"))?;
    if let Some(t) = o.get("type") {
        let t = t.as_str().ok_or_else(|| format!("{at}: type must be a string"))?;
        if !TYPES.contains(&t) {
            return Err(format!("{at}: unknown type {t}"));
        }
    } else if root {
        return Err(format!("{at}: root needs a type"));
    }
    if root && o.get("type").and_then(Value::as_str) != Some("object") {
        return Err(format!("{at}: root type must be object"));
    }
    let props = o.get("properties");
    if let Some(p) = props {
        let p = p.as_object().ok_or_else(|| format!("{at}: properties must be an object"))?;
        for (k, v) in p {
            check_node(v, &format!("{at}.{k}"), false)?;
        }
    }
    if let Some(r) = o.get("required") {
        let r = r.as_array().ok_or_else(|| format!("{at}: required must be an array"))?;
        for name in r {
            let name = name.as_str().ok_or_else(|| format!("{at}: required entries must be strings"))?;
            let known = props.and_then(Value::as_object).is_some_and(|p| p.contains_key(name));
            if !known {
                return Err(format!("{at}: required property {name} is not declared"));
            }
        }
    }
    if let Some(e) = o.get("enum") {
        match e.as_array() {
            Some(a) if !a.is_empty() => {}
            _ => return Err(format!("{at}: enum must be a non-empty array")),
        }
    }
    if let Some(i) = o.get("items") {
        check_node(i, &format!("{at}[]"), false)?;
    }
    Ok(())
}

/// Validate `value` against `schema`.
///
/// # Errors
/// Every violation, joined with `; `.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    let mut errs = Vec::new();
    walk(schema, value, "args", &mut errs);
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs.join("; "))
    }
}

fn type_ok(t: &str, v: &Value) -> bool {
    match t {
        "string" => v.is_string(),
        "integer" => v.is_i64() || v.is_u64() || v.as_f64().is_some_and(|f| f.fract() == 0.0 && f.is_finite()),
        "number" => v.is_number(),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        "null" => v.is_null(),
        _ => true,
    }
}

fn walk(s: &Value, v: &Value, at: &str, errs: &mut Vec<String>) {
    let Some(o) = s.as_object() else { return };
    if let Some(t) = o.get("type").and_then(Value::as_str) {
        if !type_ok(t, v) {
            errs.push(format!("{at}: expected {t}"));
            return;
        }
    }
    if let Some(e) = o.get("enum").and_then(Value::as_array) {
        if !e.contains(v) {
            let allowed: Vec<String> = e.iter().map(ToString::to_string).collect();
            errs.push(format!("{at}: must be one of {}", allowed.join(", ")));
        }
    }
    if let Some(n) = v.as_f64() {
        if let Some(min) = o.get("minimum").and_then(Value::as_f64) {
            if n < min {
                errs.push(format!("{at}: must be >= {min}"));
            }
        }
        if let Some(max) = o.get("maximum").and_then(Value::as_f64) {
            if n > max {
                errs.push(format!("{at}: must be <= {max}"));
            }
        }
    }
    if let Some(sv) = v.as_str() {
        let len = sv.chars().count() as u64;
        if let Some(min) = o.get("minLength").and_then(Value::as_u64) {
            if len < min {
                errs.push(format!("{at}: must have at least {min} characters"));
            }
        }
        if let Some(max) = o.get("maxLength").and_then(Value::as_u64) {
            if len > max {
                errs.push(format!("{at}: must have at most {max} characters"));
            }
        }
    }
    if let Some(arr) = v.as_array() {
        if let Some(min) = o.get("minItems").and_then(Value::as_u64) {
            if (arr.len() as u64) < min {
                errs.push(format!("{at}: needs at least {min} items"));
            }
        }
        if let Some(items) = o.get("items") {
            for (i, x) in arr.iter().enumerate() {
                walk(items, x, &format!("{at}[{i}]"), errs);
            }
        }
    }
    if let Some(obj) = v.as_object() {
        if let Some(req) = o.get("required").and_then(Value::as_array) {
            for r in req.iter().filter_map(Value::as_str) {
                if !obj.contains_key(r) {
                    errs.push(format!("{at}.{r}: required"));
                }
            }
        }
        let props = o.get("properties").and_then(Value::as_object);
        if o.get("additionalProperties") == Some(&Value::Bool(false)) {
            for k in obj.keys() {
                if !props.is_some_and(|p| p.contains_key(k)) {
                    errs.push(format!("{at}.{k}: unknown property"));
                }
            }
        }
        if let Some(p) = props {
            for (k, sub) in p {
                if let Some(val) = obj.get(k) {
                    walk(sub, val, &format!("{at}.{k}"), errs);
                }
            }
        }
    }
}
