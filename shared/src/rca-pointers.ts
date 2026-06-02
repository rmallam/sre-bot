/**
 * Deep RCA pointers — structured evidence from multiple sources (Holmes-style, code-gathered).
 */

export type RcaPointerSource =
  | 'kubernetes'
  | 'loki'
  | 'prometheus'
  | 'events'
  | 'gitops'
  | 'workload'
  | 'network'
  | 'database';

export interface RcaPointer {
  source: RcaPointerSource;
  title: string;
  summary: string;
  findings: string[];
  confidence: number;
  excerpt?: string;
}

export function formatRcaPointersForPlan(pointers: RcaPointer[]): string {
  if (!pointers.length) return '';
  return pointers
    .map(
      (p) =>
        `[${p.source}] ${p.title}: ${p.summary}` +
        (p.findings.length ? `\n  - ${p.findings.slice(0, 5).join('\n  - ')}` : '')
    )
    .join('\n\n');
}
