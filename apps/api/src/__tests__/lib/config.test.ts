import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

describe('Config Validation', () => {
  // We test the schema directly instead of the module (which runs on import)
  const envSchema = z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().default(3001),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    ANTHROPIC_API_KEY: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    CLERK_SECRET_KEY: z.string().optional(),
    CLERK_PUBLISHABLE_KEY: z.string().optional(),
    WEBHOOK_BASE_URL: z.string().url().optional(),
  }).superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production' && !data.GITHUB_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GITHUB_WEBHOOK_SECRET is required in production',
        path: ['GITHUB_WEBHOOK_SECRET'],
      });
    }
  });

  it('production without GITHUB_WEBHOOK_SECRET fails validation', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      NODE_ENV: 'production',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('GITHUB_WEBHOOK_SECRET is required in production');
    }
  });

  it('development applies defaults correctly', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      NODE_ENV: 'development',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3001);
      expect(result.data.HOST).toBe('0.0.0.0');
      expect(result.data.NODE_ENV).toBe('development');
    }
  });

  it('valid full config passes', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      PORT: '8080',
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      GITHUB_WEBHOOK_SECRET: 'wh-secret',
      CLERK_SECRET_KEY: 'clerk-sk',
      CLERK_PUBLISHABLE_KEY: 'clerk-pk',
      WEBHOOK_BASE_URL: 'https://example.com',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(8080);
    }
  });
});
