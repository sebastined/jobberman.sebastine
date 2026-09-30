// Safe reading of third-party HTTP responses: bounded (never buffer an unbounded body into memory), always released,
// and time-limited. Every upstream this Worker calls is outside our control.

export const FETCH_TIMEOUT_MS = 15_000;

/** A fetch that gives up instead of hanging (a stuck connection would otherwise stall the whole run). */
export function timedFetch(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Release a response whose body we don't need, so the connection is freed right away. */
export async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

/**
 * Read a body as text, streaming and stopping at `maxBytes`. Returns null when the body is larger and `truncate`
 * is false (a cut-off JSON/XML document is useless); with `truncate` the first `maxBytes` are returned instead.
 */
export async function readText(res: Response, maxBytes: number, truncate = false): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      if (!truncate) return null;
      return text + decoder.decode(value.subarray(0, value.byteLength - (total - maxBytes)));
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Parse a bounded JSON body. Third-party JSON is deliberately typed `any` at this one boundary: callers read it
 * defensively (optional chaining, Array.isArray, String()/Number() coercion) rather than trusting its shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(res: Response, maxBytes: number): Promise<any | null> {
  const text = await readText(res, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
