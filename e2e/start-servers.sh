#!/bin/bash
# Start dev servers and wait for both to be ready
pnpm dev &
DEV_PID=$!

echo "[e2e] Waiting for Vite (5173) and API (3001)..."

# Wait for both servers
for i in $(seq 1 60); do
  VITE_OK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173 2>/dev/null || echo "000")
  API_OK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health 2>/dev/null || echo "000")

  if [ "$VITE_OK" != "000" ] && [ "$API_OK" != "000" ]; then
    echo "[e2e] Both servers ready (Vite: $VITE_OK, API: $API_OK)"
    wait $DEV_PID
    exit 0
  fi
  sleep 2
done

echo "[e2e] Timeout waiting for servers (Vite: $VITE_OK, API: $API_OK)"
kill $DEV_PID 2>/dev/null
exit 1
