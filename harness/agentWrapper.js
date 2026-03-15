/**
 * @module agentWrapper
 *
 * Wraps AI/agent functions to intercept and log every call to NDJSON trace
 * files. Each invocation is recorded with its input, output, duration, and
 * status so that failures can later be replayed via `harness/replay.js`.
 *
 * Uses only Node.js built-in modules (fs, path, crypto).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** @type {string} Root directory for trace output. */
const TRACES_DIR = path.resolve(__dirname, "..", "traces");

/**
 * Return the path to today's NDJSON trace file.
 * @returns {string} Absolute path, e.g. `traces/2026-03-15.ndjson`
 */
function traceFilePath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(TRACES_DIR, `${date}.ndjson`);
}

/**
 * Ensure the traces directory exists (created synchronously on first call).
 */
function ensureTracesDir() {
  if (!fs.existsSync(TRACES_DIR)) {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
  }
}

/**
 * Append a single trace entry to the current day's NDJSON file.
 * @param {object} entry - The trace record to persist.
 */
function appendTrace(entry) {
  ensureTracesDir();
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(traceFilePath(), line, "utf-8");
}

/**
 * Wrap an agent function so that every call is traced.
 *
 * The wrapper preserves the original function's return value (or thrown error)
 * and is fully transparent to the caller.
 *
 * @param {Function} agentFn - The async (or sync) function to wrap.
 * @param {object}   [options={}]
 * @param {string}   [options.agentName="unnamed"] - Human-readable label for
 *   this agent, written into every trace entry.
 * @returns {Function} A new function with the same signature that logs traces.
 *
 * @example
 * const { wrapAgent } = require("./harness/agentWrapper");
 *
 * async function analyseSpec(input) {
 *   // call Claude API ...
 *   return { score: 0.92 };
 * }
 *
 * const traced = wrapAgent(analyseSpec, { agentName: "spec-analyser" });
 * const result = await traced({ docId: "doc_123" });
 * // result is exactly what analyseSpec returned;
 * // a trace line has been appended to traces/YYYY-MM-DD.ndjson
 */
function wrapAgent(agentFn, options = {}) {
  const agentName = options.agentName || "unnamed";

  /**
   * Wrapped agent function.  Accepts the same arguments as the original and
   * returns the same value.  A trace entry is written regardless of whether
   * the call succeeds or throws.
   *
   * @param {...*} args - Arguments forwarded to the wrapped agent function.
   * @returns {Promise<*>} The original return value.
   */
  async function wrappedAgent(...args) {
    const id = crypto.randomUUID();
    const start = Date.now();
    const input = args.length === 1 ? args[0] : args;

    /** @type {"success"|"error"} */
    let status = "success";
    let output = undefined;
    let error = undefined;

    try {
      output = await agentFn(...args);
      return output;
    } catch (err) {
      status = "error";
      error = {
        name: err.name || "Error",
        message: err.message || String(err),
        stack: err.stack || undefined,
      };
      throw err;
    } finally {
      const entry = {
        id,
        timestamp: new Date().toISOString(),
        agentName,
        input,
        output: status === "success" ? output : undefined,
        durationMs: Date.now() - start,
        status,
      };
      if (error) {
        entry.error = error;
      }
      try {
        appendTrace(entry);
      } catch (_writeErr) {
        // Silently swallow write errors so the agent call itself is not
        // disrupted.  In production you would pipe this to stderr.
        // eslint-disable-next-line no-console
        console.error("[agentWrapper] failed to write trace:", _writeErr.message);
      }
    }
  }

  // Preserve the original function name for debugging.
  Object.defineProperty(wrappedAgent, "name", {
    value: `traced(${agentFn.name || agentName})`,
  });

  return wrappedAgent;
}

module.exports = { wrapAgent, traceFilePath, TRACES_DIR };
