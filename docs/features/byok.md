# Bring Your Own Key (BYOK)

Team and Enterprise customers can connect their own Anthropic API key so that AI usage bills directly to their account rather than through Nyx's managed key. This gives larger teams cost transparency, usage control, and the ability to apply their own rate limits and spend caps.

---

## 1. Tier Availability

BYOK is available on **Team** and **Enterprise** plans only.

| Plan | BYOK Available |
|---|---|
| Free | No |
| Pro | No |
| Team | Yes |
| Enterprise | Yes |

When a Free or Pro user navigates to the key management settings, they see an upgrade prompt explaining the feature and linking to the plan comparison page.

---

## 2. User Flow

### 2.1 Entering an API Key

1. A **team admin** navigates to **Workspace Settings → Integrations → AI Provider**.
2. The settings panel shows the current key status:
   - **Using Nyx managed key** (default)
   - **Team key active** (if configured), showing last 4 characters and rotation date
3. The admin clicks **Connect your Anthropic key**.
4. A modal prompts for the Anthropic API key (format: `sk-ant-...`).
5. On submission, Nyx immediately validates the key by making a lightweight test call to the Anthropic API.
   - If valid: key is encrypted and stored; status updates to **Team key active**.
   - If invalid: an inline error is shown (see §6 Error Handling).
6. All subsequent AI requests from this workspace use the team-provided key.

### 2.2 Removing or Rotating a Key

- **Remove:** Admin clicks **Remove key**. After confirming the modal, the workspace reverts to the Nyx managed key.
- **Rotate:** Admin clicks **Update key**, enters the new key, and submits. The old key is replaced atomically — there is no gap in AI availability.
- Every add, update, and removal is recorded in the workspace audit log (see §7 Security).

---

## 3. Key Storage

### 3.1 Encryption at Rest

API keys are never stored in plaintext. The storage pipeline is:

1. The raw key is received by the API server over TLS.
2. The server encrypts it using **AES-256-GCM** with a key derived from a workspace-specific secret held in the secrets manager (e.g., AWS Secrets Manager or Doppler).
3. Only the ciphertext is written to the `workspace_api_keys` table in PostgreSQL.
4. The workspace-specific encryption key is never written to the database.

### 3.2 Which Service Reads the Key

Only the **AI service** (the internal Fastify route handler responsible for Anthropic API calls) decrypts and uses the team key. It does so at request time by:

1. Looking up the workspace ID from the authenticated session.
2. Fetching the ciphertext from the database.
3. Decrypting in-process using the secrets manager key.
4. Constructing the Anthropic client with the decrypted key.
5. Discarding the plaintext key after the request completes.

No other service, no frontend bundle, and no log output ever sees the raw key.

### 3.3 Key Rotation

Teams should rotate their key periodically. Nyx supports rotation without downtime:

- The new key is validated before the old key is replaced.
- The swap is a single transactional database write.
- Admins can set an optional **rotation reminder** (90-day default for Enterprise) that triggers a workspace notification.

---

## 4. Request Routing

The AI service selects the key to use via a simple priority check at request time:

```
if workspace.byok_enabled and workspace.encrypted_api_key is not null:
    key = decrypt(workspace.encrypted_api_key)
else:
    key = NYX_ANTHROPIC_API_KEY  # env var, Nyx managed
```

This logic lives in a single `resolveAnthropicClient(workspaceId)` helper so the routing decision is never duplicated across AI features (spec analysis, drift detection, ticket generation, etc.).

---

## 5. Usage Tracking and Display

### 5.1 Metering

For workspaces using a team key, Nyx tracks:

- **Token counts** (input + output) per AI request, sourced from the Anthropic API response headers.
- **Feature attribution** — which Nyx feature triggered the call (e.g., `spec_analysis`, `drift_detection`, `ticket_gen`).
- **Timestamp** and **user ID** for each call.

This data is written to a `ai_usage_events` table.

### 5.2 Usage Dashboard

Admins see a **Usage** tab in Workspace Settings showing:

| Metric | Granularity |
|---|---|
| Total tokens used | Current billing period (rolling 30 days) |
| Tokens by feature | Breakdown chart |
| Daily token trend | Line graph, last 30 days |
| Estimated cost | Based on current Anthropic pricing (indicative only) |

Data is aggregated nightly; near-real-time views are not provided in MVP.

**Note:** When using the Nyx managed key, usage is not surfaced to customers — it is metered internally against the plan quota.

---

## 6. Error Handling

| Scenario | User-Facing Behavior |
|---|---|
| Invalid key on submission | Inline modal error: "We couldn't validate this key. Check that it starts with `sk-ant-` and has not been revoked." |
| Key revoked after activation | AI features return an error banner: "Your team's API key is invalid or has been revoked. An admin can update it in Workspace Settings." |
| Anthropic rate limit exceeded | Error banner: "Your Anthropic key has hit its rate limit. Requests will resume when the limit resets." |
| Anthropic API outage | Nyx does not fall back to the managed key automatically (to avoid unexpected billing). Error banner: "Anthropic API is currently unavailable." |
| Workspace downgraded from Team/Pro | Key is deactivated (not deleted). If the workspace upgrades again, the encrypted key remains and can be reactivated by an admin. |

---

## 7. Settings UI Design

### 7.1 Location

**Workspace Settings → Integrations → AI Provider**

### 7.2 Component Layout

```
┌─────────────────────────────────────────────┐
│ AI Provider                                 │
├─────────────────────────────────────────────┤
│ Current key:  ● Team key (••••a1b2)         │
│ Added:        Jan 12, 2026 by Alice Admin   │
│                                             │
│  [Update key]   [Remove key]                │
│                                             │
│ Rotation reminder: Every 90 days  [Edit]    │
└─────────────────────────────────────────────┘
```

- The key value is **never shown** beyond the last 4 characters.
- The **Add / Update key** modal uses an `<input type="password">` field.
- Changes trigger an optimistic UI update; errors roll back the displayed state.

---

## 8. Security Considerations

- **Key never exposed in the frontend:** The raw key is never returned by any API endpoint. The frontend receives only metadata (last 4 chars, added-at timestamp, added-by user ID).
- **Audit log on all key changes:** Every add, update, and removal is written to the workspace audit log with actor, timestamp, and action type. The log is accessible to admins under **Workspace Settings → Audit Log**.
- **No logging of key values:** The plaintext key must never appear in application logs, error traces, or analytics events. Code review and CI linting should enforce this.
- **Scope validation:** Only users with the `workspace:admin` role can view or modify the AI Provider settings. The API enforces this server-side regardless of UI state.
- **TLS in transit:** All key submissions travel over HTTPS; the API rejects HTTP connections.
- **Short-lived decrypted secret:** The decrypted key is held in memory only for the duration of the HTTP request and is not cached.

---

## 9. E2E Testing

### 9.1 Critical User Flows

1. Team admin enters a valid API key → key is saved and AI features use the team key.
2. Team admin enters an invalid API key → validation error is shown, key is not saved.
3. Team admin removes the key → workspace reverts to Nyx managed key.
4. Team admin rotates the key → old key replaced atomically, AI features continue working.
5. Free/Pro user visits AI Provider settings → upgrade prompt shown, no key input available.
6. AI request is made with a revoked team key → error banner shown to end user.

### 9.2 Test Scenarios

#### Scenario 1 — Valid key submission

```
Given a Team workspace with no BYOK key configured
  And the admin is logged in
When the admin navigates to Workspace Settings → Integrations → AI Provider
  And enters a valid Anthropic key and submits
Then the settings panel shows "Team key active" with the last 4 characters
  And an audit log entry is created for the key addition
  And subsequent AI requests succeed using the team key
```

#### Scenario 2 — Invalid key rejection

```
Given a Team workspace with no BYOK key configured
  And the admin is logged in
When the admin enters a key that fails Anthropic validation and submits
Then an inline error is displayed in the modal
  And no key is saved to the database
  And the workspace remains on the Nyx managed key
```

#### Scenario 3 — Key removal

```
Given a Team workspace with an active BYOK key
  And the admin is logged in
When the admin clicks "Remove key" and confirms the modal
Then the settings panel reverts to "Using Nyx managed key"
  And an audit log entry is created for the removal
  And subsequent AI requests use the Nyx managed key
```

#### Scenario 4 — Tier gate (Free plan)

```
Given a Free workspace
  And the admin is logged in
When the admin navigates to Workspace Settings → Integrations → AI Provider
Then an upgrade prompt is displayed
  And no key input field is visible
```

#### Scenario 5 — Revoked key error

```
Given a Team workspace with a BYOK key that has been revoked at Anthropic
When an end user triggers an AI feature (e.g., spec analysis)
Then an error banner is displayed indicating the key is invalid
  And no AI output is returned
```

### 9.3 Integration Boundaries

| Boundary | Test approach |
|---|---|
| Anthropic API (key validation) | **Mock** in CI using an MSW/nock interceptor. Test against real API only in a dedicated integration environment with a real test key. |
| Anthropic API (AI features) | **Mock** — return fixture responses; do not make live model calls in E2E. |
| PostgreSQL | **Real** — use the CI test database with seeded workspace and user fixtures. |
| Secrets manager (encryption) | **Stub** — use a deterministic test encryption key injected via `TEST_BYOK_ENCRYPTION_KEY` env var. |
| Audit log service | **Real** — assert on database rows written to `audit_log` table. |

### 9.4 Test Data Requirements

- **Seed data:**
  - One workspace on the Team plan with an admin user (`byok_admin@example.com`).
  - One workspace on the Free plan with an admin user (`free_admin@example.com`).
  - One workspace with a pre-configured (but revoked) BYOK key for error-path tests.
- **Fixture documents:** At least one document per workspace to trigger AI features (spec analysis).
- **Environment variables for CI:**
  - `TEST_BYOK_ENCRYPTION_KEY` — deterministic AES key for test encryption/decryption.
  - `MOCK_ANTHROPIC_API=true` — instructs the AI service to use the MSW mock rather than live Anthropic.

### 9.5 Playwright Test File Locations

```
e2e/
├── byok/
│   ├── byok-admin-flow.spec.ts        # Scenarios 1–3 (add, rotate, remove)
│   ├── byok-tier-gate.spec.ts         # Scenario 4 (Free/Pro upgrade prompt)
│   └── byok-error-handling.spec.ts    # Scenario 5 (revoked key, rate limit)
```

### 9.6 CI Considerations

- Set `MOCK_ANTHROPIC_API=true` and `TEST_BYOK_ENCRYPTION_KEY` in the CI environment (GitHub Actions secrets).
- The MSW API mock server must be started before the Playwright worker; use a global setup file (`e2e/global-setup.ts`) to initialize it.
- The test database must have BYOK seed data applied before the suite runs; add a seed step to the CI workflow after `drizzle-kit push --force`.
- BYOK tests should run in a dedicated Playwright project (`byok`) to allow selective re-runs without executing the full E2E suite.

---

## 10. Open Questions

- Should Nyx support providers other than Anthropic (e.g., OpenAI) in a future iteration? If so, the `workspace_api_keys` table should include a `provider` column from the start.
- Should failed AI requests with a team key automatically notify the admin via email/in-app notification? (Recommended for Enterprise.)
- What is the retention policy for `ai_usage_events` rows? (Suggested: 13 months for billing audit purposes.)
