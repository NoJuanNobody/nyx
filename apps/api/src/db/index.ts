import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '../lib/config.js';
import * as schema from './schema.js';

const client = postgres(config.DATABASE_URL);
export const db = drizzle(client, { schema });

// Activate pgvector extension (idempotent — safe to run on every startup)
// Wrapped in try/catch so the API still starts when pgvector isn't installed locally.
// Vector features (RAG, embeddings, code search) will be unavailable without it.
try {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
} catch {
  console.warn('[db] pgvector extension not available — vector features disabled');
}
