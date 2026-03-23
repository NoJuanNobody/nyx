# Jira & Confluence OAuth Integration - Implementation Notes

## What Changed

Added full Atlassian OAuth 2.0 (3LO) integration with PKCE support for both Jira and Confluence.

## Files Modified

- `apps/api/src/db/schema.ts` — Added `atlassian_connections` table with status enum
- `apps/api/src/lib/config.ts` — Added `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `ENCRYPTION_SECRET` env vars
- `apps/api/src/app.ts` — Registered `atlassianRoutes` at `/api/integrations`
- `apps/web/src/lib/api.ts` — Added Atlassian API client functions
- `apps/web/src/pages/Settings.tsx` — Added AtlassianIntegration component + Jira/Confluence connect handling
- `packages/shared/src/index.ts` — Re-exported atlassian types

## Files Created

- `apps/api/src/lib/encryption.ts` — AES-256-GCM encrypt/decrypt utils for token storage
- `apps/api/src/lib/__tests__/encryption.test.ts` — Encryption round-trip, tamper detection tests
- `apps/api/src/services/atlassian.service.ts` — PKCE, token exchange/refresh/revoke, Jira/Confluence API operations, ADF conversion
- `apps/api/src/services/__tests__/atlassian.service.test.ts` — PKCE generation, ADF conversion, status mapping tests
- `apps/api/src/routes/integrations/atlassian.ts` — OAuth flow, Jira/Confluence CRUD endpoints, webhook handler, preferences
- `apps/web/src/components/AtlassianIntegration.tsx` — Settings UI for connect/disconnect, project/space selection, sync prefs
- `packages/shared/src/types/atlassian.ts` — Zod schemas for all Atlassian types

## Assumptions

- PKCE state is stored in-memory (Map with 10-min TTL). For multi-instance deployment, this should be moved to Redis or a DB table.
- The first accessible Atlassian Cloud site is used automatically. Multi-site selection could be added later.
- ADF conversion is simplified (text paragraphs only). Rich markdown-to-ADF conversion would need a dedicated library.
- The Jira webhook endpoint does not validate webhook secrets from Atlassian (webhook registration is not yet automated).
- Encryption key derivation uses SHA-256; production should use HKDF as noted in the spec.

## Governance Conflicts

None. All changes comply with governance rules:
- No .env files touched (only .env.example should be updated by Alejandro)
- Parameterized queries via Drizzle ORM
- Auth checks via request.user on all protected routes
- Tests included for new services and encryption utils

## Environment Variables Required

Alejandro needs to set these in Railway/Vercel before using the feature:
- `ATLASSIAN_CLIENT_ID` — From Atlassian Developer Console app
- `ATLASSIAN_CLIENT_SECRET` — From Atlassian Developer Console app
- `ENCRYPTION_SECRET` — Any strong random string (32+ characters) for token encryption

## Follow-Up Items

- Run `drizzle-kit push` or generate migration for the new `atlassian_connections` table
- Register the app in Atlassian Developer Console and configure redirect URI
- Add Jira webhook registration automation (currently manual)
- Add E2E tests for the OAuth flow (mocked) per the spec's test plan
- Consider Redis-backed PKCE store for multi-instance deployments
- Rich ADF conversion (headers, lists, code blocks, etc.)
