# Local profile and OS-keychain secrets (AI-61)

Nyx desktop is single-user and local. Hosted auth (Clerk) goes away. Implemented in
`crates/nyx-core/src/profile/`.

## Model

- **Profile** (`profile::Profile`): `id` (random 128-bit hex), `display_name`, `created_at` (RFC 3339 UTC),
  optional `legacy_clerk_id`. Stored as `profile.json` in the OS app-data dir
  (`directories::ProjectDirs("dev","nyx","Nyx")`, e.g. `~/Library/Application Support/Nyx`).
  Contains no secrets and no email. `ProfileStore::at(dir)` overrides the location (tests, portable mode).
- **Secrets** (`profile::SecretStore` trait): keyed by `SecretKey { provider, kind }` where provider is
  Anthropic / OpenAi / OpenRouter / GitHub / Jira / Slack / Other(slug) and kind is ApiKey / AccessToken / RefreshToken.
  Values are `secrecy::SecretString`, so `Debug` prints `[REDACTED]`; no secret type implements `Serialize`.
  - `KeychainSecretStore`: default, via `keyring` (macOS Keychain, Windows Credential Manager, Linux keyutils).
    Service name `dev.nyx.desktop`.
  - `EncryptedFileSecretStore`: headless/CI fallback. Argon2id passphrase KDF + ChaCha20-Poly1305, random salt/nonce
    per write, file mode 0600, atomic replace. No plaintext (not even key names) on disk.
  - `MemorySecretStore`: tests/ephemeral.
  - `Secrets<S>` facade: `set_api_key`/`api_key` (BYOK), `set_token`/`token` (integrations), `forget_provider`.
- Acceptance: no hosted auth dependency in the Rust side; secrets never plaintext on disk (keychain or encrypted file only).
- Tests use only the in-memory and temp-dir encrypted stores. One real-keychain test is `#[ignore]`d:
  `cargo test -p nyx-core -- --ignored real_keychain`.

## Selection policy (to wire in the desktop shell / CLI / MCP)

1. Try `KeychainSecretStore`; probe with a set/get/delete on a throwaway key.
2. If the probe fails (headless Linux, CI) and `NYX_SECRETS_PASSPHRASE` is set, use `EncryptedFileSecretStore`
   at `<app-data>/secrets.enc`.
3. Otherwise refuse to persist secrets (fall back to `MemorySecretStore`, session only) and tell the user.

## OAuth (GitHub / Atlassian) - TODO, not in this change

Loopback redirect flow (RFC 8252): bind `127.0.0.1:0`, open the system browser with PKCE, receive the code,
exchange it, store the result with `Secrets::set_token`. Needs an HTTP client; deliberately left out of nyx-core.

## Migration from Clerk users

- Local users table has `users.clerk_id`. Desktop is single-user: pick the first/owner user (or let the user choose),
  call `Profile::from_legacy_clerk(clerk_id, name)` and save it. Email is intentionally dropped.
- Clerk-held data (sessions, OAuth connections) cannot be exported as tokens: users re-enter BYOK keys and re-authorize
  GitHub/Jira/Slack once.
- Existing plaintext keys in the TS DB / `.env` (`ANTHROPIC_API_KEY`, integration tokens): import once into the
  `SecretStore`, then delete from the DB and rotate if they ever left the machine (`scripts/rotate-secrets.sh`).
- Hosted deployments (if any remain) are out of scope; they keep Clerk until the TS API is retired.

## Clerk removal plan (TS apps) - NOT done in this change

Removal touches auth for every route plus tests and e2e, so it is not small/safe in a parallel swarm. Files to change:

API (`apps/api`):
- `src/middleware/auth.ts` - replace with a local-user middleware (single implicit user), drop `verifyToken`,
  `createClerkClient`, `upsertUser`, `resolveClerkUser`, Clerk OAuth branch. Keep API-key auth if still wanted.
- `src/lib/clerk.ts` - delete.
- `src/lib/config.ts` - drop `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and the production checks (lines ~34, 89-100).
- `src/app.ts` - remove `clerk.nyx-creative.com` / `accounts.nyx-creative.com` from CSP (lines ~115, 118).
- `src/db/schema.ts` - `users.clerk_id` column: drop via a new migration (next after 0026, add `_journal.json` entry).
- `package.json` - remove `@clerk/backend`, `@clerk/mcp-tools`.
- `src/__tests__/routes/users.test.ts` and any test mocking Clerk.

Web (`apps/web`):
- `src/main.tsx`, `src/App.tsx` - remove `ClerkProvider` and Clerk hooks.
- `src/components/AuthGuard.tsx`, `src/pages/SignIn.tsx`, `src/pages/SignUp.tsx`, `src/pages/AcceptInvite.tsx` - delete/replace.
- `src/components/Sidebar.tsx`, `src/pages/Settings.tsx`, `src/lib/api.ts` (token getter), `src/lib/analytics.ts`,
  `src/vite-env.d.ts`, `src/__tests__/setup.ts`, `index.html` - remove Clerk usages.
- `package.json` - remove `@clerk/*`.

Other: `e2e/auth.spec.ts`, `e2e/landing.spec.ts`, `e2e/fixtures/test-base.ts`, `playwright.config.ts`, `.env.example`,
`.github/workflows/ci.yml`, `vercel.json`, `scripts/rotate-secrets.sh`, `.agentpolicy/*.json`, `LOCAL_DEV_KEYS_GUIDE.md`,
`CLAUDE.md`, `README.md`. The TS apps are being replaced by the Rust desktop shell, so the pragmatic path is to delete
them with the rest of the TS stack rather than refactor.
