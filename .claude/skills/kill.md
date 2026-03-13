# Kill App

Kill any running dev server processes.

## Steps

1. Kill processes on ports 5173, 3000, 3001:
   ```bash
   lsof -ti:5173,3000,3001 2>/dev/null | xargs kill -9 2>/dev/null
   ```

2. Confirm they're dead:
   ```bash
   lsof -ti:5173,3000,3001 2>/dev/null || echo "All processes stopped"
   ```
