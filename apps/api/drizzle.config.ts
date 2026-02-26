import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const nodeEnv = process.env.NODE_ENV || 'development';
const isDevelopment = nodeEnv !== 'production';

const databaseUrl = process.env.DATABASE_URL || (isDevelopment ? 'postgresql://postgres:postgres@localhost:5432/syncdocs' : undefined);

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required in production');
}

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});
