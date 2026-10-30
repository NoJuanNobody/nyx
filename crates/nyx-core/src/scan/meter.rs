//! Credit metering for scans (agent-native utility tokens, never sold).
//!
//! The scan spends credits per *newly embedded* chunk (cache hits and deduped repeats are free).
//! [`ScanMeter`] is called before each embedding batch; an error stops the scan before the
//! embedder is called, and everything already indexed is kept. [`LedgerMeter`] maps a charge onto
//! the credit ledger (`reserve` then `commit` of the exact amount, idempotent per batch).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::error::Result as CoreResult;
use crate::ledger::{Actor, Command, CommandResult, Credits, LedgerErrorCode, Meta};

/// Metering failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MeterError {
    /// Not enough credits for the next batch.
    #[error("insufficient credits: {0}")]
    Insufficient(String),
    /// Any other ledger failure.
    #[error("metering failed: {0}")]
    Failed(String),
}

/// Charges credits for embedding work.
pub trait ScanMeter: Send + Sync {
    /// Authorise and record the cost of embedding `chunks` new chunks.
    ///
    /// # Errors
    /// [`MeterError::Insufficient`] to stop the scan cleanly.
    fn charge(&self, chunks: usize) -> std::result::Result<(), MeterError>;
}

/// Free: charges nothing (offline use, tests).
#[derive(Debug, Clone, Copy, Default)]
pub struct NoMeter;

impl ScanMeter for NoMeter {
    fn charge(&self, _chunks: usize) -> std::result::Result<(), MeterError> {
        Ok(())
    }
}

/// Records charges and optionally refuses after a budget (tests, dry runs).
#[derive(Debug, Default)]
pub struct CountingMeter {
    charged: Mutex<Vec<usize>>,
    budget: Mutex<Option<usize>>,
}

impl CountingMeter {
    /// Unlimited counting meter.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Refuse once the total would exceed `chunks`.
    #[must_use]
    pub fn with_budget(chunks: usize) -> Self {
        Self {
            charged: Mutex::new(Vec::new()),
            budget: Mutex::new(Some(chunks)),
        }
    }

    /// Chunks charged per call.
    #[must_use]
    pub fn calls(&self) -> Vec<usize> {
        self.charged
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Total chunks charged.
    #[must_use]
    pub fn total(&self) -> usize {
        self.calls().iter().sum()
    }
}

impl ScanMeter for CountingMeter {
    fn charge(&self, chunks: usize) -> std::result::Result<(), MeterError> {
        let mut c = self
            .charged
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let total: usize = c.iter().sum();
        let b = *self
            .budget
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(b) = b {
            if total + chunks > b {
                return Err(MeterError::Insufficient(format!(
                    "need {chunks} more chunks, {} left",
                    b.saturating_sub(total)
                )));
            }
        }
        c.push(chunks);
        Ok(())
    }
}

/// Executes one ledger command. Wrap either an in-memory `Ledger` behind a mutex or a persistent
/// `LedgerService`.
pub type LedgerExec<'a> = dyn Fn(Meta, Command) -> CoreResult<CommandResult> + Send + Sync + 'a;

/// [`ScanMeter`] over the credit ledger: each batch reserves then commits
/// `chunks * credits_per_chunk` from an agent's budget.
pub struct LedgerMeter<'a> {
    exec: &'a LedgerExec<'a>,
    workspace_id: String,
    agent_id: String,
    credits_per_chunk: Credits,
    scan_id: String,
    seq: AtomicU64,
}

impl<'a> LedgerMeter<'a> {
    /// `scan_id` namespaces idempotency keys (use the job id) so distinct jobs never collide.
    /// Batch numbers restart per attempt, so a retried job pays only for work it redoes.
    #[must_use]
    pub fn new(
        exec: &'a LedgerExec<'a>,
        workspace_id: &str,
        agent_id: &str,
        credits_per_chunk: Credits,
        scan_id: &str,
    ) -> Self {
        Self {
            exec,
            workspace_id: workspace_id.to_string(),
            agent_id: agent_id.to_string(),
            credits_per_chunk,
            scan_id: scan_id.to_string(),
            seq: AtomicU64::new(0),
        }
    }
}

impl ScanMeter for LedgerMeter<'_> {
    fn charge(&self, chunks: usize) -> std::result::Result<(), MeterError> {
        let amount = Credits::try_from(chunks)
            .unwrap_or(Credits::MAX)
            .saturating_mul(self.credits_per_chunk);
        if amount <= 0 {
            return Ok(());
        }
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let actor = Actor::new(crate::ledger::ActorKind::Agent, &self.agent_id);
        let map = |e: crate::Error| match e {
            crate::Error::Ledger(l) if l.code == LedgerErrorCode::InsufficientCredits => {
                MeterError::Insufficient(l.message)
            }
            crate::Error::InsufficientCredits { needed, available } => {
                MeterError::Insufficient(format!("need {needed}, have {available}"))
            }
            other => MeterError::Failed(other.to_string()),
        };
        let reserve = (self.exec)(
            Meta::new(&format!("scan:{}:{n}:reserve", self.scan_id), actor.clone())
                .memo("repo scan: embeddings"),
            Command::Reserve {
                workspace_id: self.workspace_id.clone(),
                agent_id: self.agent_id.clone(),
                amount,
                task_type: Some("repo_scan".into()),
                ttl_ms: None,
            },
        )
        .map_err(map)?;
        let reservation = reserve
            .entry
            .reservation_id
            .clone()
            .unwrap_or_else(|| reserve.entry.id.clone());
        (self.exec)(
            Meta::new(&format!("scan:{}:{n}:commit", self.scan_id), actor)
                .memo("repo scan: embeddings"),
            Command::Commit {
                reservation_id: reservation,
                actual_amount: amount,
            },
        )
        .map_err(map)?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::ledger::{ActorKind, Ledger};

    fn funded() -> Mutex<Ledger> {
        let mut l = Ledger::new();
        let sys = Actor::new(ActorKind::System, "t");
        l.execute(
            Meta::new("g", sys.clone()),
            Command::Grant {
                workspace_id: "ws".into(),
                amount: 100,
            },
        )
        .unwrap();
        l.execute(
            Meta::new("a", sys),
            Command::Allocate {
                workspace_id: "ws".into(),
                agent_id: "ag".into(),
                amount: 10,
            },
        )
        .unwrap();
        Mutex::new(l)
    }

    #[test]
    fn counting_meter_budget() {
        let m = CountingMeter::with_budget(5);
        m.charge(3).unwrap();
        assert!(matches!(m.charge(3), Err(MeterError::Insufficient(_))));
        m.charge(2).unwrap();
        assert_eq!(m.total(), 5);
        assert_eq!(m.calls(), vec![3, 2]);
    }

    #[test]
    fn ledger_meter_spends_and_stops_when_empty() {
        let ledger = funded();
        let exec = |meta: Meta, cmd: Command| -> CoreResult<CommandResult> {
            Ok(ledger.lock().unwrap().execute(meta, cmd)?)
        };
        let m = LedgerMeter::new(&exec, "ws", "ag", 2, "job1");
        m.charge(3).unwrap(); // 6 credits
        assert_eq!(ledger.lock().unwrap().total_spent("ws"), 6);
        assert_eq!(ledger.lock().unwrap().agent_balance("ws", "ag"), 4);
        let err = m.charge(3).unwrap_err(); // needs 6, has 4
        assert!(matches!(err, MeterError::Insufficient(_)), "{err:?}");
        m.charge(2).unwrap();
        assert_eq!(ledger.lock().unwrap().total_spent("ws"), 10);
        assert!(ledger.lock().unwrap().verify().is_ok());
    }
}
