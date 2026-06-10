/**
 * Pick high-signal log lines for RCA (Holmes-style context budgeting).
 */

import {
  LOG_MERGE_MAX_CHARS,
  LOG_MERGE_MAX_LINES,
  LOG_SIGNAL_MAX_LINES,
} from './observability-limits.js';

const ERROR_MARKERS =
  /\b(error|exception|fatal|panic|failed|denied|refused|timeout|oom|crashloop|backoff)\b/i;

export function pickSignalLogLines(lines: string[], maxLines = LOG_SIGNAL_MAX_LINES): string[] {
  if (lines.length <= maxLines) return lines;

  const scored = lines.map((line, index) => ({
    line,
    index,
    score: ERROR_MARKERS.test(line) ? 2 : line.trim().length > 20 ? 1 : 0,
  }));

  scored.sort((a, b) => b.score - a.score || b.index - a.index);

  const picked = new Set<number>();
  const out: string[] = [];

  for (const item of scored) {
    if (out.length >= maxLines) break;
    if (picked.has(item.index)) continue;
    picked.add(item.index);
    out.push(item.line);
  }

  return out.sort((a, b) => lines.indexOf(a) - lines.indexOf(b));
}

export function mergeLogExcerpts(
  primary: string,
  supplemental: string,
  maxChars = LOG_MERGE_MAX_CHARS
): string {
  const combined = [primary, supplemental].filter(Boolean).join('\n--- observability ---\n');
  if (combined.length <= maxChars) return combined;
  const lines = combined.split('\n');
  return pickSignalLogLines(lines, LOG_MERGE_MAX_LINES).join('\n').slice(0, maxChars);
}
