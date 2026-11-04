//! HTTP transport seam for git providers. The canonical types live in [`crate::net`]; this path
//! re-exports them so `git_provider::transport::*` imports keep working.

pub use crate::net::{
    FakeTransport, Headers, HttpMethod, HttpRequest, HttpResponse, HttpTransport, NetError,
};
