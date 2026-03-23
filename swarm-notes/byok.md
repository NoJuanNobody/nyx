# BYOK Implementation Notes

## What Changed

Implemented Bring Your Own Key (BYOK) feature allowing team admins to supply their own Anthropic API key for AI-powered features.

## Files Modified

- `apps/api/src/db/schema.ts` — Added `teamAiKeys` and `aiUsageLog` tables
- `apps/api/src/services/encryption.service.ts` — NEW: AES-256-GCM encrypt/decrypt service
- `apps/api/src/lib/config.ts` — Added `BYOK_ENCRYPTION_SECRET` env var
- `apps/api/src/routes/ai-keys.ts` — NEW: CRUD endpoints for team AI keys + usage stats
- `apps/api/src/services/ai.service.ts` — Added `resolveClient(teamId?)` with BYOK-aware routing and client caching, exported `invalidateTeamClient`
- `apps/api/src/app.ts` — Registered `aiKeyRoutes` at `/api/teams`
- `apps/web/src/lib/api.ts` — Added BYOK API functions and types
- `apps/web/src/pages/Settings.tsx` — Added AI Configuration tab with key management UI
- `packages/shared/src/types/byok.ts` — NEW: Shared BYOK types (AiProvider, KeySource, schemas)
- `packages/shared/src/index.ts` — Re-exported BYOK types
- `apps/api/src/__tests__/helpers/setup.ts` — Added BYOK_ENCRYPTION_SECRET to test config mock
- `apps/api/src/__tests__/services/encryption.service.test.ts` — NEW: 6 tests for encryption round-trip, uniqueness, tampering
- `apps/api/src/__tests__/routes/ai-keys.test.ts` — NEW: 7 tests for all BYOK API endpoints

## Assumptions

- The `resolveClient` function uses dynamic imports for db/schema to avoid circular dependency at module load time
- Client caching uses a Map with 5-minute TTL per the spec
- Key validation against the Anthropic API is deferred — the current implementation stores the key on submission without pre-validating against the provider. This is a follow-up item.
- Usage logging is schema-ready but not yet wired into every AI method call — the `aiUsageLog` table exists and the usage endpoint works, but actual token logging after each AI response is a follow-up.
- Tier gating checks the `subscriptions` table for team/enterprise plans.

## Governance Conflicts

None. Implementation follows all governance rules:
- No .env files read or modified
- Security-first: keys encrypted with AES-256-GCM, never exposed in responses
- Tests included for new services and routes
- Scoped to BYOK feature only

## Follow-up Items

1. Wire actual token usage logging into each `ai.service.ts` method after AI responses
2. Add key validation against provider API before storing (call Anthropic /v1/models)
3. Add audit trail entries for key lifecycle events (ai_key_added, ai_key_rotated, ai_key_removed)
4. Add in-app notification when a key becomes invalid (401 detection during use)
5. Add E2E Playwright tests for the AI Configuration UI flows
6. BYOK_ENCRYPTION_SECRET needs to be set in Railway staging and production environments
