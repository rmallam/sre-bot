// ─────────────────────────────────────────────────────────────────────────────
// src/auth.ts — Fixes Issue #7: No authentication on commander-agent
//
// Loads an allowlist of authorized user IDs from the ALLOWED_USERS env var
// (comma-separated). Exports isAuthorized() used by all platform adapters.
// ─────────────────────────────────────────────────────────────────────────────

import { log } from '../../../shared/src/http.js';

const AGENT = 'commander-agent';

/**
 * Build the allowed-user set once at startup from the env var.
 * If ALLOWED_USERS is not set, the set is empty and every request is blocked
 * (fail-closed by default for security).
 */
function buildAllowList(): Set<string> {
  const raw = process.env['ALLOWED_USERS'] ?? '';
  if (!raw.trim()) {
    log('warn', AGENT, 'ALLOWED_USERS env var is empty — all users will be denied', {
      incidentId: 'N/A',
    });
    return new Set();
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  log('info', AGENT, `Allowlist loaded with ${ids.length} user(s)`, { incidentId: 'N/A' });
  return new Set(ids);
}

const ALLOWED: Set<string> = buildAllowList();

/**
 * Returns true if the userId is in the allowlist.
 * Logs a warning (at WARN level) for every rejected attempt.
 */
export function isAuthorized(userId: string, platform: string): boolean {
  if (ALLOWED.has(userId)) {
    return true;
  }

  log('warn', AGENT, 'Unauthorized attempt blocked', {
    incidentId: 'N/A',
    action: 'unauthorized_attempt',
    userId,
    platform,
  });
  return false;
}
