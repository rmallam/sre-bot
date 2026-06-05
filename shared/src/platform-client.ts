/**
 * HTTP client for the Python platform-agent (semantic router + RAG).
 */

import { log } from './http.js';

const PLATFORM_URL = (process.env['SRE_PLATFORM_URL'] ?? process.env['PLATFORM_URL'] ?? '').replace(
  /\/$/,
  ''
);
const PLATFORM_ROUTING = (process.env['SRE_PLATFORM_ROUTING'] ?? 'true').toLowerCase() === 'true';
const RAG_GROUNDING = (process.env['SRE_RAG_GROUNDING'] ?? 'true').toLowerCase() === 'true';
const RAG_LEARNING = (process.env['SRE_RAG_LEARNING'] ?? 'true').toLowerCase() === 'true';

export function platformEnabled(): boolean {
  return Boolean(PLATFORM_URL);
}

export function platformRoutingEnabled(): boolean {
  return platformEnabled() && PLATFORM_ROUTING;
}

export function ragGroundingEnabled(): boolean {
  return platformEnabled() && RAG_GROUNDING;
}

export function ragLearningEnabled(): boolean {
  return platformEnabled() && RAG_LEARNING;
}

export interface PlatformRouteResult {
  intent: 'chitchat' | 'diagnose' | 'remediate' | 'default';
  routeName: string | null;
  similarityScore: number;
  usedFallback: boolean;
}

export interface PlatformRagResult {
  playbookMarkdown: string;
  errorSignature: string;
  targetComponent: string;
  similarity: number;
  found: boolean;
}

export interface PlatformRagLearnResult {
  upserted: boolean;
  runbookId: string | null;
  provenCount: number;
  errorSignature: string;
  targetComponent: string;
}

async function postJson<T>(path: string, body: unknown, incidentId: string): Promise<T | null> {
  if (!PLATFORM_URL) return null;
  const url = `${PLATFORM_URL}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log('warn', 'platform-client', `POST ${path} failed`, {
        incidentId,
        status: res.status,
        body: text.slice(0, 200),
      });
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log('warn', 'platform-client', `POST ${path} error`, { incidentId, error: String(err) });
    return null;
  }
}

export async function platformRouteMessage(
  text: string,
  incidentId: string
): Promise<PlatformRouteResult | null> {
  const data = await postJson<{
    intent: string;
    route_name?: string | null;
    similarity_score?: number;
    used_fallback?: boolean;
  }>('/route', { text }, incidentId);
  if (!data) return null;
  const intent = data.intent as PlatformRouteResult['intent'];
  return {
    intent,
    routeName: data.route_name ?? null,
    similarityScore: data.similarity_score ?? 0,
    usedFallback: Boolean(data.used_fallback),
  };
}

export async function platformRagGround(opts: {
  detectedError: string;
  targetComponent: string;
  targetWorkload?: string;
  queryText?: string;
  incidentId: string;
}): Promise<PlatformRagResult | null> {
  const data = await postJson<{
    playbook_markdown?: string;
    error_signature?: string;
    target_component?: string;
    similarity?: number;
    found?: boolean;
  }>(
    '/rag/ground',
    {
      detected_error: opts.detectedError,
      target_component: opts.targetComponent,
      target_workload: opts.targetWorkload ?? '',
      query_text: opts.queryText ?? '',
    },
    opts.incidentId
  );
  if (!data) return null;
  return {
    playbookMarkdown: data.playbook_markdown ?? '',
    errorSignature: data.error_signature ?? opts.detectedError,
    targetComponent: data.target_component ?? opts.targetComponent,
    similarity: data.similarity ?? 0,
    found: Boolean(data.found),
  };
}

export async function platformRagLearn(opts: {
  errorSignature: string;
  targetComponent: string;
  playbookMarkdown: string;
  runId: string;
  incidentId: string;
}): Promise<PlatformRagLearnResult | null> {
  if (!ragLearningEnabled()) return null;
  const data = await postJson<{
    upserted?: boolean;
    runbook_id?: string | null;
    proven_count?: number;
    error_signature?: string;
    target_component?: string;
  }>(
    '/rag/learn',
    {
      error_signature: opts.errorSignature,
      target_component: opts.targetComponent,
      playbook_markdown: opts.playbookMarkdown,
      run_id: opts.runId,
      incident_id: opts.incidentId,
    },
    opts.incidentId
  );
  if (!data) return null;
  return {
    upserted: Boolean(data.upserted),
    runbookId: data.runbook_id ?? null,
    provenCount: data.proven_count ?? 0,
    errorSignature: data.error_signature ?? opts.errorSignature,
    targetComponent: data.target_component ?? opts.targetComponent,
  };
}

export async function platformHealth(): Promise<Record<string, unknown> | null> {
  if (!PLATFORM_URL) return null;
  try {
    const res = await fetch(`${PLATFORM_URL}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
