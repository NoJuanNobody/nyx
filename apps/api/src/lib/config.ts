import { z } from 'zod';
import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV || 'development';
const isDevelopment = nodeEnv !== 'production';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ANTHROPIC_API_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
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
  DATABASE_URL: process.env.DATABASE_URL || (isDevelopment ? 'postgresql://postgres:postgres@localhost:5432/syncdocs' : undefined),
};

export const config = envSchema.parse(envWithDefaults);
export type Config = z.infer<typeof envSchema>;
