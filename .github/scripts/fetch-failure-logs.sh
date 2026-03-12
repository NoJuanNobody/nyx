#!/usr/bin/env bash
# fetch-failure-logs.sh
# Fetches logs from a failed GitHub Actions workflow run and extracts the
# relevant failure output. Saves to /tmp/failure-logs.txt
set -euo pipefail

MAX_LOG_CHARS=20000   # Trim to keep within Claude's context budget

echo "📥 Fetching jobs for workflow run $RUN_ID..."

# ── Get all jobs for the failed run ─────────────────────────────────────────
JOBS=$(gh api \
  "/repos/$REPO/actions/runs/$RUN_ID/jobs" \
  --jq '.jobs[] | {id: .id, name: .name, conclusion: .conclusion, steps: [.steps[] | select(.conclusion == "failure") | .name]}')

echo "Jobs response received."

# ── Collect logs from every failed job ──────────────────────────────────────
ALL_LOGS=""

while IFS= read -r JOB; do
  JOB_ID=$(echo "$JOB" | jq -r '.id')
  JOB_NAME=$(echo "$JOB" | jq -r '.name')
  JOB_CONCLUSION=$(echo "$JOB" | jq -r '.conclusion')

  if [ "$JOB_CONCLUSION" = "failure" ]; then
    echo "  🔍 Fetching logs for failed job: $JOB_NAME (ID: $JOB_ID)"

    # Download the raw log (plain text)
    JOB_LOG=$(gh api "/repos/$REPO/actions/jobs/$JOB_ID/logs" 2>/dev/null || echo "[Log unavailable for job $JOB_ID]")

    # Extract the most relevant section: lines around ERROR / FAIL / assert
    RELEVANT=$(echo "$JOB_LOG" | grep -A 20 -B 5 -iE \
      "(Error|FAIL|AssertionError|TimeoutError|Cannot find|Unhandled|expect\(|✗|✕|×)" \
      2>/dev/null | head -200 || echo "$JOB_LOG" | tail -200)

    ALL_LOGS+="
=== FAILED JOB: $JOB_NAME ===
$RELEVANT

"
  fi
done < <(echo "$JOBS" | jq -c '.')

# ── Trim to max size so we don't blow Claude's context ───────────────────────
TRIMMED=$(echo "$ALL_LOGS" | head -c $MAX_LOG_CHARS)

if [ -z "$TRIMMED" ]; then
  TRIMMED="[No failure logs could be retrieved. Check the Actions run directly: https://github.com/$REPO/actions/runs/$RUN_ID]"
fi

echo "$TRIMMED" > /tmp/failure-logs.txt

LINE_COUNT=$(wc -l < /tmp/failure-logs.txt)
echo "✅ Saved $LINE_COUNT lines of failure logs to /tmp/failure-logs.txt"
cat /tmp/failure-logs.txt
