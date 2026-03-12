/**
 * Test Fastify app harness.
 */
import { buildApp } from '../../app.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = buildApp();
  await app.ready();
  return app;
}

/**
 * Inject a request as a specific user.
 * Attaches a Bearer token header so the auth middleware resolves the user.
 */
export async function injectAs(
  app: FastifyInstance,
  user: { id: string; email: string; name: string; role: string },
  method: InjectOptions['method'],
  url: string,
  body?: unknown,
) {
  const opts: InjectOptions = {
    method,
    url,
    headers: {
      authorization: 'Bearer test-jwt-token',
    },
  };

  if (body !== undefined) {
    opts.payload = body as InjectOptions['payload'];
    opts.headers = {
      ...opts.headers,
      'content-type': 'application/json',
    };
  }

  return app.inject(opts);
}
