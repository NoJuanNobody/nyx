//! The tool catalogue: names, schemas, cost class and handlers. Every front-end (MCP, CLI,
//! desktop shell) goes through [`registry`], so surface and behaviour cannot drift apart.

use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::args::Args;
use crate::error::AppResult;
use crate::Cx;

/// Operation handler.
pub type Handler = fn(&mut Cx<'_>, &Args<'_>) -> AppResult<Value>;

/// How an operation is metered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cost {
    /// No ledger entry by default (local read/write work). Overridable through the cost table.
    Free,
    /// Default price in credits, reserved before and committed after the work.
    Fixed(i64),
    /// The handler meters itself per unit of work (scan: per embedded chunk).
    PerUnit,
    /// The credit tools themselves: never wrapped in a reservation.
    Ledger,
}

/// External capability an operation needs before it can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Needs {
    /// Nothing.
    Nothing,
    /// A model provider.
    Llm,
    /// A web search backend.
    Search,
}

/// Relationship to the TypeScript MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parity {
    /// Same name and same JSON schema as the TS tool.
    Exact,
    /// Same name; schema extended with extra optional properties.
    Extended,
    /// New in the Rust interface (no TS equivalent).
    New,
}

impl Parity {
    /// Short label for docs.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Extended => "extended",
            Self::New => "new",
        }
    }
}

/// One operation.
pub struct ToolSpec {
    /// Tool name (`nyx_*`).
    pub name: &'static str,
    /// Description shown to agents.
    pub description: &'static str,
    /// Domain / source module group (for the catalogue).
    pub domain: &'static str,
    /// JSON Schema (`type: object`) for the arguments.
    pub schema: Value,
    /// Cost class.
    pub cost: Cost,
    /// Required capability.
    pub needs: Needs,
    /// Parity with the TS server.
    pub parity: Parity,
    /// Whether the tool changes state (hint for clients; surfaced as `readOnlyHint`).
    pub mutates: bool,
    /// Implementation.
    pub handler: Handler,
}

impl std::fmt::Debug for ToolSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolSpec").field("name", &self.name).finish_non_exhaustive()
    }
}

/// Build an object schema.
#[must_use]
pub fn obj(props: Value, required: &[&str]) -> Value {
    let mut s = json!({"type": "object", "properties": props});
    if !required.is_empty() {
        s["required"] = json!(required);
    }
    s
}

/// Like [`obj`] but rejecting unknown properties.
#[must_use]
pub fn strict(props: Value, required: &[&str]) -> Value {
    let mut s = obj(props, required);
    s["additionalProperties"] = json!(false);
    s
}

static REGISTRY: OnceLock<Vec<ToolSpec>> = OnceLock::new();

/// All tools, in catalogue order.
pub fn registry() -> &'static [ToolSpec] {
    REGISTRY.get_or_init(|| {
        let mut v = Vec::new();
        crate::ops::docs::register(&mut v);
        crate::ops::versions::register(&mut v);
        crate::ops::tree::register(&mut v);
        crate::ops::lifecycle::register(&mut v);
        crate::ops::export::register(&mut v);
        crate::ops::tickets::register(&mut v);
        crate::ops::sync::register(&mut v);
        crate::ops::scan::register(&mut v);
        crate::ops::governance::register(&mut v);
        crate::ops::files::register(&mut v);
        crate::ops::system::register(&mut v);
        crate::ops::credit_tools::register(&mut v);
        v
    })
}

/// Look a tool up by name.
#[must_use]
pub fn find(name: &str) -> Option<&'static ToolSpec> {
    registry().iter().find(|t| t.name == name)
}

impl ToolSpec {
    /// New read-only, free, offline tool with no TS equivalent.
    #[must_use]
    pub fn new(
        name: &'static str,
        domain: &'static str,
        description: &'static str,
        schema: Value,
        handler: Handler,
    ) -> Self {
        Self {
            name,
            description,
            domain,
            schema,
            cost: Cost::Free,
            needs: Needs::Nothing,
            parity: Parity::New,
            mutates: false,
            handler,
        }
    }

    /// Set the cost class.
    #[must_use]
    pub fn cost(mut self, c: Cost) -> Self {
        self.cost = c;
        self
    }

    /// Require a capability.
    #[must_use]
    pub fn needs(mut self, n: Needs) -> Self {
        self.needs = n;
        self
    }

    /// Set TS parity.
    #[must_use]
    pub fn parity(mut self, p: Parity) -> Self {
        self.parity = p;
        self
    }

    /// Mark as state-changing.
    #[must_use]
    pub fn mutates(mut self) -> Self {
        self.mutates = true;
        self
    }
}
