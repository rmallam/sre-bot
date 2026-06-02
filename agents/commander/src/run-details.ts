/**
 * UX-4 — Fetch orchestrator run summary for Show logs / follow-ups.
 */

const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';

export async function fetchRunDetailsText(
  runId: string,
  opts?: { verbose?: boolean }
): Promise<string> {
  const params = opts?.verbose ? '?verbose=true' : '';
  const res = await fetch(`${ORCHESTRATOR_URL}/runs/${encodeURIComponent(runId)}/summary${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    if (res.status === 404) return 'That run is no longer available (may have expired).';
    return `Could not load run details (HTTP ${res.status}).`;
  }
  const data = (await res.json()) as { text?: string };
  return data.text ?? 'No details available.';
}

export async function fetchLatestRunSummaryByIncident(
  incidentId: string,
  opts?: { verbose?: boolean }
): Promise<string | null> {
  const listRes = await fetch(
    `${ORCHESTRATOR_URL}/runs?incidentId=${encodeURIComponent(incidentId)}&limit=1`,
    { signal: AbortSignal.timeout(15_000) }
  );
  if (!listRes.ok) return null;
  const list = (await listRes.json()) as { runs?: Array<{ runId: string }> };
  const runId = list.runs?.[0]?.runId;
  if (!runId) return null;
  return fetchRunDetailsText(runId, opts);
}
