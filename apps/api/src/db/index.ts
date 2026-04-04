import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '../lib/config.js';
import * as schema from './schema.js';

const client = postgres(config.DATABASE_URL);
export const db = drizzle(client, { schema });

// Activate pgvector extension (idempotent — safe to run on every startup)
await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
