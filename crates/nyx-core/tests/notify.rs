#![allow(
    clippy::assert_is_empty,
    clippy::many_single_char_names,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_lines,
    clippy::similar_names,
    missing_docs
)]
//! Notification fan-out, preference filtering, de-duplication, inbox and email tests.

mod common;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use common::{fixture, Fixture};
use nyx_core::model::{NewUser, User};
use nyx_core::notify::{
    build_digest_email, build_notification_email, BusEvent, Clock, CreateNotification,
    CreateOutcome, DigestItem, EmailDeliveryStatus, EmailMode, EventBus, EventFilter, FakeMailer,
    FakeNotifier, InboxQuery, NotificationEvent, NotificationRepo, NotificationService,
    PreferenceInput, PreferenceUpdate, SqliteNotifications,
};
use nyx_core::store::{SqliteUsers, UserRepo};

const T0: i64 = 1_700_000_000_000;

fn clock() -> (Arc<AtomicI64>, Clock) {
    let t = Arc::new(AtomicI64::new(T0));
    let t2 = t.clone();
    (t, Clock::new(move || t2.load(Ordering::SeqCst)))
}

fn other_user(f: &Fixture, email: &str) -> User {
    SqliteUsers::new(f.db.conn())
        .create(&NewUser {
            email: email.into(),
            name: "Bob".into(),
            avatar_url: None,
        })
        .unwrap()
}

fn input(f: &Fixture, event: NotificationEvent, title: &str) -> CreateNotification {
    CreateNotification::new(&f.user.id, &f.team.id, event, title)
}

#[test]
fn create_fans_out_to_inbox_bus_desktop_and_email_queue() {
    let f = fixture();
    let bob = other_user(&f, "bob@example.com");
    let bus = EventBus::new();
    let mine_a = bus.subscribe(&f.user.id);
    let mine_b = bus.subscribe(&f.user.id);
    let theirs = bus.subscribe(&bob.id);
    let notifier = Arc::new(FakeNotifier::new());
    let mailer = Arc::new(FakeMailer::new());
    let svc = NotificationService::new(f.db.conn(), bus.clone())
        .with_notifier(notifier.clone())
        .with_mailer(mailer.clone());

    let out = svc
        .create(&input(&f, NotificationEvent::TicketCreated, "New ticket").body("Fix login"))
        .unwrap();
    let CreateOutcome::Created(n) = out else {
        panic!("expected Created")
    };
    assert_eq!(n.event_type, "ticket.created");
    assert!(n.read_at.is_none());

    for sub in [&mine_a, &mine_b] {
        let msgs = sub.drain();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].event, BusEvent::NotificationCreated);
        assert_eq!(msgs[0].payload["notification"]["id"], n.id.as_str());
    }
    assert!(theirs.drain().is_empty(), "other users receive nothing");

    let shown = notifier.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title, "New ticket");

    // Default preference is a daily digest: queued, nothing sent yet.
    assert!(mailer.sent().is_empty());
    let log = SqliteNotifications::new(f.db.conn())
        .email_log(&f.user.id)
        .unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].1, EmailDeliveryStatus::Queued);

    assert_eq!(svc.send_digest(&f.user.id).unwrap(), 1);
    let sent = mailer.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, "a@example.com");
    assert_eq!(sent[0].subject, "Nyx digest \u{2014} 1 notification");
    assert!(sent[0].html.contains("New ticket"));
    let log = SqliteNotifications::new(f.db.conn())
        .email_log(&f.user.id)
        .unwrap();
    assert_eq!(log[0].1, EmailDeliveryStatus::Sent);
    assert_eq!(
        svc.send_digest(&f.user.id).unwrap(),
        0,
        "nothing left to send"
    );
}

#[test]
fn dropped_subscription_unsubscribes() {
    let bus = EventBus::new();
    let a = bus.subscribe("u");
    let b = bus.subscribe("u");
    assert_eq!(bus.connection_count("u"), 2);
    drop(a);
    assert_eq!(bus.connection_count("u"), 1);
    drop(b);
    assert_eq!(bus.connection_count("u"), 0);
    let msg = nyx_core::notify::BusMessage {
        event: BusEvent::NotificationUpdated,
        payload: serde_json::json!({}),
    };
    assert_eq!(bus.publish("u", &msg), 0);
    let c = bus.subscribe("x");
    let d = bus.subscribe("y");
    assert_eq!(
        bus.publish_to_many(&["x".into(), "y".into(), "z".into()], &msg),
        2
    );
    assert_eq!(c.drain().len() + d.drain().len(), 2);
}

#[test]
fn in_app_preference_false_skips_everything() {
    let f = fixture();
    let bus = EventBus::new();
    let sub = bus.subscribe(&f.user.id);
    let notifier = Arc::new(FakeNotifier::new());
    let mailer = Arc::new(FakeMailer::new());
    let svc = NotificationService::new(f.db.conn(), bus)
        .with_notifier(notifier.clone())
        .with_mailer(mailer.clone());
    svc.update_preference(
        &f.user.id,
        "ticket.created",
        &PreferenceUpdate {
            in_app: Some(false),
            ..PreferenceUpdate::default()
        },
    )
    .unwrap();

    let out = svc
        .create(&input(&f, NotificationEvent::TicketCreated, "muted"))
        .unwrap();
    assert_eq!(out, CreateOutcome::Skipped);
    assert!(out.notification().is_none());
    assert_eq!(svc.unread_count(&f.user.id).unwrap(), 0);
    assert!(sub.drain().is_empty());
    assert!(notifier.shown().is_empty());
    assert!(SqliteNotifications::new(f.db.conn())
        .email_log(&f.user.id)
        .unwrap()
        .is_empty());

    // Other event types are unaffected.
    let out = svc
        .create(&input(&f, NotificationEvent::TicketUpdated, "visible"))
        .unwrap();
    assert!(matches!(out, CreateOutcome::Created(_)));
    assert_eq!(svc.unread_count(&f.user.id).unwrap(), 1);
}

#[test]
fn dedup_refreshes_unread_notification_within_window() {
    let f = fixture();
    let (t, clk) = clock();
    let bus = EventBus::new();
    let sub = bus.subscribe(&f.user.id);
    let notifier = Arc::new(FakeNotifier::new());
    let svc = NotificationService::new(f.db.conn(), bus)
        .with_clock(clk)
        .with_notifier(notifier.clone());

    let first = svc
        .create(
            &input(&f, NotificationEvent::DriftDetected, "Drift")
                .body("v1")
                .entity("doc-1"),
        )
        .unwrap();
    let id = first.notification().unwrap().id.clone();
    t.store(T0 + 5 * 60 * 1000, Ordering::SeqCst);
    let second = svc
        .create(
            &input(&f, NotificationEvent::DriftDetected, "Drift")
                .body("v2")
                .entity("doc-1"),
        )
        .unwrap();
    let CreateOutcome::Updated(n) = second else {
        panic!("expected Updated")
    };
    assert_eq!(n.id, id);
    assert_eq!(n.body.as_deref(), Some("v2"));
    assert_eq!(
        n.created_at,
        T0 + 5 * 60 * 1000,
        "refresh bumps the timestamp"
    );
    assert_eq!(
        svc.inbox(&InboxQuery {
            user_id: f.user.id.clone(),
            ..InboxQuery::default()
        })
        .unwrap()
        .items
        .len(),
        1
    );

    let events: Vec<_> = sub.drain().into_iter().map(|m| m.event).collect();
    assert_eq!(
        events,
        vec![BusEvent::NotificationCreated, BusEvent::NotificationUpdated]
    );
    assert_eq!(
        notifier.shown().len(),
        1,
        "desktop notification only for new rows"
    );

    // Refresh without a body keeps the previous body (TS `input ?? existing`).
    t.store(T0 + 6 * 60 * 1000, Ordering::SeqCst);
    let third = svc
        .create(&input(&f, NotificationEvent::DriftDetected, "Drift").entity("doc-1"))
        .unwrap();
    assert_eq!(third.notification().unwrap().body.as_deref(), Some("v2"));

    // Window is 10 minutes from the last refresh; 11 minutes later it is a new row.
    t.store(T0 + 6 * 60 * 1000 + 11 * 60 * 1000, Ordering::SeqCst);
    let fourth = svc
        .create(&input(&f, NotificationEvent::DriftDetected, "Drift").entity("doc-1"))
        .unwrap();
    assert!(matches!(fourth, CreateOutcome::Created(_)));
    assert_eq!(svc.unread_count(&f.user.id).unwrap(), 2);
}

#[test]
fn dedup_ignores_read_other_entities_and_missing_entity() {
    let f = fixture();
    let svc = NotificationService::new(f.db.conn(), EventBus::new());
    let a = svc
        .create(&input(&f, NotificationEvent::SnapshotCreated, "S").entity("e1"))
        .unwrap();
    svc.mark_read(&f.user.id, &a.notification().unwrap().id)
        .unwrap();
    assert!(matches!(
        svc.create(&input(&f, NotificationEvent::SnapshotCreated, "S").entity("e1"))
            .unwrap(),
        CreateOutcome::Created(_)
    ));
    assert!(matches!(
        svc.create(&input(&f, NotificationEvent::SnapshotCreated, "S").entity("e2"))
            .unwrap(),
        CreateOutcome::Created(_)
    ));
    // No entity id: never merged.
    for _ in 0..2 {
        assert!(matches!(
            svc.create(&input(&f, NotificationEvent::SnapshotCreated, "plain"))
                .unwrap(),
            CreateOutcome::Created(_)
        ));
    }
    assert_eq!(svc.unread_count(&f.user.id).unwrap(), 4);
}

#[test]
fn inbox_filters_pagination_and_read_state() {
    let f = fixture();
    let bob = other_user(&f, "bob@example.com");
    let (t, clk) = clock();
    let svc = NotificationService::new(f.db.conn(), EventBus::new()).with_clock(clk);
    let events = [
        NotificationEvent::TicketCreated,
        NotificationEvent::TicketUpdated,
        NotificationEvent::ApprovalRequested,
        NotificationEvent::ChangeProposalApproved,
        NotificationEvent::TeamInvite,
    ];
    // Two notifications share a timestamp to exercise the compound cursor.
    for (i, e) in events.iter().enumerate() {
        t.store(T0 + i64::try_from(i / 2).unwrap() * 1000, Ordering::SeqCst);
        svc.create(&input(&f, *e, &format!("n{i}"))).unwrap();
    }
    svc.create(&CreateNotification::new(
        &bob.id,
        &f.team.id,
        NotificationEvent::TicketCreated,
        "bob's",
    ))
    .unwrap();

    let q = |event: Option<EventFilter>, read: Option<bool>| InboxQuery {
        user_id: f.user.id.clone(),
        event,
        read,
        ..InboxQuery::default()
    };
    let titles = |p: &nyx_core::notify::InboxPage| {
        p.items.iter().map(|n| n.title.clone()).collect::<Vec<_>>()
    };

    let all = svc.inbox(&q(None, None)).unwrap();
    assert_eq!(
        all.items.len(),
        5,
        "other users' notifications are invisible"
    );
    assert_eq!(all.unread_count, 5);
    assert_eq!(titles(&all), ["n4", "n3", "n2", "n1", "n0"]);

    assert_eq!(
        titles(
            &svc.inbox(&q(Some(EventFilter::parse("review")), None))
                .unwrap()
        ),
        ["n3", "n2"]
    );
    assert_eq!(
        titles(
            &svc.inbox(&q(Some(EventFilter::parse("ticket")), None))
                .unwrap()
        ),
        ["n1", "n0"]
    );
    assert_eq!(
        titles(
            &svc.inbox(&q(Some(EventFilter::parse("ticket.updated")), None))
                .unwrap()
        ),
        ["n1"]
    );
    assert!(
        svc.inbox(&q(Some(EventFilter::parse("tick")), None))
            .unwrap()
            .items
            .is_empty(),
        "category match is not a raw prefix"
    );
    assert!(
        svc.inbox(&q(Some(EventFilter::parse("%")), None))
            .unwrap()
            .items
            .is_empty(),
        "LIKE wildcards are escaped"
    );

    // Pagination, two per page, across the shared timestamp.
    let mut seen = vec![];
    let mut cursor = None;
    loop {
        let page = svc
            .inbox(&InboxQuery {
                user_id: f.user.id.clone(),
                limit: Some(2),
                cursor: cursor.clone(),
                ..InboxQuery::default()
            })
            .unwrap();
        seen.extend(titles(&page));
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    assert_eq!(seen, ["n4", "n3", "n2", "n1", "n0"]);
    let clamped = svc
        .inbox(&InboxQuery {
            user_id: f.user.id.clone(),
            limit: Some(0),
            ..InboxQuery::default()
        })
        .unwrap();
    assert_eq!(clamped.items.len(), 1, "limit clamps to at least 1");
    assert!(svc
        .inbox(&InboxQuery {
            user_id: f.user.id.clone(),
            cursor: Some("junk".into()),
            ..InboxQuery::default()
        })
        .is_err());

    // Read state.
    let first = all.items[0].id.clone();
    t.store(T0 + 9999, Ordering::SeqCst);
    let read = svc.mark_read(&f.user.id, &first).unwrap();
    assert_eq!(read.read_at, Some(T0 + 9999));
    t.store(T0 + 20_000, Ordering::SeqCst);
    assert_eq!(
        svc.mark_read(&f.user.id, &first).unwrap().read_at,
        Some(T0 + 9999),
        "first read time sticks"
    );
    assert_eq!(svc.unread_count(&f.user.id).unwrap(), 4);
    assert_eq!(svc.inbox(&q(None, Some(true))).unwrap().items.len(), 1);
    assert_eq!(svc.inbox(&q(None, Some(false))).unwrap().items.len(), 4);
    assert!(
        svc.mark_read(&bob.id, &first).is_err(),
        "cannot read someone else's notification"
    );
    assert!(svc.delete(&bob.id, &first).is_err());
    assert_eq!(svc.mark_all_read(&f.user.id).unwrap(), 4);
    assert_eq!(svc.mark_all_read(&f.user.id).unwrap(), 0);
    assert_eq!(svc.unread_count(&bob.id).unwrap(), 1, "bob untouched");
    svc.delete(&f.user.id, &first).unwrap();
    assert_eq!(svc.inbox(&q(None, None)).unwrap().items.len(), 4);
}

#[test]
fn preferences_replace_and_patch() {
    let f = fixture();
    let svc = NotificationService::new(f.db.conn(), EventBus::new());
    assert!(svc.preferences(&f.user.id).unwrap().is_empty());

    // PATCH creates with defaults (in_app, email on, daily) and applies the change.
    let p = svc
        .update_preference(
            &f.user.id,
            "ticket.created",
            &PreferenceUpdate {
                email_mode: Some(EmailMode::Weekly),
                ..PreferenceUpdate::default()
            },
        )
        .unwrap();
    assert!(p.in_app && p.email_enabled);
    assert_eq!(p.email_mode, EmailMode::Weekly);
    // PATCH again only changes what was given.
    let p = svc
        .update_preference(
            &f.user.id,
            "ticket.created",
            &PreferenceUpdate {
                in_app: Some(false),
                ..PreferenceUpdate::default()
            },
        )
        .unwrap();
    assert!(!p.in_app);
    assert_eq!(p.email_mode, EmailMode::Weekly);
    assert_eq!(svc.preferences(&f.user.id).unwrap().len(), 1);

    // PUT replaces everything.
    let put = svc
        .replace_preferences(
            &f.user.id,
            &[
                PreferenceInput {
                    event_type: "team.invite".into(),
                    in_app: true,
                    email_enabled: false,
                    email_mode: EmailMode::Off,
                },
                PreferenceInput {
                    event_type: "drift.detected".into(),
                    in_app: true,
                    email_enabled: true,
                    email_mode: EmailMode::Instant,
                },
            ],
        )
        .unwrap();
    assert_eq!(put.len(), 2);
    assert!(svc
        .preferences(&f.user.id)
        .unwrap()
        .iter()
        .all(|p| p.event_type != "ticket.created"));

    // A duplicate event type in one PUT fails and leaves the old set intact (atomic).
    let dup = PreferenceInput {
        event_type: "x".into(),
        in_app: true,
        email_enabled: true,
        email_mode: EmailMode::Daily,
    };
    assert!(svc
        .replace_preferences(&f.user.id, &[dup.clone(), dup])
        .is_err());
    assert_eq!(svc.preferences(&f.user.id).unwrap().len(), 2);
    assert!(svc
        .update_preference(&f.user.id, " ", &PreferenceUpdate::default())
        .is_err());
}

#[test]
fn email_modes_instant_off_disabled_and_failure() {
    let f = fixture();
    let mailer = Arc::new(FakeMailer::new());
    let svc = NotificationService::new(f.db.conn(), EventBus::new()).with_mailer(mailer.clone());
    let set = |event: &str, enabled: bool, mode: EmailMode| {
        svc.update_preference(
            &f.user.id,
            event,
            &PreferenceUpdate {
                email_enabled: Some(enabled),
                email_mode: Some(mode),
                ..PreferenceUpdate::default()
            },
        )
        .unwrap();
    };
    set("ticket.created", true, EmailMode::Instant);
    set("ticket.updated", true, EmailMode::Off);
    set("team.invite", false, EmailMode::Instant);
    set("comment.mention", true, EmailMode::Weekly);

    svc.create(&input(&f, NotificationEvent::TicketCreated, "instant <b>"))
        .unwrap();
    svc.create(&input(&f, NotificationEvent::TicketUpdated, "off"))
        .unwrap();
    svc.create(&input(&f, NotificationEvent::TeamInvite, "disabled"))
        .unwrap();
    svc.create(&input(&f, NotificationEvent::CommentMention, "weekly"))
        .unwrap();

    let sent = mailer.sent();
    assert_eq!(sent.len(), 1, "only the instant one is sent right away");
    assert_eq!(sent[0].subject, "instant <b>");
    assert!(
        sent[0].html.contains("instant &lt;b&gt;"),
        "titles are HTML-escaped"
    );
    let log = SqliteNotifications::new(f.db.conn())
        .email_log(&f.user.id)
        .unwrap();
    let statuses: Vec<_> = log.iter().map(|l| l.1).collect();
    assert_eq!(
        statuses,
        [EmailDeliveryStatus::Sent, EmailDeliveryStatus::Queued]
    );

    // A failing mailer is logged as failed, and creating the notification still succeeds.
    let f2 = fixture();
    let bad = Arc::new(FakeMailer::failing());
    let svc2 = NotificationService::new(f2.db.conn(), EventBus::new()).with_mailer(bad);
    svc2.update_preference(
        &f2.user.id,
        "ticket.created",
        &PreferenceUpdate {
            email_mode: Some(EmailMode::Instant),
            ..PreferenceUpdate::default()
        },
    )
    .unwrap();
    let out = svc2
        .create(&input(&f2, NotificationEvent::TicketCreated, "x"))
        .unwrap();
    assert!(matches!(out, CreateOutcome::Created(_)));
    let log = SqliteNotifications::new(f2.db.conn())
        .email_log(&f2.user.id)
        .unwrap();
    assert_eq!(log[0].1, EmailDeliveryStatus::Failed);
    assert!(log[0].2.as_deref().unwrap().contains("mailer unavailable"));
}

#[test]
fn failed_digest_marks_rows_failed_and_notifier_errors_are_ignored() {
    let f = fixture();
    let svc = NotificationService::new(f.db.conn(), EventBus::new())
        .with_mailer(Arc::new(FakeMailer::failing()))
        .with_notifier(Arc::new(FakeNotifier::failing()));
    for i in 0..3 {
        let out = svc
            .create(&input(
                &f,
                NotificationEvent::TicketCreated,
                &format!("t{i}"),
            ))
            .unwrap();
        assert!(
            matches!(out, CreateOutcome::Created(_)),
            "desktop failure must not fail creation"
        );
    }
    assert_eq!(svc.send_digest(&f.user.id).unwrap(), 3);
    let log = SqliteNotifications::new(f.db.conn())
        .email_log(&f.user.id)
        .unwrap();
    assert!(log.iter().all(|l| l.1 == EmailDeliveryStatus::Failed));
    assert_eq!(
        SqliteNotifications::new(f.db.conn())
            .queued_emails(&f.user.id)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn email_html_builders() {
    let html = build_notification_email(
        "Hi",
        "Body",
        Some("https://nyx.example/x?a=1&b=2"),
        Some("Open"),
    );
    assert!(html.contains("Hi") && html.contains("Body"));
    assert!(html.contains("href=\"https://nyx.example/x?a=1&amp;b=2\"") && html.contains(">Open<"));
    assert!(!build_notification_email("Hi", "B", None, None).contains("<a "));
    assert!(
        !build_notification_email("Hi", "B", Some("javascript:alert(1)"), None).contains("<a ")
    );

    let item = |t: &str, e: &str| DigestItem {
        title: t.into(),
        body: "b".into(),
        event_type: e.into(),
    };
    let digest = build_digest_email(&[
        item("A", "approval_requested"),
        item("B", "ticket.created"),
        item("C", "approval_requested"),
    ]);
    assert!(digest.contains("Approval Requested (2)"));
    assert!(digest.contains("Ticket.Created (1)"));
    assert!(digest.find("Approval Requested").unwrap() < digest.find("Ticket.Created").unwrap());
}

#[test]
fn typed_events_round_trip() {
    for e in NotificationEvent::ALL {
        assert_eq!(NotificationEvent::parse(e.as_str()), Some(*e));
    }
    assert_eq!(NotificationEvent::ALL.len(), 11);
    assert_eq!(
        NotificationEvent::ChangeProposalRejected.category(),
        "change_proposal"
    );
    assert_eq!(NotificationEvent::parse("nope"), None);
    assert!(EventFilter::Review.matches("approval.requested"));
    assert!(!EventFilter::Review.matches("ticket.created"));
}
