---
name: dev
description: Kill any old dev server processes and start the app.
---

# Dev Server

Kill any old dev server processes and start the app.

## Steps

1. Kill any processes on ports 5173, 3000, 3001:
   ```bash
   lsof -ti:5173,3000,3001 2>/dev/null | xargs kill -9 2>/dev/null
   ```

2. Start the dev server in the background:
   ```bash
   pnpm dev
   ```
