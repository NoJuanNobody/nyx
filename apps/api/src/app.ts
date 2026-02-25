import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { documentRoutes } from './routes/documents.js';
import { versionRoutes } from './routes/versions.js';
import { teamRoutes } from './routes/teams.js';
import { integrationRoutes } from './routes/integrations.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true, credentials: true });
  app.register(cookie);

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(documentRoutes, { prefix: '/api/documents' });
  app.register(versionRoutes, { prefix: '/api/versions' });
  app.register(teamRoutes, { prefix: '/api/teams' });
  app.register(integrationRoutes, { prefix: '/api/integrations' });

  return app;
}
