import { buildApp } from './app.js';
import { config } from './lib/config.js';

const app = buildApp();

app.listen({ port: config.PORT, host: config.HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
