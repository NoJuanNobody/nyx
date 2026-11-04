//! Slack integration: Web API client, Block Kit helpers, OAuth v2 install, request signature
//! verification, Events API / slash command parsing, and the workspace-link store.
//!
//! Ports `slack.service.ts` and `routes/slack.ts`.
//!
//! - [`api`]: `chat.postMessage`, `conversations.list`, `auth.test`, `response_url` replies.
//! - [`blocks`]: small Block Kit builders and mrkdwn escaping.
//! - [`events`]: `X-Slack-Signature` verification (5 minute replay window), event and command
//!   parsing, trigger-emoji / monitored-channel routing, message intake summary.
//! - [`oauth`]: install URL and `oauth.v2.access` exchange.
//! - [`store`]: `slack_connections` metadata; the bot token lives in the secret store.

pub mod api;
pub mod blocks;
pub mod events;
pub mod oauth;
pub mod store;
