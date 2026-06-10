import { internalAuthHeaders } from './internal-auth.js';

/**
 * Shared resilient HTTP client used by all agents.
 *
 * Fixes Issue #2: HTTP webhooks have no retry / no queue.
 *
 * Features:
 *  - Exponential backoff with jitter
 *  - Configurable max attempts
 *  - Structured error logging with incidentId
 */

export interface PostOptions {
  url: string;
  payload: unknown;
  incidentId: string;
  callerAgent: string;
  maxAttempts?: number;
  initialDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function postWithRetry(opts: PostOptions): Promise<void> {
  const {
    url,
    payload,
    incidentId,
    callerAgent,
    maxAttempts = 5,
    initialDelayMs = 500,
  } = opts;

  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        console.log(
          JSON.stringify({
            level: 'info',
            incidentId,
            agent: callerAgent,
            msg: `POST OK`,
            url,
            attempt,
          })
        );
        return;
      }

      const body = await res.text().catch(() => '');
      console.error(
        JSON.stringify({
          level: 'warn',
          incidentId,
          agent: callerAgent,
          msg: `POST non-2xx (attempt ${attempt}/${maxAttempts})`,
          url,
          status: res.status,
          body,
        })
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          incidentId,
          agent: callerAgent,
          msg: `POST error (attempt ${attempt}/${maxAttempts})`,
          url,
          error: String(err),
        })
      );
    }

    if (attempt < maxAttempts) {
      // Exponential backoff with full jitter
      const delay =
        initialDelayMs * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
      console.log(
        JSON.stringify({
          level: 'info',
          incidentId,
          agent: callerAgent,
          msg: `Retrying in ${Math.round(delay)}ms`,
          url,
          nextAttempt: attempt + 1,
        })
      );
      await sleep(delay);
    }
  }

  // Dead-letter: log but do not crash the calling agent
  console.error(
    JSON.stringify({
      level: 'error',
      incidentId,
      agent: callerAgent,
      msg: `DEAD LETTER: All ${maxAttempts} attempts to POST failed`,
      url,
      payload,
    })
  );
}

/** Turn `TypeError: fetch failed` into a actionable message (host, ECONNREFUSED, etc.). */
export function formatFetchError(err: unknown, url: string): Error {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  const code =
    err instanceof Error && err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? String((err.cause as { code?: string }).code)
      : undefined;
  const parts = [`Request to ${url} failed: ${base}`];
  if (code) parts.push(`code=${code}`);
  if (cause && cause !== base) parts.push(`cause=${cause}`);
  return new Error(parts.join('; '));
}

/**
 * Structured JSON logger used by all agents.
 */
export function log(
  level: 'info' | 'warn' | 'error' | 'debug',
  agent: string,
  msg: string,
  extra?: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      level,
      agent,
      msg,
      timestamp: new Date().toISOString(),
      ...extra,
    })
  );
}
