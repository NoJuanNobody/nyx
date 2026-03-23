# Notifications Implementation Notes

## What changed

The notifications feature was already substantially implemented on the base branch. This commit fills gaps identified against the spec, fixes a UI bug, and adds shared types.

### Bug fix
- **NotificationPanel readAt bug**: The panel component was checking `item.read` (always undefined) instead of `item.readAt` for determining unread state. All three references (click handler, dot indicator, text styling) were fixed.

### Additions
- **Shared notification types** (`packages/shared/src/types/notification.ts`): Added Zod schemas and TypeScript types for `Notification`, `NotificationPreference`, `NotificationListResponse`, `UnreadCountResponse`, `NotificationEventType`, `NotificationEmailMode`, and `EmailDeliveryStatus`.
- **Complete event types**: Expanded `notification-events.ts` from 5 events to all 11 spec events: added `change_proposal.submitted`, `change_proposal.approved`, `change_proposal.rejected`, `approval.requested`, `snapshot.created`, `comment.mention`.
- **Reviews filter tab**: Added "Reviews" filter to the NotificationPanel, which filters for `approval.*` and `change_proposal.*` events.
- **Smart event type filtering**: Updated the notifications route to support prefix-based filtering (e.g., `ticket` matches `ticket.*`), exact match for qualified types (e.g., `drift.detected`), and a special `review` filter for approval + change proposal events.
- **EMAIL_FROM config**: Added `EMAIL_FROM` env var to config and updated email service to use it.
- **Full event types in preferences UI**: Expanded the NotificationPreferences component from 5 to 11 event types.

## Files modified

- `packages/shared/src/types/notification.ts` (new)
- `packages/shared/src/index.ts`
- `apps/api/src/routes/notifications.ts`
- `apps/api/src/services/notification-events.ts`
- `apps/api/src/services/email.ts`
- `apps/api/src/lib/config.ts`
- `apps/web/src/components/NotificationPanel.tsx`
- `apps/web/src/components/NotificationPreferences.tsx`

## What was already in place (pre-existing)

- Database schema (notifications, notification_preferences, email_delivery_log tables with enums)
- All 8 API endpoints registered in app.ts
- NotificationService with dedup/grouping logic
- NotificationEmailService with instant + digest support
- Email service (Resend integration)
- NotificationBell component with 30s polling
- NotificationPanel with side panel overlay
- NotificationPreferences in Settings page
- Layout integration (bell in top nav)
- Unit tests for routes, notification service, and email service (all passing)
- API client functions in web app

## Assumptions

- The `review` filter maps to both `approval.*` and `change_proposal.*` event types as per the spec filter description.
- The `EMAIL_FROM` defaults to `Nyx <noreply@nyx.dev>` when not set.
- WebSocket real-time delivery is deferred per the spec (tracked separately in issue #43).

## Governance conflicts

None.

## Follow-up items

- WebSocket push for real-time notifications (issue #43 per spec)
- E2E Playwright tests for notification flows (spec section 9 describes 5 test files; not created here as no existing e2e/notifications/ directory exists yet)
- Email template files as React Email components (spec section 3.2; currently using inline HTML builders)
- Global overrides (pause all emails, digest day/time, timezone) are described in spec section 4.2 but not yet implemented
- Resend SDK integration (currently using raw fetch; SDK would provide better error handling and webhook support)
