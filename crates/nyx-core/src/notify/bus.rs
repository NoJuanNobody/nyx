//! In-process event bus (`pubsub.service.ts`). Per-user subscriptions over `std::sync::mpsc`.
//!
//! The core is synchronous (rusqlite), so std channels are used instead of tokio. A front-end
//! (Tauri) polls or blocks on a [`Subscription`] in its own thread and forwards messages to the UI.
//! Dropping a [`Subscription`] unsubscribes it immediately.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::string_enum;

string_enum! {
    /// Kind of bus message. Wire names match the TS `pubSub` event types.
    BusEvent {
        /// A new notification was inserted.
        NotificationCreated => "notification.created",
        /// An existing unread notification was refreshed by de-duplication.
        NotificationUpdated => "notification.updated",
    }
}

/// A message pushed to subscribers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BusMessage {
    /// What happened.
    pub event: BusEvent,
    /// Event payload (for notifications: `{ "notification": {...} }`).
    pub payload: Value,
}

type Senders = HashMap<String, Vec<(u64, Sender<BusMessage>)>>;

#[derive(Debug, Default)]
struct Inner {
    next_id: u64,
    senders: Senders,
}

/// Cloneable handle to a shared in-process bus.
#[derive(Debug, Clone, Default)]
pub struct EventBus {
    inner: Arc<Mutex<Inner>>,
}

/// Receiving end for one user.
#[derive(Debug)]
pub struct Subscription {
    rx: Receiver<BusMessage>,
    bus: EventBus,
    user_id: String,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut inner = self.bus.lock();
        if let Some(v) = inner.senders.get_mut(&self.user_id) {
            v.retain(|(id, _)| *id != self.id);
            if v.is_empty() {
                inner.senders.remove(&self.user_id);
            }
        }
    }
}

impl Subscription {
    /// Next message if one is already queued.
    #[must_use]
    pub fn try_recv(&self) -> Option<BusMessage> {
        self.rx.try_recv().ok()
    }

    /// Wait up to `timeout` for the next message.
    #[must_use]
    pub fn recv_timeout(&self, timeout: Duration) -> Option<BusMessage> {
        self.rx.recv_timeout(timeout).ok()
    }

    /// Drain everything queued right now.
    #[must_use]
    pub fn drain(&self) -> Vec<BusMessage> {
        std::iter::from_fn(|| self.try_recv()).collect()
    }
}

impl EventBus {
    /// New empty bus.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means a subscriber thread panicked; the map is still valid.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Subscribe to messages addressed to `user_id`. Multiple subscriptions per user are allowed.
    #[must_use]
    pub fn subscribe(&self, user_id: &str) -> Subscription {
        let (tx, rx) = channel();
        let mut inner = self.lock();
        inner.next_id += 1;
        let id = inner.next_id;
        inner
            .senders
            .entry(user_id.to_string())
            .or_default()
            .push((id, tx));
        Subscription {
            rx,
            bus: self.clone(),
            user_id: user_id.to_string(),
            id,
        }
    }

    /// Deliver to every live subscription of `user_id`; returns how many received it.
    pub fn publish(&self, user_id: &str, message: &BusMessage) -> usize {
        let mut inner = self.lock();
        let Some(senders) = inner.senders.get_mut(user_id) else {
            return 0;
        };
        senders.retain(|(_, s)| s.send(message.clone()).is_ok());
        let delivered = senders.len();
        if senders.is_empty() {
            inner.senders.remove(user_id);
        }
        delivered
    }

    /// Deliver the same message to several users; returns total deliveries.
    pub fn publish_to_many(&self, user_ids: &[String], message: &BusMessage) -> usize {
        user_ids.iter().map(|u| self.publish(u, message)).sum()
    }

    /// Live subscriptions for a user. Dropping a [`Subscription`] removes it immediately.
    #[must_use]
    pub fn connection_count(&self, user_id: &str) -> usize {
        self.lock().senders.get(user_id).map_or(0, Vec::len)
    }
}
