# Sprint Gatekeeper

The sprint gatekeeper gives Nyx awareness of the active sprint before pushing any spec to the engineering queue. When a new spec is ready, Nyx checks sprint capacity and — if the sprint is at or near full — forces a trade-off conversation before any ticket is created.

This turns Nyx from a spec generator into a sprint protection system.

## How It Works

1. User finishes a spec and clicks **Push to Engineering**
2. Nyx fetches the active sprint from Linear or Jira (read-only)
3. A **capacity indicator** appears alongside the spec output
4. If capacity is **< 80%**, the user can push immediately
5. If capacity is **≥ 80%**, a **trade-off prompt** is shown:
   - Current sprint tickets are listed with their point values
   - User must select one ticket to defer OR choose to schedule the spec for next sprint
6. User explicitly confirms before any ticket is created — no auto-push

### Example trade-off prompt

```
Sprint Capacity Warning: Active sprint is at 100%.
To inject this spec now, bump one of:
  ENG-412: Email Notifications (3pts)
  ENG-415: Dark Mode UI (2pts)
Select which to defer, or schedule for next sprint.
```

## Setup

### 1. Connect Linear or Jira via OAuth

In **Settings → Integrations**, connect Linear or Jira using OAuth. The integration is strictly read-only — SyncDocs only reads sprint data and never writes back to Linear or Jira.

**Linear:** Uses the Linear OAuth app. Requires the `read` scope.

**Jira:** Uses Jira's OAuth 2.0 (3LO) flow. Requires the `read:jira-work` scope.

### 2. Select the active project / board

After connecting, select which Linear team or Jira project to track. SyncDocs will use this project when checking sprint capacity.

### 3. Configure the capacity threshold (optional)

The default threshold is **80%**. You can change it in **Settings → Sprint Gatekeeper**.

| Setting | Default | Description |
| --- | --- | --- |
| `SPRINT_CAPACITY_THRESHOLD` | `0.8` | Fraction at which the trade-off prompt triggers |
| `CAPACITY_MODE` | `points` | `points` or `ticket_count` |

## API Endpoints

### `GET /api/sprint/status`

Fetches the current sprint status from the connected integration.

**Response:**
```json
{
  "integration": "linear",
  "sprintName": "Sprint 24",
  "totalPoints": 40,
  "completedPoints": 18,
  "remainingPoints": 22,
  "capacityPercent": 100,
  "tickets": [
    {
      "id": "ENG-412",
      "title": "Email Notifications",
      "points": 3,
      "status": "In Progress",
      "assignee": "alice"
    },
    {
      "id": "ENG-415",
      "title": "Dark Mode UI",
      "points": 2,
      "status": "Todo",
      "assignee": "bob"
    }
  ]
}
```

**Error responses:**

| Status | Description |
| --- | --- |
| 400 | No integration connected |
| 401 | OAuth token expired or revoked |
| 503 | Upstream Linear / Jira API unavailable |

### `POST /api/sprint/push`

Initiates a push after the user completes the trade-off conversation. Requires explicit confirmation.

**Request:**
```json
{
  "specId": "uuid",
  "action": "push_now",
  "deferredTicketId": "ENG-412"
}
```

Or, to defer to next sprint:
```json
{
  "specId": "uuid",
  "action": "defer_spec"
}
```

**Response:**
```json
{
  "ticketUrl": "https://linear.app/team/issue/ENG-420",
  "deferredTicket": "ENG-412",
  "scheduledFor": null
}
```

## Capacity Calculation

Capacity is calculated based on the `CAPACITY_MODE` setting.

**`points` mode** (default):

```
capacityPercent = (totalPoints / sprintVelocity) * 100
```

where `sprintVelocity` is the average story points completed per sprint over the last 3 sprints. Falls back to `totalPoints` if history is unavailable.

**`ticket_count` mode:**

```
capacityPercent = (openTickets / totalTickets) * 100
```

## Trade-off UI

The trade-off modal is shown inline in the spec output view when `capacityPercent >= threshold`.

**Bumpable ticket criteria** — a ticket is listed as a bump candidate if:
- Status is `Todo` or `In Progress`
- Not marked as a blocker or dependency for another in-progress ticket
- Assigned to the current sprint

The user must take one of three actions:
1. **Defer a ticket** — select a ticket to move out of the sprint, then push the spec
2. **Schedule for next sprint** — the spec is queued without creating a ticket now
3. **Cancel** — abandon the push (no ticket created, sprint unchanged)

No ticket is ever created without the user clicking an explicit confirm button.

## Integrations

### Linear

- Auth: OAuth 2.0, `read` scope
- Sprint data: fetched via the Linear GraphQL API (`cycles` query)
- Ticket data: `issues` query filtered by active cycle

### Jira

- Auth: OAuth 2.0 (3LO), `read:jira-work` scope
- Sprint data: Jira Software REST API (`/rest/agile/1.0/board/{boardId}/sprint?state=active`)
- Ticket data: `/rest/agile/1.0/sprint/{sprintId}/issue`

Both integrations cache responses for **60 seconds** to avoid hammering upstream APIs on every spec push.

## Architecture

| Component | File |
| --- | --- |
| Integration settings UI | `apps/web/src/components/settings/IntegrationsPanel.tsx` |
| Capacity indicator | `apps/web/src/components/sprint/CapacityIndicator.tsx` |
| Trade-off modal | `apps/web/src/components/sprint/TradeOffModal.tsx` |
| Sprint API routes | `apps/api/src/routes/sprint.ts` |
| Linear adapter | `apps/api/src/services/integrations/linear.service.ts` |
| Jira adapter | `apps/api/src/services/integrations/jira.service.ts` |
| Sprint service | `apps/api/src/services/sprint.service.ts` |
| OAuth callback | `apps/api/src/routes/oauth/linear.ts`, `jira.ts` |
| Database schema | `apps/api/src/db/schema.ts` (`integrationTokens`, `sprintCache`) |
| Unit tests | `apps/api/src/services/__tests__/sprint.service.test.ts` |
| E2E tests | `e2e/sprint-gatekeeper.spec.ts` |

## Dependencies

- **Chaos Ingestion (#87)** — sprint gatekeeper depends on the spec push flow introduced in that issue

## Out of Scope

- Writing back to Linear or Jira (the integration is strictly read-only)
- Internal sprint management (SyncDocs does not replace Linear or Jira)
- Automatic deferral — a human must always confirm

## Acceptance Criteria

- [ ] User can connect Linear or Jira via OAuth from Settings
- [ ] Active sprint tickets and capacity are fetched and displayed
- [ ] New spec shows a capacity indicator before push
- [ ] If sprint ≥ 80%, trade-off prompt is required before push
- [ ] Founder must select a bump target OR defer — no auto-push
- [ ] Founder explicitly confirms before any ticket is created
- [ ] Integration is strictly read-only — no writes to Linear or Jira

## Troubleshooting

| Problem | Cause | Fix |
| --- | --- | --- |
| `No integration connected` | Linear/Jira OAuth not completed | Go to Settings → Integrations and complete OAuth |
| `OAuth token expired` | Token was revoked or expired | Re-connect the integration in Settings |
| Capacity always shows 0% | No story points on tickets | Switch `CAPACITY_MODE` to `ticket_count` in Settings |
| Trade-off modal doesn't appear | Capacity below threshold | Lower `SPRINT_CAPACITY_THRESHOLD` or add more tickets to the sprint |
| Upstream API unavailable | Linear or Jira outage | The push button is disabled; try again when the service recovers |
