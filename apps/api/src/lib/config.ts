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
  // ── LLM provider selection (OpenRouter migration, issue #450) ──
  // `anthropic` (default) keeps calling the Anthropic Messages API directly.
  // `openrouter` routes every LLM call through OpenRouter's OpenAI-compatible
  // endpoint, giving one key access to many models. Model names are
  // configurable so they are never hardcoded across services.
  OPENROUTER_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'openrouter']).default('anthropic'),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_DEFAULT_MODEL: z.string().optional(),
  LLM_FAST_MODEL: z.string().optional(),
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
  EMAIL_FROM: z.string().optional(),
  APP_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  RECALL_AI_API_KEY: z.string().optional(),
  RECALL_AI_WEBHOOK_SECRET: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  OTTER_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  SUPER_ADMIN_EMAILS: z.string().optional(),
  HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().default(3000),
  HEALTH_LOG_FAILURES: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  BYOK_ENCRYPTION_SECRET: z.string().optional(),
  ATLASSIAN_CLIENT_ID: z.string().optional(),
  ATLASSIAN_CLIENT_SECRET: z.string().optional(),
  ENCRYPTION_SECRET: z.string().optional(),
  JIRA_WEBHOOK_SECRET: z.string().optional(),
  GITLAB_CLIENT_ID: z.string().optional(),
  GITLAB_CLIENT_SECRET: z.string().optional(),
  GITLAB_BASE_URL: z.string().optional(),
  BITBUCKET_CLIENT_ID: z.string().optional(),
  BITBUCKET_CLIENT_SECRET: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  SENTRY_DSN: z.string().url().optional(),
  MCP_SELF_URL: z.string().url().optional(),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production' && !data.GITHUB_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GITHUB_WEBHOOK_SECRET is required in production',
      path: ['GITHUB_WEBHOOK_SECRET'],
    });
  }
  // When OpenRouter is the selected provider, its key is mandatory — otherwise
  // every LLM call would fail at runtime with an auth error.
  if (data.LLM_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter',
      path: ['OPENROUTER_API_KEY'],
    });
  }

  if (data.NODE_ENV === 'production') {
    // Clerk auth key is required — without it, auth middleware silently bypasses all requests.
    if (!data.CLERK_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CLERK_SECRET_KEY is required in production',
        path: ['CLERK_SECRET_KEY'],
      });
    }
    // Reject test-mode Clerk keys — Clerk live keys start with sk_live_.
    // Test keys (sk_test_) cannot authenticate real users and may have been
    // compromised in the 2026-04-19 security breach.
    if (data.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CLERK_SECRET_KEY must be a live key (sk_live_*) in production — test keys are not accepted',
        path: ['CLERK_SECRET_KEY'],
      });
    }
    // ENCRYPTION_SECRET is required to encrypt and decrypt stored OAuth tokens
    // (GitHub, Atlassian, Slack). Missing it causes silent failures in integrations.
    if (!data.ENCRYPTION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ENCRYPTION_SECRET is required in production',
        path: ['ENCRYPTION_SECRET'],
      });
    }
    // BYOK_ENCRYPTION_SECRET encrypts user-provided API keys stored in the database.
    if (!data.BYOK_ENCRYPTION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'BYOK_ENCRYPTION_SECRET is required in production',
        path: ['BYOK_ENCRYPTION_SECRET'],
      });
    }
  }

  // Belt-and-suspenders guard: the auth middleware already rejects DEV_AUTH_BYPASS in
  // production at request time; this check prevents the server from starting at all.
  if (data.NODE_ENV === 'production' && data.DEV_AUTH_BYPASS === 'true') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DEV_AUTH_BYPASS must not be "true" in production',
      path: ['DEV_AUTH_BYPASS'],
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
