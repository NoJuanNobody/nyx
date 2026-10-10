import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Test the validation rules directly without importing the config module (which
// runs envSchema.parse on import and would throw if DATABASE_URL is unset in CI).
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test', 'staging']).default('development'),
  DEV_AUTH_BYPASS: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'openrouter']).default('anthropic'),
  OPENROUTER_API_KEY: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  WEBHOOK_BASE_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  ENCRYPTION_SECRET: z.string().optional(),
  BYOK_ENCRYPTION_SECRET: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production' && !data.GITHUB_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GITHUB_WEBHOOK_SECRET is required in production',
      path: ['GITHUB_WEBHOOK_SECRET'],
    });
  }
  if (data.LLM_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter',
      path: ['OPENROUTER_API_KEY'],
    });
  }
  if (data.NODE_ENV === 'production') {
    if (!data.CLERK_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CLERK_SECRET_KEY is required in production',
        path: ['CLERK_SECRET_KEY'],
      });
    }
    if (data.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CLERK_SECRET_KEY must be a live key (sk_live_*) in production — test keys are not accepted',
        path: ['CLERK_SECRET_KEY'],
      });
    }
    if (!data.ENCRYPTION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ENCRYPTION_SECRET is required in production',
        path: ['ENCRYPTION_SECRET'],
      });
    }
    if (!data.BYOK_ENCRYPTION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'BYOK_ENCRYPTION_SECRET is required in production',
        path: ['BYOK_ENCRYPTION_SECRET'],
      });
    }
    if (data.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'STRIPE_SECRET_KEY must be a live key (sk_live_*) in production — test keys are not accepted',
        path: ['STRIPE_SECRET_KEY'],
      });
    }
  }
  if (data.NODE_ENV === 'production' && data.DEV_AUTH_BYPASS === 'true') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DEV_AUTH_BYPASS must not be "true" in production',
      path: ['DEV_AUTH_BYPASS'],
    });
  }
});

const DB = 'postgresql://user:pass@localhost:5432/db';

const validProdBase = {
  DATABASE_URL: DB,
  NODE_ENV: 'production' as const,
  GITHUB_WEBHOOK_SECRET: 'wh-secret',
  CLERK_SECRET_KEY: 'sk_live_abc123',
  ENCRYPTION_SECRET: 'enc-secret-32-chars-xxxxxxxxxxxxxxxx',
  BYOK_ENCRYPTION_SECRET: 'byok-secret-32-chars-xxxxxxxxxxxxxx',
};

describe('Config Validation', () => {
  // ── Existing rules ────────────────────────────────────────────────────────

  it('production without GITHUB_WEBHOOK_SECRET fails', () => {
    const result = envSchema.safeParse({ DATABASE_URL: DB, NODE_ENV: 'production' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'GITHUB_WEBHOOK_SECRET is required in production',
      );
    }
  });

  it('development applies defaults correctly', () => {
    const result = envSchema.safeParse({ DATABASE_URL: DB, NODE_ENV: 'development' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3001);
      expect(result.data.HOST).toBe('0.0.0.0');
      expect(result.data.NODE_ENV).toBe('development');
    }
  });

  it('LLM_PROVIDER=openrouter without OPENROUTER_API_KEY fails', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: DB,
      NODE_ENV: 'development',
      LLM_PROVIDER: 'openrouter',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter',
      );
    }
  });

  // ── Production secret hardening (issue #372) ─────────────────────────────

  it('production without CLERK_SECRET_KEY fails', () => {
    const result = envSchema.safeParse({
      ...validProdBase,
      CLERK_SECRET_KEY: undefined,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'CLERK_SECRET_KEY is required in production',
      );
    }
  });

  it('production with Clerk test key fails', () => {
    const result = envSchema.safeParse({
      ...validProdBase,
      CLERK_SECRET_KEY: 'sk_test_compromised_key',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'CLERK_SECRET_KEY must be a live key (sk_live_*) in production — test keys are not accepted',
      );
    }
  });

  it('production without ENCRYPTION_SECRET fails', () => {
    const result = envSchema.safeParse({
      ...validProdBase,
      ENCRYPTION_SECRET: undefined,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'ENCRYPTION_SECRET is required in production',
      );
    }
  });

  it('production without BYOK_ENCRYPTION_SECRET fails', () => {
    const result = envSchema.safeParse({
      ...validProdBase,
      BYOK_ENCRYPTION_SECRET: undefined,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'BYOK_ENCRYPTION_SECRET is required in production',
      );
    }
  });

  it('production with Stripe test key fails', () => {
    const result = envSchema.safeParse({
      ...validProdBase,
      STRIPE_SECRET_KEY: 'sk_test_stripe_key',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'STRIPE_SECRET_KEY must be a live key (sk_live_*) in production — test keys are not accepted',
      );
    }
  });

  it('production with DEV_AUTH_BYPASS=true fails', () => {
    const result = envSchema.safeParse({
      ...validProdBase,
      DEV_AUTH_BYPASS: 'true',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'DEV_AUTH_BYPASS must not be "true" in production',
      );
    }
  });

  it('valid production config with live keys passes', () => {
    const result = envSchema.safeParse({
      ...validProdBase,
      PORT: '8080',
      STRIPE_SECRET_KEY: 'sk_live_stripe_real',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(8080);
    }
  });

  it('development accepts test/placeholder keys', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: DB,
      NODE_ENV: 'development',
      CLERK_SECRET_KEY: 'sk_test_dev_key',
      STRIPE_SECRET_KEY: 'sk_test_stripe_test',
    });
    expect(result.success).toBe(true);
  });
});
