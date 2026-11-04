//! HTTP transport seam for LLM providers. The canonical types live in [`crate::net`]; this path
//! re-exports them so `ai::transport::*` imports keep working. `Method` is an alias of
//! [`HttpMethod`].

pub use crate::net::{
    FakeTransport, Headers, HttpMethod, HttpMethod as Method, HttpRequest, HttpResponse,
    HttpTransport, NetError,
};
