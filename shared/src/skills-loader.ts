/**
 * Load verified runbooks from platform pgvector for brain prompts.
 * Filesystem skills/ is no longer used — all learning lives in RAG.
 */

import { log } from './http.js';
import { platformEnabled, ragGroundingEnabled } from './platform-client.js';

export interface SkillsMatchContext {
  mode?: string;
  namespace?: string;
  resourceName?: string;
  githubRepo?: string;
  errorSignature?: string;
  rootCause?: string;
  targetComponent?: string;
}

const CACHE_MS = 60_000;
let cached: { at: number; key: string; value: string } | null = null;

export function invalidateSkillsCache(): void {
  cached = null;
}

/** Map incident context → RAG metadata component filter. */
export function inferTargetComponent(ctx: SkillsMatchContext): string {
  if (ctx.targetComponent) return ctx.targetComponent;
  if (ctx.mode === 'ci-failure') return 'gitops';
  return 'compute';
}

/** Build embedding query text from planner context. */
export function buildSkillsQueryText(ctx: SkillsMatchContext): string {
  const parts: string[] = [];
  if (ctx.errorSignature) parts.push(ctx.errorSignature);
  if (ctx.rootCause) parts.push(ctx.rootCause.slice(0, 200));
  if (ctx.mode) parts.push(ctx.mode);
  if (ctx.githubRepo) parts.push(ctx.githubRepo);
  if (ctx.namespace && ctx.resourceName) parts.push(`${ctx.namespace}/${ctx.resourceName}`);
  else if (ctx.resourceName) parts.push(ctx.resourceName);
  return parts.filter(Boolean).join(' ').trim() || 'kubernetes remediation';
}

async function fetchRunbooksFromRag(
  ctx: SkillsMatchContext,
  maxChars: number
): Promise<string> {
  if (!platformEnabled() || !ragGroundingEnabled()) {
    return '';
  }

  const platformUrl = (process.env['SRE_PLATFORM_URL'] ?? process.env['PLATFORM_URL'] ?? '').replace(
    /\/$/,
    ''
  );
  if (!platformUrl) return '';

  const queryText = buildSkillsQueryText(ctx);
  const targetComponent = inferTargetComponent(ctx);
  const errorSignature = ctx.errorSignature ?? '';

  try {
    const res = await fetch(`${platformUrl}/rag/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_text: queryText,
        target_component: targetComponent,
        error_signature: errorSignature,
        top_k: parseInt(process.env['RAG_SKILLS_TOP_K'] ?? '3', 10),
        max_chars: maxChars,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      log('debug', 'skills-loader', 'RAG query failed', { status: res.status });
      return '';
    }
    const data = (await res.json()) as { combined_markdown?: string; found?: boolean };
    return data.found ? (data.combined_markdown ?? '').trim() : '';
  } catch (err) {
    log('debug', 'skills-loader', 'RAG query error', { error: String(err) });
    return '';
  }
}

export async function loadRankedSkills(
  ctx: SkillsMatchContext = {},
  maxChars = 4000
): Promise<string> {
  const cacheKey = JSON.stringify({ ctx, maxChars });
  const now = Date.now();
  if (cached && cached.key === cacheKey && now - cached.at < CACHE_MS) {
    return cached.value;
  }

  const combined = await fetchRunbooksFromRag(ctx, maxChars);
  cached = { at: now, key: cacheKey, value: combined };
  return combined;
}

export async function skillsSystemAppendix(ctx: SkillsMatchContext = {}): Promise<string> {
  const skills = await loadRankedSkills(ctx);
  if (!skills.trim()) return '';
  return `\n\nVerified runbooks from knowledge base (ranked for this incident):\n${skills}`;
}

/** @deprecated Filesystem skills removed — returns empty. */
export function loadSkillsPrompt(_maxChars = 4000): string {
  return '';
}
