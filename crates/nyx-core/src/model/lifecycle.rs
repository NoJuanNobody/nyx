//! Lifecycles and their stages. Drizzle: `lifecycles`, `lifecycle_stages`.

use serde::{Deserialize, Serialize};

use super::{Id, Timestamp};

/// A named sequence of stages documents move through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lifecycle {
    /// Id.
    pub id: Id,
    /// Unique slug.
    pub slug: String,
    /// Label.
    pub label: String,
    /// Description.
    pub description: String,
    /// Icon name.
    pub icon: String,
    /// At most one lifecycle is the default.
    pub is_default: bool,
    /// Sort order.
    pub sort_order: i64,
    /// Creation time.
    pub created_at: Timestamp,
}

/// Input for creating a lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewLifecycle {
    /// Unique slug.
    pub slug: String,
    /// Label.
    pub label: String,
    /// Description.
    pub description: String,
    /// Icon name.
    pub icon: String,
    /// Mark as the default lifecycle.
    pub is_default: bool,
    /// Sort order.
    pub sort_order: i64,
}

impl NewLifecycle {
    /// Minimal lifecycle with empty description/icon.
    #[must_use]
    pub fn new(slug: &str, label: &str) -> Self {
        Self {
            slug: slug.into(),
            label: label.into(),
            description: String::new(),
            icon: String::new(),
            is_default: false,
            sort_order: 0,
        }
    }
}

/// One stage of a lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleStage {
    /// Id.
    pub id: Id,
    /// Owning lifecycle.
    pub lifecycle_id: Id,
    /// Slug, unique within the lifecycle.
    pub slug: String,
    /// Sort order.
    pub sort_order: i64,
    /// Label.
    pub label: String,
    /// Short abbreviation.
    pub abbreviation: String,
    /// Subtitle.
    pub subtitle: String,
    /// CSS colour tokens.
    pub color: String,
    /// Text colour.
    pub text_color: String,
    /// Dot colour.
    pub dot_color: String,
    /// Border colour.
    pub border_color: String,
    /// Hex colour.
    pub hex: String,
    /// Who owns the stage.
    pub who: String,
    /// Description.
    pub description: String,
    /// Icon.
    pub icon: String,
    /// Hint about how external agents help at this stage.
    pub ai: String,
    /// Expected output.
    pub output: String,
    /// Suggested document names.
    pub docs: Vec<String>,
}

/// Input for adding a stage; all presentation fields are public so callers can fill what they need.
pub type NewLifecycleStage = LifecycleStage;

impl LifecycleStage {
    /// A stage with Drizzle defaults (`hex = #888888`, empty strings); id is assigned on insert.
    #[must_use]
    pub fn draft(lifecycle_id: &str, slug: &str, label: &str, sort_order: i64) -> Self {
        Self {
            id: String::new(),
            lifecycle_id: lifecycle_id.into(),
            slug: slug.into(),
            sort_order,
            label: label.into(),
            abbreviation: String::new(),
            subtitle: String::new(),
            color: String::new(),
            text_color: String::new(),
            dot_color: String::new(),
            border_color: String::new(),
            hex: "#888888".into(),
            who: String::new(),
            description: String::new(),
            icon: String::new(),
            ai: String::new(),
            output: String::new(),
            docs: Vec::new(),
        }
    }
}
