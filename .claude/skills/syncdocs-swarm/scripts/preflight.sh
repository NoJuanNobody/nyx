#!/usr/bin/env bash
# preflight.sh — Validates the environment before spawning the swarm
# Run this before any worktrees are created.

set -e

PASS=0
FAIL=0

check() {
  local label="$1"
  local cmd="$2"
  if eval "$cmd" &>/dev/null; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "🔍 SyncDocs Swarm — Pre-flight checks"
echo "======================================="

# Git
check "Inside a git repository" "git rev-parse --git-dir"
check "Working tree is clean (no uncommitted changes)" "[ -z \"\$(git status --porcelain)\" ]"
check "On a valid branch (not detached HEAD)" "git symbolic-ref HEAD"
check "git worktree available" "git worktree list"

# GitHub CLI (optional but needed for PR step)
if command -v gh &>/dev/null; then
  echo "  ✅ GitHub CLI available"
  PASS=$((PASS + 1))
  check "GitHub CLI authenticated" "gh auth status"
else
  echo "  ⚠️  GitHub CLI not found — PR step will need manual intervention"
fi

# Test command detection
if [ -f package.json ]; then
  TEST_CMD=$(node -e "const p=require('./package.json'); const s=p.scripts||{}; console.log(s['test:unit']||s['test']||'')" 2>/dev/null)
  if [ -n "$TEST_CMD" ]; then
    echo "  ✅ Test command detected: $TEST_CMD"
    PASS=$((PASS + 1))
  else
    echo "  ⚠️  No test script found in package.json — you will be asked for a test command"
  fi
fi

# Aegis governance
AEGIS_DIR="$(git rev-parse --show-toplevel)/.agentpolicy"
if [ -d "$AEGIS_DIR" ] && [ -n "$(ls -A "$AEGIS_DIR")" ]; then
  echo "  ✅ Aegis governance rules found: .agentpolicy/"
  PASS=$((PASS + 1))
else
  echo "  ❌ .agentpolicy/ not found or empty — agents require this directory"
  FAIL=$((FAIL + 1))
fi

# Worktree parent directory writable
PARENT_DIR="$(git rev-parse --show-toplevel)/../worktrees"
if mkdir -p "$PARENT_DIR" 2>/dev/null; then
  echo "  ✅ Worktree directory writable: $PARENT_DIR"
  rmdir "$PARENT_DIR" 2>/dev/null || true
  PASS=$((PASS + 1))
else
  echo "  ❌ Cannot create worktree directory at $PARENT_DIR"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "⚠️  Fix the above issues before proceeding."
  exit 1
else
  echo ""
  echo "✅ All checks passed. Ready to swarm."
  exit 0
fi
