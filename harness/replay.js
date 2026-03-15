#!/usr/bin/env node

/**
 * @module replay
 *
 * Re-run failed (or filtered) agent calls recorded in an NDJSON trace file.
 *
 * Usage:
 *   node harness/replay.js <trace-file> [options]
 *
 * Options:
 *   --filter <key>=<value>   Filter trace entries (e.g. --filter status=error).
 *                            Multiple --filter flags are ANDed together.
 *   --dry-run                Print entries that would be replayed without
 *                            actually invoking the agent function.
 *   --help                   Show this help text and exit.
 *
 * Output:
 *   Replay results are written to stdout as NDJSON. Each line contains the
 *   original trace id, the replayed input, the new output, duration, and
 *   status.
 *
 * Examples:
 *   # Replay all failed calls from today's trace
 *   node harness/replay.js traces/2026-03-15.ndjson --filter status=error
 *
 *   # Dry-run to inspect what would be replayed
 *   node harness/replay.js traces/2026-03-15.ndjson --filter status=error --dry-run
 *
 *   # Replay entries for a specific agent
 *   node harness/replay.js traces/2026-03-15.ndjson --filter agentName=spec-analyser
 *
 * Note:
 *   By default (without --filter), ALL entries in the trace file are selected.
 *   The replay invokes a stub function that echoes the input, since the
 *   original agent function reference is not serialised in the trace.  To
 *   replay against a real agent, import this module and call `replayEntries`
 *   programmatically, supplying your own agentFn.
 */

const fs = require("fs");
const path = require("path");

// ──────────────────────────────────────────────────────────────────────────────
// Help text
// ──────────────────────────────────────────────────────────────────────────────

const HELP = `
replay.js — Re-run agent calls from an NDJSON trace file.

USAGE
  node harness/replay.js <trace-file> [options]

OPTIONS
  --filter <key>=<value>   Filter trace entries. Repeatable; filters are ANDed.
                           Common filters:
                             --filter status=error
                             --filter agentName=my-agent
  --dry-run                Print matching entries without invoking the agent.
  --help                   Show this help text.

OUTPUT
  NDJSON lines to stdout with replay results.

EXAMPLES
  node harness/replay.js traces/2026-03-15.ndjson --filter status=error
  node harness/replay.js traces/2026-03-15.ndjson --dry-run
`.trim();

// ──────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse process.argv into a structured options object.
 *
 * @param {string[]} argv - Raw process arguments (process.argv.slice(2)).
 * @returns {{ traceFile: string|null, filters: Object<string,string>, dryRun: boolean, help: boolean }}
 */
function parseArgs(argv) {
  const result = {
    traceFile: null,
    filters: {},
    dryRun: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
      continue;
    }

    if (arg === "--dry-run") {
      result.dryRun = true;
      i++;
      continue;
    }

    if (arg === "--filter") {
      i++;
      const filterValue = argv[i];
      if (!filterValue || !filterValue.includes("=")) {
        console.error("Error: --filter requires a key=value argument.");
        process.exit(1);
      }
      const eqIndex = filterValue.indexOf("=");
      const key = filterValue.slice(0, eqIndex);
      const value = filterValue.slice(eqIndex + 1);
      result.filters[key] = value;
      i++;
      continue;
    }

    // Positional argument: trace file path.
    if (!result.traceFile) {
      result.traceFile = arg;
    }
    i++;
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Core logic
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Read and parse an NDJSON trace file.
 *
 * @param {string} filePath - Absolute or relative path to the .ndjson file.
 * @returns {object[]} Array of parsed trace entries.
 */
function readTraceFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: trace file not found: ${resolved}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(resolved, "utf-8").split("\n").filter(Boolean);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch {
      console.error(`Warning: skipping malformed JSON on line ${idx + 1}`);
      return null;
    }
  }).filter(Boolean);
}

/**
 * Apply filters to trace entries.
 *
 * @param {object[]} entries - Parsed trace entries.
 * @param {Object<string,string>} filters - Key-value pairs to match against
 *   top-level entry fields (string equality).
 * @returns {object[]} Matching entries.
 */
function applyFilters(entries, filters) {
  const filterKeys = Object.keys(filters);
  if (filterKeys.length === 0) return entries;

  return entries.filter((entry) =>
    filterKeys.every((key) => String(entry[key]) === filters[key])
  );
}

/**
 * Replay a list of trace entries.
 *
 * @param {object[]}  entries  - Trace entries to replay.
 * @param {Function}  agentFn  - The agent function to call with each entry's
 *   input. Defaults to an echo stub.
 * @param {object}    [options={}]
 * @param {boolean}   [options.dryRun=false] - If true, print entries without
 *   invoking the agent.
 * @returns {Promise<void>}
 */
async function replayEntries(entries, agentFn, options = {}) {
  const { dryRun = false } = options;

  for (const entry of entries) {
    if (dryRun) {
      const summary = {
        action: "dry-run",
        originalId: entry.id,
        agentName: entry.agentName,
        input: entry.input,
        originalStatus: entry.status,
        originalError: entry.error || null,
      };
      process.stdout.write(JSON.stringify(summary) + "\n");
      continue;
    }

    const start = Date.now();
    let status = "success";
    let output = undefined;
    let error = undefined;

    try {
      output = await agentFn(entry.input);
    } catch (err) {
      status = "error";
      error = {
        name: err.name || "Error",
        message: err.message || String(err),
      };
    }

    const result = {
      originalId: entry.id,
      agentName: entry.agentName,
      input: entry.input,
      output: status === "success" ? output : undefined,
      durationMs: Date.now() - start,
      status,
    };
    if (error) {
      result.error = error;
    }

    process.stdout.write(JSON.stringify(result) + "\n");
  }
}

/**
 * Default stub agent function used when replaying from the CLI. Since the
 * original function reference is not stored in the trace, this stub simply
 * echoes the input to demonstrate the replay flow.
 *
 * @param {*} input - The original agent input from the trace.
 * @returns {Promise<{replayed: boolean, input: *}>}
 */
async function stubAgent(input) {
  return { replayed: true, input };
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!opts.traceFile) {
    console.error("Error: please provide a trace file path.\n");
    console.log(HELP);
    process.exit(1);
  }

  const entries = readTraceFile(opts.traceFile);
  const filtered = applyFilters(entries, opts.filters);

  if (filtered.length === 0) {
    console.error("No matching trace entries found.");
    process.exit(0);
  }

  console.error(`Found ${filtered.length} matching trace entries.`);

  await replayEntries(filtered, stubAgent, { dryRun: opts.dryRun });
}

// Run when executed directly; export for programmatic use.
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { replayEntries, readTraceFile, applyFilters, parseArgs };
