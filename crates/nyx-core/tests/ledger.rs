#![allow(
    clippy::assert_is_empty,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    clippy::similar_names,
    clippy::unwrap_used,
    clippy::expect_used,
    missing_docs
)]
use nyx_core::ledger::*;
use nyx_core::store::{Db, SqliteLedgerStore};
use nyx_core::{Error, Result};

const WS: &str = "local";
const AG: &str = "claude-code";

fn user() -> Actor {
    Actor::local_user()
}
fn meta(key: &str, at: i64) -> Meta {
    Meta::new(key, user()).at(at)
}
fn grant(n: i64) -> Command {
    Command::Grant {
        workspace_id: WS.into(),
        amount: n,
    }
}
fn alloc(n: i64) -> Command {
    Command::Allocate {
        workspace_id: WS.into(),
        agent_id: AG.into(),
        amount: n,
    }
}
fn reserve(n: i64, ttl: Option<i64>) -> Command {
    Command::Reserve {
        workspace_id: WS.into(),
        agent_id: AG.into(),
        amount: n,
        task_type: Some("scan".into()),
        ttl_ms: ttl,
    }
}
fn code(r: &std::result::Result<CommandResult, LedgerError>) -> LedgerErrorCode {
    r.as_ref().unwrap_err().code
}

fn funded() -> Ledger {
    let mut l = Ledger::new();
    l.execute(meta("g", 1000), grant(100)).unwrap();
    l.execute(meta("a", 2000), alloc(40)).unwrap();
    l
}

fn sum_all(l: &Ledger) -> i64 {
    l.entries()
        .iter()
        .flat_map(|e| e.postings.iter())
        .map(|p| p.amount)
        .sum()
}

// ── cross-language conformance ───────────────────────

#[test]
fn hashes_match_the_typescript_reference_implementation() {
    // Golden values produced by replaying the same commands through the reference `canonical()` +
    // sha256 from apps/api/src/services/credit-ledger.service.ts.
    let mut l = Ledger::new();
    let e1 = l
        .execute(Meta::new("k1", user()).memo("init").at(1000), grant(100))
        .unwrap()
        .entry;
    let e2 = l.execute(meta("k2", 2000), alloc(40)).unwrap().entry;
    let e3 = l
        .execute(meta("k3", 3000), reserve(10, Some(60_000)))
        .unwrap()
        .entry;
    let e4 = l
        .execute(
            meta("k4", 4000),
            Command::Commit {
                reservation_id: e3.id.clone(),
                actual_amount: 7,
            },
        )
        .unwrap()
        .entry;
    let golden = [
        (
            "96ce9d1512cfee8cb6948020335dc0dd4f5cc9584b7bf917bfe0710e6aa003ea",
            "3f69c43e29f816ad34dc5dc155828544b86fd2480ef2f6c74ed9944b91afddd1",
        ),
        (
            "dd1447daeb3c10d7d3a66f18a05e3c8e5c43680a4b498d0d375b92faac8cc9f9",
            "f85f8367075bb72dad1979b9fca783d11be0aef7b524fbecc4cd84e497ccbf50",
        ),
        (
            "86327fabd1d1d0605884939cef4c1e21366c309d3102b51d1c569caa451b9d90",
            "1812251add9f18e0510020355267832d621a72b75dc5465132717a941c3c6931",
        ),
        (
            "6edffe2e51bce592cb2f4107923fa141c436d380ace7b817ac274a926ba53820",
            "538988d1700d39388a392ab8ae15328ef10fecaa2a7f34b53e774a0d6a3027c4",
        ),
    ];
    for (e, (fp, h)) in [&e1, &e2, &e3, &e4].into_iter().zip(golden) {
        assert_eq!(e.fingerprint, fp, "fingerprint seq {}", e.seq);
        assert_eq!(e.hash, h, "hash seq {}", e.seq);
    }
}

#[test]
fn canonical_json_sorts_keys_and_keeps_nulls() {
    let v = serde_json::json!({"b": 1, "a": [3, {"z": null, "y": "x\"q"}], "c": null});
    assert_eq!(
        canonical(&v),
        r#"{"a":[3,{"y":"x\"q","z":null}],"b":1,"c":null}"#
    );
}

// ── semantics ────────────────────────────────────────

#[test]
fn recipes_balance_and_conserve() {
    let mut l = funded();
    assert_eq!(
        (
            l.pool_balance(WS),
            l.agent_balance(WS, AG),
            l.balance(ISSUER_ACCOUNT)
        ),
        (60, 40, -100)
    );
    let r = l.execute(meta("r", 3000), reserve(10, None)).unwrap().entry;
    assert_eq!(r.id, "le_000000000003");
    assert_eq!((l.agent_balance(WS, AG), l.agent_held(WS, AG)), (30, 10));
    let c = l
        .execute(
            meta("c", 4000),
            Command::Commit {
                reservation_id: r.id.clone(),
                actual_amount: 6,
            },
        )
        .unwrap()
        .entry;
    assert_eq!(
        (
            l.agent_balance(WS, AG),
            l.total_spent(WS),
            l.agent_held(WS, AG)
        ),
        (34, 6, 0)
    );
    l.execute(
        meta("f", 5000),
        Command::Refund {
            commit_entry_id: c.id,
            amount: 2,
        },
    )
    .unwrap();
    assert_eq!((l.agent_balance(WS, AG), l.total_spent(WS)), (36, 4));
    l.execute(
        meta("d", 6000),
        Command::Deallocate {
            workspace_id: WS.into(),
            agent_id: AG.into(),
            amount: 36,
        },
    )
    .unwrap();
    assert_eq!((l.pool_balance(WS), l.agent_balance(WS, AG)), (96, 0));
    assert_eq!(sum_all(&l), 0, "double entry: every posting sums to zero");
    l.verify().unwrap();
}

#[test]
fn zero_actual_commit_returns_everything() {
    let mut l = funded();
    let r = l.execute(meta("r", 3000), reserve(10, None)).unwrap().entry;
    let c = l
        .execute(
            meta("c", 4000),
            Command::Commit {
                reservation_id: r.id,
                actual_amount: 0,
            },
        )
        .unwrap()
        .entry;
    assert_eq!(c.postings.len(), 2);
    assert_eq!((l.agent_balance(WS, AG), l.total_spent(WS)), (40, 0));
}

#[test]
fn never_negative_overdraft_is_rejected_and_appends_nothing() {
    let mut l = funded();
    let n = l.entries().len();
    assert_eq!(
        code(&l.execute(meta("x1", 3000), alloc(61))),
        LedgerErrorCode::InsufficientCredits
    );
    assert_eq!(
        code(&l.execute(meta("x2", 3000), reserve(41, None))),
        LedgerErrorCode::InsufficientCredits
    );
    assert_eq!(
        code(&l.execute(
            meta("x3", 3000),
            Command::Deallocate {
                workspace_id: WS.into(),
                agent_id: AG.into(),
                amount: 41
            }
        )),
        LedgerErrorCode::InsufficientCredits
    );
    assert_eq!(
        code(&l.execute(
            meta("x4", 3000),
            Command::Allocate {
                workspace_id: WS.into(),
                agent_id: "other".into(),
                amount: 61
            }
        )),
        LedgerErrorCode::InsufficientCredits
    );
    assert_eq!(l.entries().len(), n);
    // concurrent holds count against the same budget
    l.execute(meta("h1", 3000), reserve(30, None)).unwrap();
    assert_eq!(
        code(&l.execute(meta("h2", 3000), reserve(11, None))),
        LedgerErrorCode::InsufficientCredits
    );
    l.execute(meta("h3", 3000), reserve(10, None)).unwrap();
    assert_eq!(l.agent_balance(WS, AG), 0);
    // rejected key can be reused for a valid request (nothing was recorded)
    assert!(l.execute(meta("x1", 3001), alloc(5)).is_ok());
    for acct in [pool_account(WS), agent_account(WS, AG), spent_account(WS)] {
        assert!(l.balance(&acct) >= 0);
    }
}

#[test]
fn invalid_inputs_are_rejected() {
    let mut l = Ledger::new();
    assert_eq!(
        code(&l.execute(meta("a", 1), grant(0))),
        LedgerErrorCode::InvalidAmount
    );
    assert_eq!(
        code(&l.execute(meta("a", 1), grant(-5))),
        LedgerErrorCode::InvalidAmount
    );
    assert_eq!(
        code(&l.execute(meta("a", 1), grant(i64::MAX))),
        LedgerErrorCode::InvalidAmount
    );
    assert_eq!(
        code(&l.execute(meta("", 1), grant(1))),
        LedgerErrorCode::InvalidInput
    );
    assert_eq!(
        code(&l.execute(
            meta("a", 1),
            Command::Grant {
                workspace_id: "a:b".into(),
                amount: 1
            }
        )),
        LedgerErrorCode::InvalidInput
    );
    assert_eq!(
        code(&l.execute(
            meta("a", 1),
            Command::Grant {
                workspace_id: "a b".into(),
                amount: 1
            }
        )),
        LedgerErrorCode::InvalidInput
    );
    assert_eq!(
        code(&l.execute(
            meta("a", 1),
            Command::Grant {
                workspace_id: String::new(),
                amount: 1
            }
        )),
        LedgerErrorCode::InvalidInput
    );
    assert_eq!(
        code(&l.execute(meta("a", 1), reserve(1, Some(0)))),
        LedgerErrorCode::InvalidAmount
    );
    assert_eq!(
        code(&l.execute(
            meta("a", 1),
            Command::Commit {
                reservation_id: "x".into(),
                actual_amount: -1
            }
        )),
        LedgerErrorCode::InvalidAmount
    );
    assert!(l.entries().is_empty());
}

#[test]
fn idempotency_replay_and_conflict() {
    let mut l = Ledger::new();
    let first = l
        .execute(Meta::new("k", user()).memo("one").at(10), grant(100))
        .unwrap();
    assert!(!first.replayed);
    // same payload, different memo/actor/time: replay of the original entry
    let again = l
        .execute(
            Meta::new("k", Actor::new(ActorKind::System, "x"))
                .memo("two")
                .at(99),
            grant(100),
        )
        .unwrap();
    assert!(again.replayed);
    assert_eq!(again.entry, first.entry);
    assert_eq!(l.entries().len(), 1);
    assert_eq!(l.pool_balance(WS), 100);
    // different payload under same key
    assert_eq!(
        code(&l.execute(meta("k", 11), grant(101))),
        LedgerErrorCode::IdempotencyConflict
    );
    assert_eq!(
        code(&l.execute(
            meta("k", 11),
            Command::Grant {
                workspace_id: "other".into(),
                amount: 100
            }
        )),
        LedgerErrorCode::IdempotencyConflict
    );
    assert_eq!(l.entries().len(), 1);
    assert_eq!(
        l.balance(ISSUER_ACCOUNT),
        -100,
        "replay must not mint twice"
    );
}

#[test]
fn reservation_lifecycle_rules() {
    let mut l = funded();
    let r = l
        .execute(meta("r", 3000), reserve(10, Some(1000)))
        .unwrap()
        .entry;
    assert_eq!(r.expires_at, Some(4000));
    // missing / over-reserved
    assert_eq!(
        code(&l.execute(
            meta("c0", 3100),
            Command::Commit {
                reservation_id: "le_nope".into(),
                actual_amount: 1
            }
        )),
        LedgerErrorCode::ReservationNotFound
    );
    assert_eq!(
        code(&l.execute(
            meta("c1", 3100),
            Command::Commit {
                reservation_id: r.id.clone(),
                actual_amount: 11
            }
        )),
        LedgerErrorCode::OverReserved
    );
    // commit after expiry is rejected
    assert_eq!(
        code(&l.execute(
            meta("c2", 4000),
            Command::Commit {
                reservation_id: r.id.clone(),
                actual_amount: 1
            }
        )),
        LedgerErrorCode::ReservationExpired
    );
    // a valid commit closes it exactly once
    l.execute(
        meta("c3", 3500),
        Command::Commit {
            reservation_id: r.id.clone(),
            actual_amount: 4,
        },
    )
    .unwrap();
    assert_eq!(
        code(&l.execute(
            meta("c4", 3600),
            Command::Commit {
                reservation_id: r.id.clone(),
                actual_amount: 4
            }
        )),
        LedgerErrorCode::ReservationClosed
    );
    assert_eq!(
        code(&l.execute(
            meta("c5", 3600),
            Command::Release {
                reservation_id: r.id.clone()
            }
        )),
        LedgerErrorCode::ReservationClosed
    );
    assert_eq!(
        l.reservation(&r.id).unwrap().status,
        ReservationStatus::Committed
    );
}

#[test]
fn release_returns_hold() {
    let mut l = funded();
    let r = l.execute(meta("r", 3000), reserve(10, None)).unwrap().entry;
    l.execute(
        meta("rel", 3100),
        Command::Release {
            reservation_id: r.id.clone(),
        },
    )
    .unwrap();
    assert_eq!((l.agent_balance(WS, AG), l.agent_held(WS, AG)), (40, 0));
    assert_eq!(
        l.reservation(&r.id).unwrap().status,
        ReservationStatus::Released
    );
}

#[test]
fn expire_due_is_idempotent_and_releases_only_due_holds() {
    let mut l = funded();
    let a = l
        .execute(meta("r1", 3000), reserve(10, Some(1000)))
        .unwrap()
        .entry;
    let b = l
        .execute(meta("r2", 3000), reserve(5, Some(9000)))
        .unwrap()
        .entry;
    l.execute(meta("r3", 3000), reserve(5, None)).unwrap();
    assert!(l.expire_due(3999).unwrap().is_empty());
    let out = l.expire_due(4000).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].reservation_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(out[0].actor, Actor::new(ActorKind::System, "expiry"));
    assert_eq!(out[0].idempotency_key, format!("expire:{}", a.id));
    assert!(
        l.expire_due(4000).unwrap().is_empty(),
        "second run does nothing"
    );
    assert_eq!(l.agent_held(WS, AG), 10);
    assert_eq!(
        l.reservation(&b.id).unwrap().status,
        ReservationStatus::Open
    );
    assert_eq!(l.expire_due(20_000).unwrap().len(), 1);
    assert_eq!(
        l.agent_held(WS, AG),
        5,
        "reservation without ttl never expires"
    );
}

#[test]
fn refund_rules() {
    let mut l = funded();
    let r = l.execute(meta("r", 3000), reserve(10, None)).unwrap().entry;
    let c = l
        .execute(
            meta("c", 3100),
            Command::Commit {
                reservation_id: r.id.clone(),
                actual_amount: 8,
            },
        )
        .unwrap()
        .entry;
    assert_eq!(
        code(&l.execute(
            meta("f0", 4000),
            Command::Refund {
                commit_entry_id: "le_zzz".into(),
                amount: 1
            }
        )),
        LedgerErrorCode::EntryNotFound
    );
    assert_eq!(
        code(&l.execute(
            meta("f1", 4000),
            Command::Refund {
                commit_entry_id: r.id.clone(),
                amount: 1
            }
        )),
        LedgerErrorCode::NotACommit
    );
    l.execute(
        meta("f2", 4000),
        Command::Refund {
            commit_entry_id: c.id.clone(),
            amount: 5,
        },
    )
    .unwrap();
    assert_eq!(
        code(&l.execute(
            meta("f3", 4000),
            Command::Refund {
                commit_entry_id: c.id.clone(),
                amount: 4
            }
        )),
        LedgerErrorCode::OverRefund
    );
    l.execute(
        meta("f4", 4000),
        Command::Refund {
            commit_entry_id: c.id.clone(),
            amount: 3,
        },
    )
    .unwrap();
    assert_eq!(
        code(&l.execute(
            meta("f5", 4000),
            Command::Refund {
                commit_entry_id: c.id.clone(),
                amount: 1
            }
        )),
        LedgerErrorCode::OverRefund
    );
    assert_eq!(l.commit_record(&c.id).unwrap().refunded, 8);
    // refunds return to the same agent budget, never the pool
    assert_eq!(
        (
            l.agent_balance(WS, AG),
            l.pool_balance(WS),
            l.total_spent(WS)
        ),
        (40, 60, 0)
    );
}

#[test]
fn workspaces_are_isolated() {
    let mut l = funded();
    l.execute(
        meta("g2", 1),
        Command::Grant {
            workspace_id: "team".into(),
            amount: 5,
        },
    )
    .unwrap();
    assert_eq!(l.pool_balance("team"), 5);
    assert_eq!(l.pool_balance(WS), 60);
    // an agent allocated in `local` cannot spend from `team`: allocation drains team's own pool only
    assert_eq!(
        code(&l.execute(
            meta("a2", 2),
            Command::Allocate {
                workspace_id: "team".into(),
                agent_id: AG.into(),
                amount: 6
            }
        )),
        LedgerErrorCode::InsufficientCredits
    );
    for e in l.entries().iter().filter(|e| e.kind != EntryKind::Grant) {
        let prefix = format!("ws:{}:", e.workspace_id);
        assert!(e.postings.iter().all(|p| p.account.starts_with(&prefix)));
    }
}

#[test]
fn tampering_is_detected_on_load() {
    let mut l = funded();
    l.execute(meta("r", 3000), reserve(10, None)).unwrap();
    let good: Vec<LedgerEntry> = l.entries().to_vec();
    Ledger::from_entries(&good).unwrap();

    let chain = |entries: &[LedgerEntry]| Ledger::from_entries(entries).unwrap_err().code;

    let mut t = good.clone();
    t[1].memo = "edited".into();
    assert_eq!(chain(&t), LedgerErrorCode::ChainBroken);

    let mut t = good.clone();
    t.remove(1);
    assert_eq!(chain(&t), LedgerErrorCode::ChainBroken);

    let mut t = good.clone();
    t.swap(1, 2);
    assert_eq!(chain(&t), LedgerErrorCode::ChainBroken);

    // Re-hashed forgery: inflate a posting and fix the hash; chain of later entries then breaks,
    // and a forged tail entry is caught by the conservation invariant.
    let mut t = good.clone();
    let last = t.len() - 1;
    t[last].postings[0].amount -= 1;
    t[last].hash = entry_hash(&t[last]);
    assert_eq!(chain(&t), LedgerErrorCode::InvariantViolation);

    // Forged overdraft with a valid hash chain.
    let mut forged = good[..2].to_vec();
    let mut e = forged[1].clone();
    e.seq = 3;
    e.id = "le_000000000003".into();
    e.idempotency_key = "evil".into();
    e.prev_hash = forged[1].hash.clone();
    e.postings = vec![
        Posting {
            account: pool_account(WS),
            amount: -1_000,
        },
        Posting {
            account: agent_account(WS, AG),
            amount: 1_000,
        },
    ];
    e.hash = entry_hash(&e);
    forged.push(e);
    assert_eq!(chain(&forged), LedgerErrorCode::InsufficientCredits);

    // Forged mint by a non-grant entry.
    let mut e = good[1].clone();
    e.seq = 3;
    e.idempotency_key = "mint".into();
    e.prev_hash = good[1].hash.clone();
    e.postings = vec![
        Posting {
            account: ISSUER_ACCOUNT.into(),
            amount: -50,
        },
        Posting {
            account: pool_account(WS),
            amount: 50,
        },
    ];
    e.hash = entry_hash(&e);
    let mut forged = good[..2].to_vec();
    forged.push(e);
    assert_eq!(chain(&forged), LedgerErrorCode::InvariantViolation);
}

#[test]
fn issuer_always_equals_minus_total_granted() {
    let mut l = Ledger::new();
    let mut granted = 0;
    for (i, n) in [10, 25, 7].into_iter().enumerate() {
        l.execute(meta(&format!("g{i}"), 1), grant(n)).unwrap();
        granted += n;
        assert_eq!(l.balance(ISSUER_ACCOUNT), -granted);
    }
}

// ── SQLite store ─────────────────────────────────────

fn svc(db: &Db) -> LedgerService<SqliteLedgerStore<'_>> {
    LedgerService::open(SqliteLedgerStore::new(db.conn())).unwrap()
}

#[test]
fn sqlite_persists_and_reloads_with_identical_hashes() -> Result<()> {
    let db = Db::open_in_memory()?;
    let (h, entries) = {
        let mut s = svc(&db);
        s.execute(meta("g", 1000), grant(100))?;
        s.execute(meta("a", 2000), alloc(40))?;
        let r = s.execute(meta("r", 3000), reserve(10, Some(5000)))?.entry;
        s.execute(
            meta("c", 4000),
            Command::Commit {
                reservation_id: r.id,
                actual_amount: 7,
            },
        )?;
        (
            s.ledger().head_hash().to_owned(),
            s.ledger().entries().to_vec(),
        )
    };
    let s = svc(&db);
    assert_eq!(s.ledger().head_hash(), h);
    assert_eq!(s.ledger().entries(), entries.as_slice());
    assert_eq!(s.ledger().agent_balance(WS, AG), 33);

    // SQL SUM agrees with the in-memory fold for every account
    let store = SqliteLedgerStore::new(db.conn());
    for (acct, bal) in store.balances()? {
        assert_eq!(bal, s.ledger().balance(&acct), "{acct}");
    }
    assert_eq!(store.balance("issuer")?, -100);
    Ok(())
}

#[test]
fn sqlite_replay_does_not_duplicate_rows() -> Result<()> {
    let db = Db::open_in_memory()?;
    let mut s = svc(&db);
    s.execute(meta("g", 1), grant(10))?;
    let again = s.execute(meta("g", 2), grant(10))?;
    assert!(again.replayed);
    let n: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM credit_entries", [], |r| r.get(0))?;
    assert_eq!(n, 1);
    assert!(
        matches!(s.execute(meta("g", 3), grant(11)), Err(Error::Ledger(e)) if e.code == LedgerErrorCode::IdempotencyConflict)
    );
    Ok(())
}

#[test]
fn sqlite_rejected_command_appends_nothing() -> Result<()> {
    let db = Db::open_in_memory()?;
    let mut s = svc(&db);
    s.execute(meta("g", 1), grant(10))?;
    assert!(
        matches!(s.execute(meta("a", 2), alloc(11)), Err(Error::Ledger(e)) if e.code == LedgerErrorCode::InsufficientCredits)
    );
    let n: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM credit_entries", [], |r| r.get(0))?;
    assert_eq!(n, 1);
    Ok(())
}

#[test]
fn sqlite_tables_are_append_only() -> Result<()> {
    let db = Db::open_in_memory()?;
    svc(&db).execute(meta("g", 1), grant(10))?;
    for sql in [
        "UPDATE credit_entries SET memo='x'",
        "DELETE FROM credit_entries",
        "UPDATE credit_postings SET amount=amount+1",
        "DELETE FROM credit_postings",
    ] {
        let err = db.conn().execute(sql, []).unwrap_err().to_string();
        assert!(err.contains("append-only"), "{sql}: {err}");
    }
    let zero = db.conn().execute(
        "INSERT INTO credit_postings (entry_seq,idx,account,amount) VALUES (1,9,'x',0)",
        [],
    );
    assert!(zero.is_err(), "zero postings are rejected by CHECK");
    Ok(())
}

#[test]
fn sqlite_expiry_persists_releases() -> Result<()> {
    let db = Db::open_in_memory()?;
    let mut s = svc(&db);
    s.execute(meta("g", 1), grant(100))?;
    s.execute(meta("a", 2), alloc(10))?;
    s.execute(meta("r", 1000), reserve(10, Some(100)))?;
    let out = s.expire_due(2000)?;
    assert_eq!(out.len(), 1);
    drop(s);
    let s = svc(&db);
    assert_eq!(s.ledger().agent_balance(WS, AG), 10);
    assert_eq!(s.ledger().entries().len(), 4);
    Ok(())
}

#[test]
fn stale_service_reloads_and_retries_after_a_competing_writer() -> Result<()> {
    let db = Db::open_in_memory()?;
    let mut a = svc(&db);
    let mut b = svc(&db);
    a.execute(meta("g", 1), grant(100))?;
    // `b` has not seen the grant; its own command extends a stale tail, loses the race, reloads, retries.
    let r = b.execute(
        meta("g2", 2),
        Command::Grant {
            workspace_id: "other".into(),
            amount: 5,
        },
    )?;
    assert_eq!(r.entry.seq, 2);
    assert_eq!(b.ledger().entries().len(), 2);
    // `a` is now stale too, and a replayed key must be detected after reload
    let r = a.execute(
        meta("g2", 3),
        Command::Grant {
            workspace_id: "other".into(),
            amount: 5,
        },
    )?;
    assert_eq!(r.entry.seq, 2);
    let n: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM credit_entries", [], |r| r.get(0))?;
    assert_eq!(n, 2);
    Ok(())
}

#[test]
fn sqlite_store_rejects_non_extending_append() -> Result<()> {
    let db = Db::open_in_memory()?;
    let mut l = Ledger::new();
    let e = l.execute(meta("g", 1), grant(1)).unwrap().entry;
    let mut store = SqliteLedgerStore::new(db.conn());
    store.append(&e)?;
    assert!(matches!(store.append(&e), Err(Error::Conflict(_))));
    Ok(())
}

#[test]
fn sqlite_append_participates_in_caller_transaction() -> Result<()> {
    let mut db = Db::open_in_memory()?;
    let res: Result<()> = db.transaction(|c| {
        let mut s = LedgerService::open(SqliteLedgerStore::new(c))?;
        s.execute(meta("g", 1), grant(10))?;
        Err(Error::Invalid("rollback me".into()))
    });
    assert!(res.is_err());
    let n: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM credit_entries", [], |r| r.get(0))?;
    assert_eq!(n, 0);

    db.transaction(|c| {
        let mut s = LedgerService::open(SqliteLedgerStore::new(c))?;
        s.execute(meta("g", 1), grant(10))?;
        Ok(())
    })?;
    assert_eq!(svc(&db).ledger().pool_balance(WS), 10);
    Ok(())
}

#[test]
fn memory_store_service_works() -> Result<()> {
    let mut s = LedgerService::open(MemoryLedgerStore::default())?;
    s.execute(meta("g", 1), grant(3))?;
    assert_eq!(s.store().load_all()?.len(), 1);
    Ok(())
}
