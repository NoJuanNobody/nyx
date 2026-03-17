import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { ensureTemplates } from './db/seed-templates.js';
import { ensureLifecycles } from './db/seed-lifecycles.js';

const app = buildApp();

app.listen({ port: config.PORT, host: config.HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Seed built-in lifecycles and templates if missing (idempotent)
  ensureLifecycles().catch((e) => {
    app.log.warn(e, 'Failed to seed lifecycles — they can be added later via: pnpm db:seed-lifecycles');
  });
  ensureTemplates().catch((e) => {
    app.log.warn(e, 'Failed to seed lifecycle templates — they can be added later via: pnpm db:seed-templates');
  });
});
