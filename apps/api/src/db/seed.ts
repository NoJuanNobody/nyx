import 'dotenv/config';
import { eq, and } from 'drizzle-orm';
import { db } from './index.js';
import { users, teams, teamMembers } from './schema.js';

// ── Development-only guard ────────────────────────────────────────
// This seed file creates fake users and teams with hardcoded UUIDs.
// It must NEVER run in production.

const NODE_ENV = process.env.NODE_ENV || 'development';

if (NODE_ENV === 'production') {
  console.error(
    '\n[seed] ERROR: Refusing to run seed data in production (NODE_ENV=production).\n' +
      'This seed file contains mock/dev-only data and must not be used in production.\n',
  );
  process.exit(1);
}

// ── Dev-only mock data ────────────────────────────────────────────
// These IDs are intentionally hardcoded zeroed UUIDs so they are
// easily recognisable as development fixtures.

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_TEAM_ID = '00000000-0000-0000-0000-000000000001';

async function seed() {
  console.log(`\n[seed] Running DEVELOPMENT seed data (NODE_ENV=${NODE_ENV})...`);
  console.log('[seed] WARNING: This data is for local development only.\n');

  // Upsert mock user (idempotent — unique constraint on email)
  await db
    .insert(users)
    .values({
      id: MOCK_USER_ID,
      email: 'dev@syncdocs.io',
      name: 'Dev User',
    })
    .onConflictDoNothing();

  console.log('[seed] Upserted mock user: dev@syncdocs.io');

  // Upsert default team (idempotent — unique constraint on slug)
  await db
    .insert(teams)
    .values({
      id: DEFAULT_TEAM_ID,
      name: 'Default Team',
      slug: 'default',
    })
    .onConflictDoNothing();

  console.log('[seed] Upserted default team: default');

  // Add mock user to default team as owner (idempotent — check before insert
  // because team_members has no unique constraint on (team_id, user_id))
  const existingMembership = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, DEFAULT_TEAM_ID), eq(teamMembers.userId, MOCK_USER_ID)))
    .limit(1);

  if (existingMembership.length === 0) {
    await db.insert(teamMembers).values({
      teamId: DEFAULT_TEAM_ID,
      userId: MOCK_USER_ID,
      role: 'owner',
    });
    console.log('[seed] Added mock user to default team as owner');
  } else {
    console.log('[seed] Mock user already a member of default team — skipped');
  }

  console.log('\n[seed] Development seed complete.\n');
  process.exit(0);
}

seed().catch((err) => {
  console.error('[seed] Seed failed:', err);
  process.exit(1);
});
