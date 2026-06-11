/**
 * Outbound fetch to other sre-bot agents — attaches SRE_INTERNAL_TOKEN when configured.
 */

import { withInternalAuth } from '../../../shared/src/internal-auth.js';

export function agentFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(url, withInternalAuth(init));
}
