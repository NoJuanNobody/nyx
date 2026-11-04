//! Atlassian Cloud: Jira, Confluence, OAuth 3LO and webhooks.
//!
//! - [`oauth`]: PKCE authorise URL, token exchange / refresh / revoke, accessible resources.
//! - [`connection`]: token lifecycle; tokens in the secret store, metadata in `store::integrations`.
//! - [`jira`]: Jira REST v3 builders, parsers and [`jira::JiraClient`].
//! - [`confluence`]: Confluence REST v2 builders, parsers and [`confluence::ConfluenceClient`].
//! - [`adf`]: Markdown to ADF (Jira descriptions, comments) and ADF to text.
//! - [`storage`]: Markdown to Confluence storage format.
//! - [`webhook`]: Jira webhook signature check and payload parsing.

pub mod adf;
pub mod confluence;
pub mod connection;
pub mod jira;
pub mod oauth;
pub mod storage;
pub mod webhook;
