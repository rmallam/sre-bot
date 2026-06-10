/**
 * Execute RAG playbook verification steps (HTTP + PromQL).
 */

import {
  evaluateNumericExpectation,
  parsePlaybookVerifySteps,
  substituteVerifyTemplate,
  summarizePlaybookVerifyResults,
  type PlaybookVerifyCheckResult,
  type PlaybookVerifyContext,
  type PlaybookVerifyStep,
} from '../../../shared/src/playbook-verify.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator-playbook-verify';
const PROMETHEUS_URL = process.env['PROMETHEUS_URL'] ?? '';

async function promInstantScalar(query: string): Promise<number | null> {
  if (!PROMETHEUS_URL) return null;
  const url = `${PROMETHEUS_URL.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    data?: { result?: Array<{ value?: [number, string] }> };
  };
  const val = data.data?.result?.[0]?.value?.[1];
  if (val == null) return null;
  const num = parseFloat(val);
  return Number.isFinite(num) ? num : null;
}

function isInternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return false;
    if (host.endsWith('.svc') || host.endsWith('.svc.cluster.local')) return true;
    if (host.endsWith('.cluster.local')) return true;
    const allow = (process.env['PLAYBOOK_VERIFY_URL_ALLOWLIST'] ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return allow.some((a) => host === a || host.endsWith(`.${a}`));
  } catch {
    return false;
  }
}

async function runHttpStep(
  step: Extract<PlaybookVerifyStep, { type: 'http' }>,
  ctx: PlaybookVerifyContext
): Promise<PlaybookVerifyCheckResult> {
  const url = substituteVerifyTemplate(step.url, ctx);
  if (!isInternalUrl(url)) {
    return {
      step,
      passed: false,
      detail: `HTTP check blocked (non-internal URL): ${url}`,
    };
  }
  try {
    const res = await fetch(url, {
      method: step.method,
      signal: AbortSignal.timeout(step.timeoutSec * 1000),
    });
    const passed = res.status === step.expectStatus;
    return {
      step,
      passed,
      detail: passed
        ? `HTTP ${step.method} ${url} → ${res.status}`
        : `HTTP ${step.method} ${url} → ${res.status}, expected ${step.expectStatus}`,
    };
  } catch (err) {
    return { step, passed: false, detail: `HTTP ${url} failed: ${String(err)}` };
  }
}

async function runPromqlStep(
  step: Extract<PlaybookVerifyStep, { type: 'promql' }>,
  ctx: PlaybookVerifyContext
): Promise<PlaybookVerifyCheckResult> {
  const query = substituteVerifyTemplate(step.query, ctx);
  const expect = substituteVerifyTemplate(step.expect, ctx);
  if (!PROMETHEUS_URL) {
    return { step, passed: false, detail: 'Prometheus URL not configured' };
  }
  const value = await promInstantScalar(query);
  if (value == null) {
    return { step, passed: false, detail: `PromQL returned no scalar: ${query}` };
  }
  const passed = evaluateNumericExpectation(value, expect);
  return {
    step,
    passed,
    detail: passed
      ? `PromQL ${query} = ${value} (expect ${expect})`
      : `PromQL ${query} = ${value}, expected ${expect}`,
  };
}

export async function runPlaybookVerifySteps(
  markdown: string,
  ctx: PlaybookVerifyContext
): Promise<PlaybookVerifyCheckResult[]> {
  const steps = parsePlaybookVerifySteps(markdown);
  if (steps.length === 0) return [];

  log('info', AGENT, 'Running playbook verify steps', {
    count: steps.length,
    namespace: ctx.namespace,
    resourceName: ctx.resourceName,
  });

  const results: PlaybookVerifyCheckResult[] = [];
  for (const step of steps) {
    if (step.type === 'http') results.push(await runHttpStep(step, ctx));
    else results.push(await runPromqlStep(step, ctx));
  }
  return results;
}

export { summarizePlaybookVerifyResults, parsePlaybookVerifySteps };
