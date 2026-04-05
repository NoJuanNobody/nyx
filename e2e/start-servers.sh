#!/bin/bash
# Start dev servers and wait for both to be ready
pnpm dev &
DEV_PID=$!

echo "[e2e] Waiting for Vite (5173) and API (3001)..."

for i in $(seq 1 90); do
  VITE_OK=false
  API_OK=false

  # Use curl -sf (silent + fail) — exit code 0 means success
  if curl -sf http://localhost:5173 > /dev/null 2>&1; then
    VITE_OK=true
  fi

  if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    API_OK=true
  fi

  if [ "$VITE_OK" = "true" ] && [ "$API_OK" = "true" ]; then
    echo "[e2e] Both servers ready!"
    # Keep the process running so Playwright doesn't kill it
    wait $DEV_PID
    exit 0
  fi

  echo "[e2e] Waiting... (Vite: $VITE_OK, API: $API_OK) [$i/90]"
  sleep 2
done

echo "[e2e] ERROR: Timeout waiting for servers after 180s"
kill $DEV_PID 2>/dev/null
exit 1
