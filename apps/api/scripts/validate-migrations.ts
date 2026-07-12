/**
 * Validate that every entry in the Drizzle migration journal has a corresponding
 * SQL file on disk, and every SQL file on disk has a corresponding journal entry.
 * Run via: pnpm --filter api exec tsx scripts/validate-migrations.ts
 * Exit code 0 = consistent, 1 = inconsistencies found.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(__dirname, '..', 'drizzle');
const journalPath = join(drizzleDir, 'meta', '_journal.json');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const journal: Journal = JSON.parse(readFileSync(journalPath, 'utf8'));

const sqlFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.replace(/\.sql$/, ''));

const journalTags = new Set(journal.entries.map((e) => e.tag));
const sqlFileSet = new Set(sqlFiles);

const errors: string[] = [];

// Every journal entry must have a matching SQL file
for (const entry of journal.entries) {
  if (!sqlFileSet.has(entry.tag)) {
    errors.push(`Journal entry idx=${entry.idx} tag="${entry.tag}" has no matching SQL file`);
  }
}

// Every SQL file must appear in the journal
for (const file of sqlFiles) {
  if (!journalTags.has(file)) {
    errors.push(`SQL file "${file}.sql" is not registered in the migration journal`);
  }
}

// Journal entries must be sequentially indexed without gaps
const sortedEntries = [...journal.entries].sort((a, b) => a.idx - b.idx);
for (let i = 0; i < sortedEntries.length; i++) {
  if (sortedEntries[i].idx !== i) {
    errors.push(`Journal index gap: expected idx=${i}, found idx=${sortedEntries[i].idx} (tag="${sortedEntries[i].tag}")`);
  }
}

// No duplicate idx values
const idxCounts = new Map<number, number>();
for (const e of journal.entries) {
  idxCounts.set(e.idx, (idxCounts.get(e.idx) ?? 0) + 1);
}
for (const [idx, count] of idxCounts) {
  if (count > 1) {
    errors.push(`Duplicate journal idx=${idx} appears ${count} times`);
  }
}

if (errors.length > 0) {
  console.error('Migration journal validation FAILED:');
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  process.exit(1);
} else {
  console.log(`Migration journal OK: ${journal.entries.length} entries, all files present, no gaps or duplicates.`);
}
