/**
 * Security audit events — v1 logs JSON; v2 can POST to SIEM_ENDPOINT.
 */

import type { SecurityAuditEvent } from './types.js';
import { log } from './http.js';

const SIEM_ENDPOINT = process.env['SIEM_ENDPOINT'] ?? '';

export async function emitSecurityAudit(event: SecurityAuditEvent): Promise<void> {
  log('info', 'audit-siem', event.eventType, {
    ...event,
  });

  if (!SIEM_ENDPOINT) return;

  try {
    await fetch(SIEM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    log('warn', 'audit-siem', 'Failed to forward audit event to SIEM', {
      error: String(err),
      eventType: event.eventType,
    });
  }
}
