/**
 * PLAT-9 — Central observability payload budgets before LLM / brain.
 */

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const LOKI_MAX_LINES = envInt('LOKI_MAX_LINES', 120);
export const LOG_MERGE_MAX_CHARS = envInt('LOG_MERGE_MAX_CHARS', 12000);
export const LOG_MERGE_MAX_LINES = envInt('LOG_MERGE_MAX_LINES', 120);
export const LOG_SIGNAL_MAX_LINES = envInt('LOG_SIGNAL_MAX_LINES', 80);
export const K8S_LOG_MAX_BYTES = envInt('K8S_LOG_MAX_BYTES', 32768);
export const INVESTIGATOR_SAFE_MAX_LOG_BYTES = envInt('INVESTIGATOR_SAFE_MAX_LOG_BYTES', 4096);
export const CICD_LOG_EXCERPT_MAX_BYTES = envInt('CICD_LOG_EXCERPT_MAX_BYTES', 6000);
export const PROM_MAX_SAMPLES = envInt('PROM_MAX_SAMPLES', 15);
export const PROM_MAX_FINDINGS = envInt('PROM_MAX_FINDINGS', 10);
export const OBSERVABILITY_SUMMARY_MAX_CHARS = envInt('OBSERVABILITY_SUMMARY_MAX_CHARS', 2000);

export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end -= 1;
  }
  return text.slice(0, end);
}
