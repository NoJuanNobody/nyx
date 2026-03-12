# SyncDocs — How to Get API Keys for Local Development

This guide walks you through obtaining the API keys referenced in `.env.example`.

---

## 1. Clerk (Authentication)

Clerk handles user authentication. You need your own free dev instance.

**Keys needed:** `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`

### Steps

1. Go to [clerk.com](https://clerk.com) and sign up for a free account.
2. Create a new **Application** (name it something like "SyncDocs Dev").
3. In your Clerk dashboard, go to **API Keys** (left sidebar).
4. Copy the **Publishable key** (`pk_test_...`) and **Secret key** (`sk_test_...`).
5. In your `.env` file, set:
   ```
   CLERK_SECRET_KEY=sk_test_your_key_here
   CLERK_PUBLISHABLE_KEY=pk_test_your_key_here
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_your_key_here
   ```
   Note: `CLERK_PUBLISHABLE_KEY` and `VITE_CLERK_PUBLISHABLE_KEY` use the **same** publishable key.

> Clerk's free tier is generous and more than enough for local development.

---

## 2. Anthropic (AI Features)

The Anthropic API key powers AI-assisted spec writing and drift detection.

**Key needed:** `ANTHROPIC_API_KEY`

### Steps

1. Go to [console.anthropic.com](https://console.anthropic.com) and create an account.
2. Navigate to **API Keys** in the left sidebar.
3. Click **Create Key**, give it a name (e.g., "SyncDocs Dev").
4. Copy the key (`sk-ant-...`) and set it in your `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-your_key_here
   ```

> **Billing note:** Anthropic requires a credit card and charges per usage. For local dev, costs are minimal (a few cents per request). You can set a monthly spending limit in the dashboard under **Plans & Billing → Limits**.

---

## 3. GitHub Integration

GitHub integration is used for OAuth login, webhook-driven drift detection, and issue creation.

**Keys needed:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`

### Steps — OAuth App

1. Go to [github.com/settings/developers](https://github.com/settings/developers).
2. Click **OAuth Apps → New OAuth App**.
3. Fill in:
   - **Application name:** SyncDocs Dev
   - **Homepage URL:** `http://localhost:5173`
   - **Authorization callback URL:** `http://localhost:3001/api/auth/github/callback`
4. Click **Register application**.
5. Copy the **Client ID** and generate a **Client Secret**.
6. Set them in your `.env`:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

### Steps — Webhook Secret

The webhook secret is used to verify that incoming webhook payloads are genuinely from GitHub. For local dev you can generate one yourself:

```bash
openssl rand -hex 32
```

Set it in your `.env`:
```
GITHUB_WEBHOOK_SECRET=your_generated_hex_string
```

> **Note:** `WEBHOOK_BASE_URL` is only needed if you're testing webhooks locally (e.g., via a tunnel like ngrok). You can leave it blank for most local development.

---

## 4. Database (PostgreSQL)

No external account needed. The default in `.env.example` works if you have Postgres running locally:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/syncdocs
```

If you'd rather use Docker:

```bash
docker compose up -d
```

and use `DATABASE_URL=postgresql://postgres:devpassword@localhost:5432/syncdocs_dev`.

---

## Quick Checklist

| Service   | Where to sign up                         | Free tier? |
| --------- | ---------------------------------------- | ---------- |
| Clerk     | [clerk.com](https://clerk.com)           | Yes        |
| Anthropic | [console.anthropic.com](https://console.anthropic.com) | Pay-per-use (credit card required) |
| GitHub    | [github.com/settings/developers](https://github.com/settings/developers) | Yes        |

---

Once you have all the keys, copy `.env.example` to `.env` and fill in the values. Then run:

```bash
pnpm install
pnpm dev
```

Let me know if you run into any issues!
