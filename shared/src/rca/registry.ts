/**
 * RCA plugin registry — parallel gather and merge (PLAT-14).
 */

import { mergeLogExcerpts } from '../log-excerpt.js';
import { formatRcaPointersForPlan } from '../rca-pointers.js';
import type { DeepRcaResult, RcaGatherContext, RcaPlugin } from './plugin.js';

const DEEP_RCA_ENABLED = (process.env['DEEP_RCA_ENABLED'] ?? 'true').toLowerCase() === 'true';

export async function gatherAllRcaPointers(
  ctx: RcaGatherContext,
  plugins: RcaPlugin[]
): Promise<DeepRcaResult> {
  const applicable = plugins.filter((p) => p.isConfigured() && p.isApplicable(ctx));
  if (!DEEP_RCA_ENABLED) {
    return emptyResult(ctx);
  }

  const settled = await Promise.allSettled(applicable.map((p) => p.gather(ctx)));
  const pointers = [];
  let supplementalLogLines: string[] = [];

  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    pointers.push(result.value.pointer);
    if (result.value.supplementalLogLines?.length) {
      supplementalLogLines = supplementalLogLines.concat(result.value.supplementalLogLines);
    }
  }

  const sorted = pointers.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
  const supplemental =
    supplementalLogLines.length > 0 ? supplementalLogLines.join('\n') : '';
  const enrichedCurrentLogs = mergeLogExcerpts(ctx.k8sFacts.currentLogs ?? '', supplemental);

  return {
    rcaPointers: pointers,
    observabilitySummary: formatRcaPointersForPlan(sorted),
    enrichedCurrentLogs,
    enrichedPreviousLogs: ctx.k8sFacts.previousLogs ?? '',
  };
}

function emptyResult(ctx: RcaGatherContext): DeepRcaResult {
  return {
    rcaPointers: [],
    observabilitySummary: '',
    enrichedCurrentLogs: ctx.k8sFacts.currentLogs ?? '',
    enrichedPreviousLogs: ctx.k8sFacts.previousLogs ?? '',
  };
}
