import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from repo root (../../.. from src/lib/)
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const nodeEnv = process.env.NODE_ENV || 'development';
const isDevelopment = nodeEnv !== 'production';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test', 'staging']).default('development'),
  DEV_AUTH_BYPASS: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  WEBHOOK_BASE_URL: z.string().url().optional(),
  GITHUB_FEEDBACK_PAT: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  APP_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RECALL_AI_API_KEY: z.string().optional(),
  RECALL_AI_WEBHOOK_SECRET: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  OTTER_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  SUPER_ADMIN_EMAILS: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production' && !data.GITHUB_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GITHUB_WEBHOOK_SECRET is required in production',
      path: ['GITHUB_WEBHOOK_SECRET'],
    });
  }
});

// Inject localhost fallback only in development
const envWithDefaults = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || (isDevelopment ? 'postgresql://postgres:postgres@localhost:5432/nyx' : undefined),
};

export const config = envSchema.parse(envWithDefaults);
export type Config = z.infer<typeof envSchema>;
