/**
 * One-time transition script: seeds the Drizzle __drizzle_migrations table so that
 * all existing migrations (0000–0023) are marked as already applied.
 *
 * Run this ONCE against any database that was previously managed with
 * `drizzle-kit push --force` BEFORE switching to `drizzle-kit migrate`.
 * Running it more than once is safe (upserts on hash).
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter api exec tsx scripts/seed-migration-history.ts
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(__dirname, '..', 'drizzle');
const journalPath = join(drizzleDir, 'meta', '_journal.json');

interface JournalEntry { idx: number; tag: string; when: number; }
interface Journal { entries: JournalEntry[]; }

const journal: Journal = JSON.parse(readFileSync(journalPath, 'utf8'));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = postgres(databaseUrl, { max: 1 });

async function run() {
  await sql`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `;

  const sorted = [...journal.entries].sort((a, b) => a.idx - b.idx);

  for (const entry of sorted) {
    const filePath = join(drizzleDir, `${entry.tag}.sql`);
    const content = readFileSync(filePath, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');

    const existing = await sql`SELECT id FROM "__drizzle_migrations" WHERE hash = ${hash}`;
    if (existing.length > 0) {
      console.log(`  already applied: ${entry.tag}`);
      continue;
    }

    await sql`
      INSERT INTO "__drizzle_migrations" (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `;
    console.log(`  seeded: ${entry.tag}`);
  }

  console.log('\nDone — migration history seeded. You can now switch to drizzle-kit migrate.');
  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
