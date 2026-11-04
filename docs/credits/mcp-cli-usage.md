# Credit metering via MCP and CLI (AI-57)

Credits are agent-native utility tokens: metered and spent by external agents, never sold. There is no purchase, checkout, pack or plan surface in the MCP server or CLI. Ledger rules: `docs/credits/utility-tokens-spec.md`.

## HTTP contract the clients assume (implemented by AI-58 in `apps/api/src/routes/credits.ts`)

| Call | Body (camelCase) |
|---|---|
| `GET /api/credits/balance?agentId=` | - |
| `POST /api/credits/reserve` | `idempotencyKey, agentId, amount, taskType?, ttlMs?, memo?` -> `{ reservationId, ... }` |
| `POST /api/credits/commit` | `idempotencyKey, reservationId, actualAmount, memo?` |
| `POST /api/credits/release` | `idempotencyKey, reservationId, memo?` |
| `POST /api/credits/spend` | `idempotencyKey, agentId, amount, taskType?, memo?` (reserve + commit) |

Every POST also sends an `Idempotency-Key` header equal to the body key. Retrying with the same key and payload returns the original result (`replayed`); a different payload gives `IDEMPOTENCY_CONFLICT`. Errors are JSON, e.g. `{"error":"insufficient_credits","available":1,"required":5}`. If AI-58 picks different paths or field names, only `packages/mcp-server/src/credits.ts` and `packages/cli/src/commands/credits.ts` need adjusting.

## MCP tools (`@nyx/mcp-server`)

Validated with zod; snake_case arguments. `agent_id` defaults to `NYX_AGENT_ID`, then `default`. `idempotency_key` is required on every mutation (use your tool-call id).

| Tool | Arguments |
|---|---|
| `nyx_credits_balance` | `agent_id?` |
| `nyx_credits_reserve` | `idempotency_key, amount, agent_id?, task_type?, ttl_ms?, memo?` |
| `nyx_credits_commit` | `idempotency_key, reservation_id, actual_amount (<= reserved), memo?` |
| `nyx_credits_release` | `idempotency_key, reservation_id, memo?` |
| `nyx_credits_spend` | `idempotency_key, amount, agent_id?, task_type?, memo?` |

Pattern: `reserve(max)` -> do the work -> `commit(actual)` on success or `release` on failure. Exhaustion returns an error containing `insufficient_credits` with `available` and `required`; stop or ask the human.

## CLI (`nyx credits`)

```
nyx credits balance [--agent <id>] [--json]
nyx credits reserve <amount> [--agent] [--task-type] [--ttl-ms] [--memo] [--idempotency-key] [--json]
nyx credits commit <reservationId> <actual> [--memo] [--idempotency-key] [--json]
nyx credits release <reservationId> [--memo] [--idempotency-key] [--json]
nyx credits spend <amount> [--agent] [--task-type] [--memo] [--idempotency-key] [--json]
nyx credits usage | history      # cost table / ledger history (--format json)
```

The idempotency key is generated per invocation unless `--idempotency-key` is given; pass your own to make a retried command safe. With `--json`, success prints the API response and failure prints the API error body as JSON on stdout and exits 1. Auth uses `NYX_API_KEY` / `NYX_API_URL` (or `~/.nyx/config.json`).
