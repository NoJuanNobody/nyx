# Add Team Member Flow

A team owner or admin invites someone by email. Nyx sends the invitee an invitation email. The invitee clicks the link, signs up (or signs in) via Clerk, and is automatically dropped into the team onboarding flow where they learn the workspace and get oriented to their role.

---

## 1. User Stories

| As a… | I want to… | So that… |
|---|---|---|
| Team owner | Invite a colleague by email and assign them a role | They can collaborate on docs and specs without me walking them through setup |
| Team admin | Send an invite without being the owner | I can grow the team without bothering the owner |
| Invitee (new user) | Click the invite link and sign up once | I land directly in the workspace that invited me, not a generic empty state |
| Invitee (existing user) | Click the invite link and be added automatically | I don't have to manually join — it just works |
| Team owner | See who has pending invitations | I know who hasn't joined yet and can resend or cancel |
| Team owner | Cancel a pending invitation | I can revoke access before someone joins |

---

## 2. End-to-End Flow

### 2.1 Owner/Admin Sends an Invitation

```
Settings → Team tab
  → "Invite member" form (email + role)
  → POST /api/teams/:id/members
        ├─ Email matches existing user?
        │     └─ Yes → add as team member immediately, fire team.invite notification
        └─ No  → create teamInvitations row (status: pending, expires: +7 days)
                  send invitation email via Resend
```

### 2.2 Invitee Receives Email and Clicks CTA

```
Email: "You've been invited to <team name> on Nyx"
  → CTA button: "Accept invitation"
  → Lands on: /invite?token=<inviteToken>
```

### 2.3 Invite Acceptance Page

```
/invite?token=<inviteToken>
  → GET /api/invitations/:token  (validate token, return team name + inviter name)
       ├─ Token valid?
       │     ├─ User already signed in?
       │     │     └─ POST /api/invitations/:token/accept
       │     │           → redirect to /onboarding?context=invite or to workspace
       │     └─ User not signed in?
       │           → redirect to /sign-up?redirect=/invite?token=<token>
       │             or /sign-in?redirect=/invite?token=<token>
       ├─ Token expired?
       │     └─ Show: "This invitation has expired. Ask your team owner to resend it."
       └─ Token not found?
             └─ Show: "Invitation not found."
```

### 2.4 Invitee Signs Up (New User)

```
Clerk sign-up flow (/sign-up)
  → User creates account (email must match invitation)
  → On first sign-in, auth middleware auto-accepts pending invitations
      matching the verified email (see: apps/api/src/middleware/auth.ts)
  → redirect_url carries /invite?token=<token>
  → After Clerk redirects back, /invite page calls POST /api/invitations/:token/accept
  → User is now a team member
  → Redirect to /onboarding?context=invite&teamId=<id>
```

### 2.5 Invitee Is an Existing User

```
Invitee is already signed in (or signs in via /sign-in)
  → /invite page detects active session
  → Calls POST /api/invitations/:token/accept immediately
  → Redirect to the workspace (skip onboarding, they're not new)
```

### 2.6 Onboarding Flow (New Team Members)

```
/onboarding?context=invite&teamId=<id>

Step 1: Welcome
  "Welcome to <team name>! You've been added as a <role>."
  [ Continue ]

Step 2: Role orientation (conditional on role)
  developer  → "You'll see specs linked to GitHub repos. Code changes sync automatically."
  editor     → "You can write and edit specs. Use the AI assistant to draft sections quickly."
  viewer     → "You have read-only access to all specs in this workspace."
  admin      → "You can invite members, manage integrations, and edit all specs."

Step 3: Your first look
  - Show 2-3 existing documents from the team (if any exist)
  - CTA: "Open a spec" → navigates to first document
  - If no documents yet: "This workspace is just getting started. Explore the editor."

Step 4: Done
  → Redirect to workspace home (/w/<teamSlug>)
```

---

## 3. Data Model

The `teamInvitations` table already exists (see `apps/api/src/db/schema.ts`):

```sql
CREATE TABLE team_invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL,        -- 'viewer' | 'editor' | 'developer' | 'admin' | 'owner'
  invited_by   UUID NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'expired'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL             -- default: now() + 7 days
);
```

### Invite Token

The invitation link uses the row `id` (UUID) as the token. This is sufficient for MVP — it is unguessable and tied to a single invitation record. There is no need for a separate signed token at this stage.

Link format:
```
https://nyx.io/invite?token=<invitation-uuid>
```

---

## 4. API Endpoints

### Existing endpoints (already implemented)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/teams/:id/members` | Invite by email or add existing user directly |
| `GET` | `/api/teams/:id/invitations` | List pending invitations for a team |
| `DELETE` | `/api/teams/:id/invitations/:invId` | Cancel a pending invitation |

### New endpoints needed

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/invitations/:token` | Optional | Validate token; return team name, inviter, role, expiry |
| `POST` | `/api/invitations/:token/accept` | Required | Accept an invitation; creates team membership |
| `POST` | `/api/teams/:id/invitations/:invId/resend` | Admin+ | Resend invitation email; resets expiry to +7 days |

#### `GET /api/invitations/:token`

```
200 OK
{
  "teamName": "Acme Corp",
  "inviterName": "Jane Smith",
  "role": "developer",
  "expiresAt": "2026-03-22T00:00:00Z"
}

404 Not Found  — token not found
410 Gone       — invitation expired or already accepted
```

#### `POST /api/invitations/:token/accept`

```
200 OK
{
  "teamId": "uuid",
  "teamSlug": "acme-corp",
  "role": "developer",
  "isNewToTeam": true
}

401 Unauthorized — user not signed in
404 Not Found    — token not found
409 Conflict     — user is already a member of this team
410 Gone         — invitation expired or already accepted
```

#### `POST /api/teams/:id/invitations/:invId/resend`

```
204 No Content  — email resent, expiry reset to now() + 7 days
403 Forbidden   — caller is not admin+
404 Not Found   — invitation not found or not pending
```

---

## 5. Email: Invitation Template

**Provider:** Resend (`resend.com`), consistent with the notifications feature.

**Template file:** `apps/api/src/notifications/templates/team-invite.tsx`

**Subject:** `<inviterName> invited you to <teamName> on Nyx`

**Body structure:**

```
┌──────────────────────────────────────────┐
│  [Nyx logo]                              │
│                                          │
│  <inviterName> has invited you to join   │
│  <teamName> on Nyx as a <role>.          │
│                                          │
│  Nyx keeps specs in sync with code and   │
│  connects your team's docs to GitHub.    │
│                                          │
│  [ Accept invitation ]                   │
│   (CTA links to /invite?token=<uuid>)    │
│                                          │
│  This invitation expires in 7 days.      │
│  If you weren't expecting this, you can  │
│  safely ignore this email.               │
│                                          │
│  ─────────────────────────────────────   │
│  Sent by Nyx · Unsubscribe               │
└──────────────────────────────────────────┘
```

**Environment variables required:**
```env
RESEND_API_KEY=re_...
EMAIL_FROM=invites@nyx.io
```

---

## 6. Frontend: New Components

### 6.1 `/invite` Page (`apps/web/src/pages/InvitePage.tsx`)

States:
- **Loading** — validating token (`GET /api/invitations/:token`)
- **Valid, signed out** — show team name + role + "Sign up" / "Sign in" CTAs
- **Valid, signed in** — show team name + role + "Join team" button (calls accept endpoint)
- **Expired** — error card with message, no CTA
- **Already accepted / already a member** — "You're already in this team" with link to workspace
- **Not found** — error card

### 6.2 `/onboarding` Page (`apps/web/src/pages/OnboardingPage.tsx`)

Multi-step wizard (see flow in section 2.6). Progress indicated by a simple step indicator at the top (e.g., `1 / 3`). No back navigation — forward-only. Steps are driven by `context` query param (`invite` vs. future `first-login` context).

### 6.3 Settings: Resend Invitation Button

In `apps/web/src/pages/Settings.tsx`, the pending invitations list already shows a cancel button per invite. Add a **Resend** button next to it that calls `POST /api/teams/:id/invitations/:invId/resend`.

---

## 7. Permissions

| Action | Minimum role |
|---|---|
| Send invitation | admin |
| Cancel invitation | admin |
| Resend invitation | admin |
| View pending invitations | admin |
| Accept invitation | authenticated (any) |
| View invite details (token lookup) | unauthenticated (public) |

Owners and admins can invite at or below their own role level. An admin cannot invite another owner.

---

## 8. Edge Cases

| Scenario | Behavior |
|---|---|
| Invitee signs up with a different email than the invite | Invite is not auto-accepted; user lands in empty workspace; show a notice: "We couldn't find a pending invitation for this email." |
| Invitee is already a member of the team | Accept endpoint returns `409`; frontend shows: "You're already a member of this team." |
| Owner invites the same email twice | Second `POST /api/teams/:id/members` returns `409` if a pending invite already exists for that email + team |
| Invitation expires before invitee accepts | Token lookup returns `410`; frontend shows expiry message; Settings list marks invitation as expired |
| Invitee's email changes between invite and sign-up | Not auto-accepted; manual re-invite required |
| Team deleted before invite is accepted | `ON DELETE CASCADE` removes invitation; token lookup returns `404` |

---

## 9. E2E Testing

### 9.1 Critical Flows

1. **Owner invites a new user** — invite form submitted → pending invitation appears in Settings → email is sent (assert Resend mock call)
2. **New user follows link and signs up** — `/invite` page shows team details → redirect to sign-up → after sign-up, user is a team member with correct role → onboarding wizard completes → lands in workspace
3. **Existing user accepts invite** — signed-in user hits `/invite` page → clicks "Join team" → immediately added as member → redirected to workspace (no onboarding)
4. **Owner cancels invitation** — cancel button in Settings → invitation removed from list → token link returns `410`
5. **Owner resends invitation** — resend button in Settings → expiry resets → Resend mock called again
6. **Expired invitation link** — token older than 7 days → `/invite` shows expiry message
7. **Duplicate invite attempt** — second invite to same email → error toast: "A pending invitation already exists for this address"

### 9.2 Test Scenarios (Given/When/Then)

**Scenario 1: Invite a new user**
```
Given: The current user is a team owner or admin
  And: The invitee email does not belong to an existing user
When: Owner submits the invite form in Settings → Team
Then: A pending invitation row is created in team_invitations
  And: The invitation appears in the pending list in Settings
  And: The Resend mock is called with the correct recipient email and invite link
```

**Scenario 2: New user accepts via link**
```
Given: A pending invitation exists for new-user@example.com
  And: The invitee navigates to /invite?token=<uuid>
When: The invitee completes Clerk sign-up with new-user@example.com
Then: The invitation status is updated to 'accepted'
  And: A teamMembers row is created with the correct role
  And: The user is redirected to /onboarding?context=invite
  And: After completing onboarding, the user lands in the workspace
```

**Scenario 3: Existing user accepts via link**
```
Given: A pending invitation exists for existing@example.com
  And: The invitee is already signed in to Nyx as existing@example.com
  And: The invitee navigates to /invite?token=<uuid>
When: The invitee clicks "Join team"
Then: The invitation status is updated to 'accepted'
  And: A teamMembers row is created immediately
  And: The user is redirected directly to the workspace (no onboarding)
```

**Scenario 4: Expired invitation**
```
Given: A teamInvitations row exists with expires_at in the past
When: Any user navigates to /invite?token=<uuid>
Then: GET /api/invitations/:token returns 410
  And: The page shows "This invitation has expired"
  And: No membership is created
```

### 9.3 Test File Locations

```
e2e/
  team-invites.spec.ts        # Existing file — extend with new scenarios
  invite-page.spec.ts         # New — /invite page states (valid, expired, not-found)
  onboarding.spec.ts          # New — multi-step onboarding wizard
```

### 9.4 Integration Boundaries

| External Service | Test Strategy |
|---|---|
| Resend (email) | Mock the Resend SDK; assert the mock was called with correct args |
| Clerk (sign-up) | Use `authenticatedPage` fixture for signed-in flows; mock redirect for sign-up flow |
| Database | Use `drizzle-kit push --force` in CI; seed invitation rows in test setup |

---

## 10. Out of Scope (MVP)

- Magic-link sign-in (invitees always go through standard Clerk sign-up/sign-in)
- Bulk invite (multiple emails at once)
- Invite via shareable link (no-email join link)
- SSO/SAML domain-based auto-join
- Invitation email localization
- Invite reminders / automated follow-up emails
