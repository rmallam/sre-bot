/**
 * Parse and evaluate custom verification steps from RAG runbook markdown.
 */

export type PlaybookVerifyStep =
  | {
      type: 'http';
      method: 'GET' | 'POST' | 'HEAD';
      url: string;
      expectStatus: number;
      timeoutSec: number;
    }
  | {
      type: 'promql';
      query: string;
      expect: string;
    };

export interface PlaybookVerifyContext {
  namespace: string;
  resourceName: string;
  workload?: string;
}

export interface PlaybookVerifyCheckResult {
  step: PlaybookVerifyStep;
  passed: boolean;
  detail: string;
}

const VERIFY_SECTION = /^##\s+verification\s*$/im;

export function substituteVerifyTemplate(text: string, ctx: PlaybookVerifyContext): string {
  const workload = ctx.workload ?? ctx.resourceName;
  return text
    .replace(/\{namespace\}/g, ctx.namespace)
    .replace(/\{resourceName\}/g, ctx.resourceName)
    .replace(/\{workload\}/g, workload);
}

export function parsePlaybookVerifySteps(markdown: string): PlaybookVerifyStep[] {
  if (!markdown?.trim()) return [];
  const match = markdown.match(VERIFY_SECTION);
  if (!match || match.index == null) return [];

  const section = markdown.slice(match.index + match[0].length);
  const nextHeading = section.search(/^##\s+/m);
  const body = nextHeading >= 0 ? section.slice(0, nextHeading) : section;
  const steps: PlaybookVerifyStep[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;

    const typeMatch = line.match(/type:\s*(http|promql)/i);
    if (typeMatch) {
      const block = line.slice(1).trim();
      const httpInline = block.match(
        /type:\s*http(?:.*?url:\s*(\S+))(?:.*?expect_status:\s*(\d+))?/i
      );
      if (httpInline?.[1]) {
        steps.push({
          type: 'http',
          method: 'GET',
          url: httpInline[1]!,
          expectStatus: parseInt(httpInline[2] ?? '200', 10) || 200,
          timeoutSec: 10,
        });
        continue;
      }
      const promInline = block.match(/type:\s*promql.*?query:\s*(.+?)\s+expect:\s*(.+)$/i);
      if (promInline?.[1] && promInline[2]) {
        steps.push({ type: 'promql', query: promInline[1].trim(), expect: promInline[2].trim() });
        continue;
      }
      const fields = parseYamlLikeFields(block);
      if (fields['type']?.toLowerCase() === 'http') {
        const url = fields['url'];
        if (!url) continue;
        steps.push({
          type: 'http',
          method: (fields['method']?.toUpperCase() as 'GET' | 'POST' | 'HEAD') || 'GET',
          url,
          expectStatus: parseInt(fields['expect_status'] ?? '200', 10) || 200,
          timeoutSec: parseInt(fields['timeout_sec'] ?? '10', 10) || 10,
        });
      } else if (fields['type']?.toLowerCase() === 'promql') {
        const query = fields['query'];
        const expect = fields['expect'];
        if (!query || !expect) continue;
        steps.push({ type: 'promql', query, expect: expect.trim() });
      }
      continue;
    }

    const curlMatch = line.match(
      /curl\s+(GET|POST|HEAD)?\s+(\S+)\s+expect(?:_status)?\s+(\d+)/i
    );
    if (curlMatch) {
      steps.push({
        type: 'http',
        method: (curlMatch[1]?.toUpperCase() as 'GET' | 'POST' | 'HEAD') || 'GET',
        url: curlMatch[2]!,
        expectStatus: parseInt(curlMatch[3]!, 10),
        timeoutSec: 10,
      });
      continue;
    }

    const promMatch = line.match(/promql\s+(.+?)\s+expect\s+(.+)/i);
    if (promMatch) {
      steps.push({ type: 'promql', query: promMatch[1]!.trim(), expect: promMatch[2]!.trim() });
    }
  }

  return steps;
}

function parseYamlLikeFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of block.split(/\s+/)) {
    const m = part.match(/^([a-z_]+):(.+)$/i);
    if (m) out[m[1]!.toLowerCase()] = m[2]!.replace(/^["']|["']$/g, '');
  }
  const kvRe = /(\w+):\s*("([^"]*)"|(\S+))/g;
  let kv: RegExpExecArray | null;
  while ((kv = kvRe.exec(block))) {
    out[kv[1]!.toLowerCase()] = (kv[3] ?? kv[4] ?? '').trim();
  }
  return out;
}

/** Evaluate numeric expectation like "< 0.05", "> 0", "== 1". */
export function evaluateNumericExpectation(actual: number, expect: string): boolean {
  const trimmed = expect.trim();
  const m = trimmed.match(/^(<=|>=|<|>|==|=)\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return false;
  const op = m[1]!;
  const target = parseFloat(m[2]!);
  switch (op) {
    case '<':
      return actual < target;
    case '<=':
      return actual <= target;
    case '>':
      return actual > target;
    case '>=':
      return actual >= target;
    case '==':
    case '=':
      return actual === target;
    default:
      return false;
  }
}

export function summarizePlaybookVerifyResults(results: PlaybookVerifyCheckResult[]): string {
  if (results.length === 0) return '';
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    return `Playbook checks passed (${results.length}/${results.length})`;
  }
  return `Playbook checks failed (${failed.length}/${results.length}): ${failed.map((f) => f.detail).join('; ')}`;
}
