import { execSync } from 'node:child_process';

/**
 * Playwright globalSetup — runs once before the entire E2E suite.
 * Seeds the database with deterministic test data using idempotent inserts.
 */
export default function globalSetup() {
  console.log('\n[e2e] Running database seed...');
  execSync('pnpm --filter api db:seed', {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'development' },
  });
  console.log('[e2e] Database seed complete.\n');
}
