/**
 * Shared timeout/retry/circuit-breaker helper for external data-provider API
 * calls (Apollo, People Data Labs). Kept intentionally simple and
 * in-process — this codebase has no job queue/Redis, so per-process state is
 * consistent with every other worker here (see services/*Runner.js).
 */
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const CIRCUIT_OPEN_MS = 60000;
const CIRCUIT_FAILURE_THRESHOLD = 5;

const circuits = new Map();

function circuitFor(key) {
  if (!circuits.has(key)) circuits.set(key, { failures: 0, openUntil: 0 });
  return circuits.get(key);
}

function isCircuitOpen(key) {
  const circuit = circuitFor(key);
  return circuit.openUntil > Date.now();
}

function recordSuccess(key) {
  const circuit = circuitFor(key);
  circuit.failures = 0;
  circuit.openUntil = 0;
}

function recordFailure(key) {
  const circuit = circuitFor(key);
  circuit.failures += 1;
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
}

function resetCircuits() { circuits.clear(); }

function isRetryable(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  return status === 429 || status >= 500 || ["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "ECONNREFUSED"].includes(error?.code);
}

/**
 * Run `fn` with a shared circuit breaker (keyed per provider), retrying
 * retryable failures with jittered exponential backoff, up to `maxRetries`.
 * Throws a normalized error with `.category` set for callers to log/report.
 */
async function withResilience(circuitKey, fn, { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = 500 } = {}) {
  if (isCircuitOpen(circuitKey)) {
    const error = new Error(`${circuitKey} is temporarily unavailable after repeated failures`);
    error.category = "circuit_open";
    throw error;
  }
  let attempt = 0;
  for (;;) {
    try {
      const result = await fn();
      recordSuccess(circuitKey);
      return result;
    } catch (error) {
      attempt += 1;
      const retryable = isRetryable(error);
      if (!retryable || attempt > maxRetries) {
        recordFailure(circuitKey);
        if (!error.category) {
          const status = Number(error?.response?.status || error?.status || 0);
          error.category = status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status >= 500 ? "provider" : /timeout|abort/i.test(String(error?.code || "")) ? "timeout" : status >= 400 ? "request" : "unknown";
        }
        throw error;
      }
      const delay = Math.round(baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, isCircuitOpen, isRetryable, recordFailure, recordSuccess, resetCircuits, withResilience };
