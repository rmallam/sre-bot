/**
 * Deep RCA enrichment — parallel observability pointers (Holmes-style multi-source gather).
 */

import type { DiagnosisContext, SpecialistDiagnostic } from '../../../shared/src/types.js';
import type { RcaPointer } from '../../../shared/src/rca-pointers.js';
import { formatRcaPointersForPlan } from '../../../shared/src/rca-pointers.js';
import { mergeLogExcerpts, pickSignalLogLines } from '../../../shared/src/log-excerpt.js';
import {
  queryLokiLogs,
  queryPrometheusMetrics,
  observabilityBackendsConfigured,
} from '../../../shared/src/observability-query.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator-rca';
const DEEP_RCA_ENABLED = (process.env['DEEP_RCA_ENABLED'] ?? 'true').toLowerCase() === 'true';

export interface DeepRcaInput {
  incidentId: string;
  namespace: string;
  resourceName: string;
  podName: string;
  k8sFacts: Partial<DiagnosisContext>;
  specialistDiagnostics?: SpecialistDiagnostic[];
}

export interface DeepRcaResult {
  rcaPointers: RcaPointer[];
  observabilitySummary: string;
  enrichedCurrentLogs: string;
  enrichedPreviousLogs: string;
}

function specialistToPointer(d: SpecialistDiagnostic): RcaPointer {
  return {
    source: d.specialist,
    title: `${d.specialist} specialist`,
    summary: d.summary,
    findings: d.findings,
    confidence: d.confidence,
  };
}

function eventsPointer(events: DiagnosisContext['recentEvents']): RcaPointer | null {
  const warnings = (events ?? []).filter((e) => e.type === 'Warning').slice(0, 8);
  if (warnings.length === 0) return null;
  return {
    source: 'events',
    title: 'Kubernetes Warning events',
    summary: `${warnings.length} recent warning event(s)`,
    confidence: 0.85,
    findings: warnings.map((e) => `${e.reason}: ${e.message}`.slice(0, 200)),
  };
}

export async function enrichWithDeepRca(input: DeepRcaInput): Promise<DeepRcaResult> {
  const pointers: RcaPointer[] = [];

  for (const d of input.specialistDiagnostics ?? []) {
    pointers.push(specialistToPointer(d));
  }

  const ev = eventsPointer(input.k8sFacts.recentEvents ?? []);
  if (ev) pointers.push(ev);

  pointers.push({
    source: 'kubernetes',
    title: 'Pod / workload snapshot',
    summary: `Captured spec, container status, and logs for ${input.namespace}/${input.resourceName}`,
    confidence: 0.9,
    findings: [
      `${(input.k8sFacts.containerStatuses ?? []).length} container status entries`,
      `${(input.k8sFacts.recentEvents ?? []).length} related events`,
    ],
  });

  let supplementalLogLines: string[] = [];
  const backends = observabilityBackendsConfigured();

  if (DEEP_RCA_ENABLED) {
    const [lokiRes, promRes] = await Promise.allSettled([
      queryLokiLogs({
        incidentId: input.incidentId,
        namespace: input.namespace,
        podName: input.podName,
        deployment: input.resourceName,
        sinceMinutes: 45,
      }),
      queryPrometheusMetrics({
        incidentId: input.incidentId,
        namespace: input.namespace,
        deployment: input.resourceName,
        podName: input.podName,
      }),
    ]);

    if (lokiRes.status === 'fulfilled' && lokiRes.value && lokiRes.value.lines.length > 0) {
      supplementalLogLines = lokiRes.value.lines;
      pointers.push({
        source: 'loki',
        title: 'Loki log stream',
        summary: `${lokiRes.value.lines.length} signal lines from Loki (${lokiRes.value.truncated ? 'truncated' : 'complete'})`,
        confidence: 0.88,
        findings: pickSignalLogLines(lokiRes.value.lines, 5),
        excerpt: lokiRes.value.lines.slice(-12).join('\n').slice(0, 1500),
      });
    } else if (backends.loki) {
      log('debug', AGENT, 'Loki configured but no lines for workload', {
        incidentId: input.incidentId,
        namespace: input.namespace,
        podName: input.podName,
      });
    }

    if (promRes.status === 'fulfilled' && promRes.value) {
      const p = promRes.value;
      if (p.samples.length > 0 || p.findings.length > 0) {
        pointers.push({
          source: 'prometheus',
          title: 'Prometheus metrics',
          summary: p.summary,
          confidence: p.findings.length > 0 ? 0.82 : 0.6,
          findings: p.findings.length > 0 ? p.findings : p.samples.slice(0, 5).map((s) => `${s.metric}=${s.value}`),
        });
      }
    }
  }

  const supplemental =
    supplementalLogLines.length > 0 ? supplementalLogLines.join('\n') : '';
  const enrichedCurrentLogs = mergeLogExcerpts(
    input.k8sFacts.currentLogs ?? '',
    supplemental
  );
  const enrichedPreviousLogs = input.k8sFacts.previousLogs ?? '';

  const observabilitySummary = formatRcaPointersForPlan(
    pointers.sort((a, b) => b.confidence - a.confidence).slice(0, 8)
  );

  return {
    rcaPointers: pointers,
    observabilitySummary,
    enrichedCurrentLogs,
    enrichedPreviousLogs,
  };
}
