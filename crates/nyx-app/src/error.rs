//! Application-level error: a stable machine code, a redacted message and optional structured data.

use nyx_core::ledger::LedgerErrorCode;
use nyx_core::security::redact::redact_text;
use serde_json::{json, Value};

/// Error returned by every operation. Messages are redacted and single-line safe to show to an
/// agent; `code` is stable and meant for programmatic handling; `data` carries structured detail
/// (for example `available` / `required` for `insufficient_credits`).
#[derive(Debug, Clone, PartialEq)]
pub struct AppError {
    /// Stable snake_case code.
    pub code: String,
    /// Redacted human message.
    pub message: String,
    /// Optional structured detail.
    pub data: Option<Value>,
}

/// Result alias for operations.
pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    /// Build an error; the message is passed through secret redaction.
    pub fn new(code: &str, message: impl AsRef<str>) -> Self {
        Self {
            code: code.to_owned(),
            message: redact_text(message.as_ref()).into_owned(),
            data: None,
        }
    }

    /// Attach structured data (redacted).
    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(nyx_core::security::redact::redact_json(&data));
        self
    }

    /// Invalid arguments.
    pub fn invalid(message: impl AsRef<str>) -> Self {
        Self::new("invalid_input", message)
    }

    /// Unknown tool or entity.
    pub fn not_found(message: impl AsRef<str>) -> Self {
        Self::new("not_found", message)
    }

    /// A capability that needs an external service which is not configured.
    pub fn not_configured(message: impl AsRef<str>) -> Self {
        Self::new("not_configured", message)
    }

    /// JSON body: `{"error": code, "message": ..., ...data}`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut v = json!({"error": self.code, "message": self.message});
        if let (Some(Value::Object(extra)), Some(obj)) = (&self.data, v.as_object_mut()) {
            for (k, val) in extra {
                obj.insert(k.clone(), val.clone());
            }
        }
        v
    }

    /// Process exit code the CLI uses for this error.
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self.code.as_str() {
            "invalid_input" => 2,
            "not_found" => 3,
            "conflict" | "merge_conflict" => 4,
            "insufficient_credits" => 5,
            "rate_limited" => 6,
            "path_rejected" | "forbidden" => 7,
            "not_configured" => 8,
            _ => 1,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

fn ledger_code(c: LedgerErrorCode) -> String {
    match c {
        LedgerErrorCode::InsufficientCredits => "insufficient_credits".into(),
        other => other.as_str().to_ascii_lowercase(),
    }
}

impl From<nyx_core::Error> for AppError {
    fn from(e: nyx_core::Error) -> Self {
        use nyx_core::Error as E;
        match e {
            E::NotFound(m) => Self::not_found(m),
            E::Invalid(m) => {
                if m.starts_with("path rejected") {
                    Self::new("path_rejected", m)
                } else {
                    Self::invalid(m)
                }
            }
            E::Conflict(m) => Self::new("conflict", m),
            E::InsufficientCredits { needed, available } => {
                Self::new("insufficient_credits", "insufficient credits")
                    .with_data(json!({"available": available, "required": needed}))
            }
            E::Ledger(l) => Self::new(&ledger_code(l.code), l.message),
            // Internal details (SQL text, file paths) stay out of agent-visible messages.
            E::Db(err) => Self::new(
                "database_error",
                nyx_core::security::validate::public_error_message(&err.to_string()),
            ),
            E::Json(err) => Self::invalid(format!("json: {err}")),
            E::Migration(m) => Self::new("database_error", m),
            E::Io(err) => Self::new(
                "io_error",
                nyx_core::security::validate::public_error_message(&err.to_string()),
            ),
        }
    }
}

impl From<nyx_core::ai::LlmError> for AppError {
    fn from(e: nyx_core::ai::LlmError) -> Self {
        match e {
            nyx_core::ai::LlmError::NoKey(_) | nyx_core::ai::LlmError::Config(_) => {
                Self::not_configured(e.to_string())
            }
            other => Self::new("provider_error", other.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::invalid(format!("json: {e}"))
    }
}
