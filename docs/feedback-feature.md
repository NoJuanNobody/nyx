# In-App Feedback Feature

The feedback feature lets users submit bug reports, feature requests, and general feedback directly from the Nyx app. AI formats the raw input into a structured GitHub issue, and the user can preview and edit before submitting.

## How It Works

1. User clicks **Send Feedback** in the sidebar
2. Writes free-form feedback in plain language
3. Clicks **Format with AI** — Claude formats it into a structured ticket with title, body, and category
4. User previews the formatted ticket and can edit the title or body
5. Clicks **Submit Feedback** — the ticket is created as a GitHub issue with the `feedback` label and saved to the database

## Setup

### 1. Create a GitHub Personal Access Token

The feedback feature uses a dedicated GitHub PAT (not the user's OAuth token) to create issues on the Nyx repo.

1. Go to [github.com/settings/tokens/new](https://github.com/settings/tokens/new)
2. Select **Tokens (classic)**
3. Name: `nyx-feedback`
4. Expiration: your choice
5. Scope: check **`repo`** (required for creating issues on private repos)
6. Click **Generate token** and copy the `ghp_...` value

> **Important:** Use a **classic** token (starts with `ghp_`). Fine-grained tokens (`github_pat_...`) require per-repo permissions that can be difficult to configure for private repos.

### 2. Add the token to your environment

Add this line to `.env` in the repository root:

```env
GITHUB_FEEDBACK_PAT=ghp_your_token_here
```

### 3. Push the database schema

The feature requires the `feedback_submissions` table. Push it with:

```bash
pnpm --filter @nyx/api exec drizzle-kit push --force
```

### 4. Ensure the `feedback` label exists

The label should already exist on the repo. If not, create it:

```bash
gh label create feedback --repo NoJuanNobody/nyx --description "User-submitted feedback" --color "0E8A16"
```

### 5. Restart the dev server

```bash
pnpm dev
```

## API Endpoints

### `POST /api/feedback/format`

AI-formats raw feedback into a structured GitHub issue.

**Request:**
```json
{
  "message": "the diff view is hard to read on mobile"
}
```

**Response:**
```json
{
  "title": "Improve diff view readability on mobile devices",
  "body": "## Description\nThe diff view is difficult to read on mobile...",
  "category": "ux-improvement"
}
```

### `POST /api/feedback/submit`

Submits the formatted feedback as a GitHub issue and saves it to the database.

**Request:**
```json
{
  "rawMessage": "the diff view is hard to read on mobile",
  "title": "Improve diff view readability on mobile devices",
  "body": "## Description\n...",
  "category": "ux-improvement"
}
```

**Response:**
```json
{
  "id": "uuid",
  "githubIssueUrl": "https://github.com/NoJuanNobody/nyx/issues/85",
  "remaining": 4
}
```

## Rate Limiting

Users are limited to **5 feedback submissions per day**. The limit is enforced per-user via the `feedback_submissions` table. When exceeded, the API returns `429`.

## Categories

Feedback is automatically categorized by AI into one of:

- `bug` — something isn't working
- `feature-request` — new functionality
- `ux-improvement` — usability or design
- `documentation` — docs-related
- `other` — anything else

The category is applied as a GitHub label alongside `feedback`.

## Architecture

| Component | File |
| --- | --- |
| Sidebar button | `apps/web/src/components/Sidebar.tsx` |
| Feedback modal | `apps/web/src/components/FeedbackModal.tsx` |
| API client | `apps/web/src/lib/api.ts` (`formatFeedback`, `submitFeedback`) |
| Route handlers | `apps/api/src/routes/feedback.ts` |
| Service layer | `apps/api/src/services/feedback.service.ts` |
| Database schema | `apps/api/src/db/schema.ts` (`feedbackSubmissions`) |
| Unit tests | `apps/api/src/services/__tests__/feedback.service.test.ts` |
| E2E tests | `e2e/feedback.spec.ts` |
| E2E selectors | `e2e/fixtures/selectors.ts` (`feedback` section) |

## Troubleshooting

| Problem | Cause | Fix |
| --- | --- | --- |
| `GitHub API error 403: Resource not accessible` | Fine-grained PAT or missing `repo` scope | Use a classic token with `repo` scope |
| `relation "feedback_submissions" does not exist` | Schema not pushed to DB | Run `pnpm --filter @nyx/api exec drizzle-kit push --force` |
| `GITHUB_FEEDBACK_PAT is not configured` | Missing env var | Add `GITHUB_FEEDBACK_PAT=ghp_...` to `.env` |
| Feedback saved but no GitHub issue | PAT error caught silently | Check API server logs for the error |
| `Rate limit exceeded` | More than 5 submissions in 24 hours | Wait or adjust `MAX_PER_DAY` in `feedback.service.ts` |
