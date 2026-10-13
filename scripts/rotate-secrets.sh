#!/usr/bin/env bash
# rotate-secrets.sh — post-breach secret rotation runbook (issue #372)
#
# WHEN TO USE: After any suspected or confirmed credential exposure.
# The 2026-04-19 breach requires ALL secrets in Railway + Vercel to be rotated.
#
# USAGE:
#   1. Generate new values at each external provider (steps below).
#   2. Run the Railway / Vercel update commands for each secret.
#   3. Redeploy and verify health endpoint.
#   4. Revoke the old credentials at each provider.
#
# The script is a reference and checklist — it does NOT rotate secrets itself
# because each provider requires dashboard access or an authenticated API call.
#
# ── Safety checks ─────────────────────────────────────────────────────────────
set -euo pipefail

# Require explicit confirmation before listing current variable names.
if [[ "${1:-}" != "--audit" && "${1:-}" != "--help" ]]; then
  echo ""
  echo "  Usage:"
  echo "    $0 --audit     List Railway + Vercel variable NAMES (no values)"
  echo "    $0 --help      Show this message"
  echo ""
  exit 0
fi

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
rotate-secrets.sh — Nyx secret rotation runbook

PROVIDER-BY-PROVIDER STEPS
═══════════════════════════

1. CLERK (auth)
   ─────────────
   a. Log in at https://dashboard.clerk.com → API Keys
   b. Click "Add new key" → copy the new sk_live_* secret key
   c. Copy the new pk_live_* publishable key
   d. Update Railway:
      railway variables --set "CLERK_SECRET_KEY=sk_live_<new>"
   e. Update Vercel:
      vercel env rm VITE_CLERK_PUBLISHABLE_KEY production --yes
      vercel env add VITE_CLERK_PUBLISHABLE_KEY production   # paste new value
   f. AFTER verifying app boots: revoke the old key in Clerk dashboard

2. DATABASE / PostgreSQL
   ───────────────────────
   a. Change the password at your database provider (Railway Postgres or Neon).
      Railway Postgres: dashboard → Variables tab → change PGPASSWORD
      Neon: Settings → Reset password
   b. Build the new connection string:
      DATABASE_URL=postgresql://<user>:<new-password>@<host>:5432/nyx
   c. Update Railway:
      railway variables --set "DATABASE_URL=<new-url>"

3. ANTHROPIC API KEY
   ──────────────────
   a. Go to https://console.anthropic.com → API Keys
   b. Create a new key, copy it
   c. Update Railway:
      railway variables --set "ANTHROPIC_API_KEY=sk-ant-<new>"
   d. Revoke the old key in the Anthropic console

4. GITHUB OAUTH APP (client secret + webhook secret)
   ───────────────────────────────────────────────────
   a. Go to https://github.com/settings/developers → OAuth Apps → Nyx
   b. Click "Generate a new client secret" → copy it
   c. Generate a new webhook secret:
      openssl rand -hex 32
   d. Update Railway:
      railway variables \
        --set "GITHUB_CLIENT_SECRET=<new>" \
        --set "GITHUB_WEBHOOK_SECRET=<new-webhook-secret>"
   e. Update the GitHub App's webhook secret at github.com if registered separately

5. ENCRYPTION SECRETS (OAuth token encryption + BYOK)
   ─────────────────────────────────────────────────────
   NOTE: Rotating these invalidates ALL stored OAuth tokens and BYOK keys.
   Users will need to re-connect GitHub, Atlassian, Slack, and re-enter custom keys.
   a. Generate two new 32-byte hex secrets:
      openssl rand -hex 32   # for ENCRYPTION_SECRET
      openssl rand -hex 32   # for BYOK_ENCRYPTION_SECRET
   b. Update Railway:
      railway variables \
        --set "ENCRYPTION_SECRET=<new>" \
        --set "BYOK_ENCRYPTION_SECRET=<new>"

6. STRIPE (if configured)
   ─────────────────────────
   a. Go to https://dashboard.stripe.com → Developers → API Keys
   b. Roll the secret key → copy new sk_live_* value
   c. Generate a new webhook endpoint secret in Stripe → Webhooks → <endpoint> → Signing secret
   d. Update Railway:
      railway variables \
        --set "STRIPE_SECRET_KEY=sk_live_<new>" \
        --set "STRIPE_WEBHOOK_SECRET=whsec_<new>"

7. ATLASSIAN / JIRA (if configured)
   ─────────────────────────────────
   a. Go to https://developer.atlassian.com/console/myapps → Nyx app → Settings
   b. Create new secret → copy it
   c. Generate a new webhook secret:
      openssl rand -hex 32
   d. Update Railway:
      railway variables \
        --set "ATLASSIAN_CLIENT_SECRET=<new>" \
        --set "JIRA_WEBHOOK_SECRET=<new>"

8. SLACK (if configured)
   ─────────────────────────
   a. Go to https://api.slack.com/apps → Nyx → Basic Information
   b. Rotate Client Secret and Signing Secret
   c. Update Railway:
      railway variables \
        --set "SLACK_CLIENT_SECRET=<new>" \
        --set "SLACK_SIGNING_SECRET=<new>"

POST-ROTATION STEPS
═══════════════════
   railway redeploy --yes
   # Wait ~60s, then:
   curl -sf https://nyx-staging.up.railway.app/api/health | jq .
   # Expected: { "status": "ok", ... }

VERIFY OLD KEYS ARE REVOKED
═════════════════════════════
   - Clerk dashboard: confirm old key shows "Revoked"
   - Anthropic console: confirm old key is deleted
   - GitHub: confirm old client secret is removed
   - Stripe: confirm old secret key is rolled / deleted
HELP
  exit 0
fi

# ── --audit mode: list current variable names in Railway and Vercel ───────────
echo ""
echo "=== Railway environment variables (NAMES only) ==="
echo ""
railway variables --kv 2>/dev/null | cut -d= -f1 | sort || echo "  (railway CLI not authenticated — run: railway login)"

echo ""
echo "=== Vercel environment variables (production) ==="
echo ""
vercel env ls production 2>/dev/null || echo "  (vercel CLI not authenticated — run: vercel login)"

echo ""
echo "Run '$0 --help' for step-by-step rotation instructions."
echo ""
