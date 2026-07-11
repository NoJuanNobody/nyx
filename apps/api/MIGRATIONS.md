# Database Migration Guide

## TL;DR

- **CI (test):** `drizzle-kit push --force` — fast, no history tracking, fine for ephemeral test DBs
- **Production (Railway):** `drizzle-kit migrate` — journal-based, safe, tracks applied migrations in `__drizzle_migrations`
- **Adding a migration:** `pnpm --filter api db:generate`, review the generated SQL, commit both `.sql` file and updated `_journal.json`

---

## Migration files

All migration SQL files live in `apps/api/drizzle/`. The migration journal is at `apps/api/drizzle/meta/_journal.json`.

Each SQL file has a sequential prefix (0000–N) and a human-readable slug. The journal records every applied migration indexed from 0. Both must stay in sync — run `pnpm --filter api db:validate-migrations` to verify.

**Current sequence:** 0000 → 0023

---

## Workflow for new migrations

```bash
# 1. Edit apps/api/src/db/schema.ts with your changes
# 2. Generate the migration
pnpm --filter api db:generate

# 3. Review the generated .sql file in apps/api/drizzle/
# 4. Commit the .sql file AND the updated _journal.json together
git add apps/api/drizzle/
git commit -m "feat(db): <describe the schema change>"
```

**Never** manually create or rename SQL files after the journal is written — Drizzle uses the journal to find files by name. If you need to rename, update both the file and the journal entry together.

---

## Production deployment (Railway)

Production schema changes are applied automatically when Railway deploys the Docker image. The `CMD` in `apps/api/Dockerfile` runs `drizzle-kit migrate` before starting the API server.

`drizzle-kit migrate`:
- Reads `drizzle/meta/_journal.json` in order
- Checks `__drizzle_migrations` table to find the last applied migration
- Applies only unapplied migrations (idempotent, safe to re-run)
- Tracks each applied migration by content hash

### Transition: first deploy with migration-based CMD

If the production database was previously managed with `drizzle-kit push --force` (i.e., it has the correct schema but no `__drizzle_migrations` history table), run the following **once** before deploying this change:

```bash
# Against the production database
DATABASE_URL=<prod-url> pnpm --filter api db:migrate:seed-history
```

This seeds the `__drizzle_migrations` table with all 24 existing migrations (0000–0023) so that `drizzle-kit migrate` knows they are already applied. Without this step, `drizzle-kit migrate` would try to re-apply migrations on an existing database and fail on `CREATE TABLE` conflicts.

---

## Rollback strategy

Drizzle ORM does not generate `down` migrations. The rollback strategy depends on scope:

### Minor rollback (single column / constraint)
Write a new forward migration that undoes the change:
```bash
pnpm --filter api db:generate  # generates a new migration
```

### Major rollback (table drop or destructive change)
Use Railway's point-in-time recovery (PITR) to restore the database to a snapshot before the migration was applied. Steps:
1. In the Railway dashboard, go to the PostgreSQL service → Backups
2. Select the backup from before the failed deploy
3. Restore to a new database instance
4. Update `DATABASE_URL` to point to the restored instance
5. Deploy the previous Docker image

### Emergency: revert a deploy
```bash
railway rollback  # rolls back to the previous Railway deploy image
```
The database is NOT automatically rolled back — a code rollback without a DB rollback is safe only if the new migration is additive (columns/tables added). If the migration dropped or altered existing columns, a DB restore is also required.

---

## CI / test database

CI tests use `drizzle-kit push --force` against a fresh `nyx_test` PostgreSQL instance. This is intentional:
- It applies the full schema from `schema.ts` directly, bypassing the journal
- It is fast and handles any migration history inconsistencies without errors
- It is safe because the test database is ephemeral (created fresh each CI run)

The `--force` flag in CI does **not** imply production schema management — see above.

---

## Validating journal consistency

```bash
pnpm --filter api db:validate-migrations
```

This script checks:
1. Every journal entry has a matching `.sql` file
2. Every `.sql` file is registered in the journal
3. No duplicate or missing index values in the journal

Run this before any PR that adds or modifies migration files. It is also a good candidate for a pre-commit hook or CI step.
