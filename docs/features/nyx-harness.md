# Nyx Harness

The Nyx Harness provides deterministic testing, agent quality tracking, and faster debugging during the MVP push. It consists of three core components: Sync Fixtures, an Agent Observability Wrapper, and a Replay Script.

---

## 1. Sync Fixtures

Fixture files live in `/fixtures/sync/` and represent known sync states used to drive deterministic tests without requiring a live GitHub connection or running AI pipeline.

### 1.1 Fixture Files

| File | Purpose |
|---|---|
| `baseline.json` | Clean state — document and code are in sync, no drift |
| `conflicted.json` | A document section and its corresponding code have diverged |
| `edge-case.json` | A real-world edge case with populated sync metadata (e.g. partial match, renamed files) |

### 1.2 Fixture Schema

Each fixture follows this shape:

```json
{
  "id": "fixture-id",
  "description": "Human-readable description of the sync state",
  "document": {
    "id": "doc-uuid",
    "title": "Document title",
    "sections": [
      {
        "id": "section-id",
        "heading": "Section heading",
        "content": "Section content text"
      }
    ]
  },
  "codeSnapshot": {
    "repoOwner": "org",
    "repoName": "repo",
    "ref": "main",
    "files": [
      {
        "path": "src/example.ts",
        "content": "// file content"
      }
    ]
  },
  "syncMetadata": {
    "status": "in_sync | conflicted | edge_case",
    "driftedSections": [],
    "lastCheckedAt": "2026-03-15T00:00:00Z"
  }
}
```

### 1.3 Usage

Import fixtures in Vitest unit tests or Playwright E2E fixtures to avoid live API calls:

```ts
import baseline from '@/fixtures/sync/baseline.json';
import conflicted from '@/fixtures/sync/conflicted.json';
import edgeCase from '@/fixtures/sync/edge-case.json';
```

---

## 2. Agent Observability Wrapper

`harness/agentWrapper.js` wraps every AI agent call to capture inputs, outputs, and errors for quality tracking and post-hoc debugging.

### 2.1 Responsibilities

- Assign each call a unique trace ID
- Record a timestamp, agent name, input payload, output payload, and error status
- Write each trace entry as a newline-delimited JSON record to `/traces/YYYY-MM-DD.ndjson`
- Expose a summary utility that groups traces by agent name and reports call counts, error rates, and average latency

### 2.2 Trace Record Schema

Each line in the `.ndjson` file is a JSON object:

```json
{
  "traceId": "uuid-v4",
  "timestamp": "2026-03-15T12:34:56.789Z",
  "agentName": "drift-detector",
  "input": { ... },
  "output": { ... },
  "error": null,
  "durationMs": 412
}
```

`error` is `null` on success, or a string message on failure.

### 2.3 API

```js
import { wrapAgent, summarizeTraces } from './harness/agentWrapper.js';

// Wrap any async agent function
const safeDriftDetect = wrapAgent('drift-detector', driftDetectFn);

// Call it like the original
const result = await safeDriftDetect(input);

// Summarize today's traces
const report = await summarizeTraces(); // reads today's .ndjson file
// {
//   'drift-detector': { calls: 12, errors: 1, avgMs: 380 },
//   'spec-writer':    { calls: 5,  errors: 0, avgMs: 720 }
// }
```

### 2.4 Trace File Location

```
/traces/
  2026-03-15.ndjson
  2026-03-14.ndjson
  ...
```

Files are rotated daily by date. The directory is `.gitignored` — traces are local artifacts and are not committed.

---

## 3. Replay Script

`harness/replay.js` reads the most recent failed trace from `/traces`, re-runs the agent call with the same input, and logs the new output for comparison.

### 3.1 Responsibilities

- Find the most recent `.ndjson` file in `/traces/`
- Scan for the last entry where `error !== null`
- Extract the `agentName` and `input` from that entry
- Re-invoke the corresponding agent function with the same input
- Print a side-by-side comparison of the original output (or error) and the new result

### 3.2 Usage

```bash
node harness/replay.js
# or with a specific trace file:
node harness/replay.js --file traces/2026-03-14.ndjson
# or targeting a specific trace ID:
node harness/replay.js --traceId <uuid>
```

### 3.3 Output Format

```
Replaying failed trace
  traceId:   <uuid>
  agent:     drift-detector
  timestamp: 2026-03-15T11:22:00Z

--- Original error ---
"Timeout: GitHub API did not respond within 10s"

--- Replay result ---
{ driftedSections: ['Auth'], confidence: 0.87 }

Status: RECOVERED
```

Status is `RECOVERED` if the replay succeeds, `STILL_FAILING` if the same or different error occurs.

---

## 4. File Layout

```
harness/
  agentWrapper.js     # Observability wrapper and summary utility
  replay.js           # Replay script for failed traces

fixtures/
  sync/
    baseline.json     # In-sync state
    conflicted.json   # Doc/code divergence
    edge-case.json    # Edge case with sync metadata

traces/               # Runtime output, gitignored
  YYYY-MM-DD.ndjson
```

---

## 5. Testing

### 5.1 Unit Tests (Vitest)

| Test | What it covers |
|---|---|
| `agentWrapper.test.js` | Successful call writes correct trace; failed call writes error entry; `summarizeTraces` aggregates correctly |
| `replay.test.js` | Finds latest failed trace; re-runs agent; outputs comparison |
| Fixture shape tests | Each fixture validates against the fixture schema |

### 5.2 E2E Integration

E2E tests that exercise the drift-detection pipeline should use the `conflicted.json` fixture to avoid hitting the live GitHub API. Inject it via the `mockAI` fixture already present in `e2e/fixtures/test-base.ts`.

---

## 6. CI Considerations

- `/traces/` must be listed in `.gitignore` — never commit trace files
- The `agentWrapper` must be a no-op passthrough when `process.env.NODE_ENV === 'test'` and tracing is disabled, so unit tests don't write disk artifacts unless explicitly opted in
- Replay script is a local dev tool — it is not invoked in CI
