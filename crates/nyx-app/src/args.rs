//! Typed access to a tool's JSON arguments with uniform error messages.

use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Borrowed JSON object of arguments.
#[derive(Debug, Clone, Copy)]
pub struct Args<'a>(pub &'a Value);

impl<'a> Args<'a> {
    /// Raw value of a key (`null` counts as absent).
    #[must_use]
    pub fn raw(&self, k: &str) -> Option<&'a Value> {
        self.0.get(k).filter(|v| !v.is_null())
    }

    /// Required string.
    pub fn str(&self, k: &str) -> AppResult<&'a str> {
        self.opt_str(k)
            .ok_or_else(|| AppError::invalid(format!("{k} is required")))
    }

    /// Optional string.
    #[must_use]
    pub fn opt_str(&self, k: &str) -> Option<&'a str> {
        self.raw(k).and_then(Value::as_str)
    }

    /// Optional integer.
    #[must_use]
    pub fn opt_i64(&self, k: &str) -> Option<i64> {
        self.raw(k)
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
    }

    /// Required integer.
    pub fn i64(&self, k: &str) -> AppResult<i64> {
        self.opt_i64(k)
            .ok_or_else(|| AppError::invalid(format!("{k} is required")))
    }

    /// Optional boolean.
    #[must_use]
    pub fn opt_bool(&self, k: &str) -> Option<bool> {
        self.raw(k).and_then(Value::as_bool)
    }

    /// Optional list of strings (non-strings are skipped).
    #[must_use]
    pub fn str_list(&self, k: &str) -> Vec<String> {
        self.raw(k)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}
