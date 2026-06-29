#!/usr/bin/env npx tsx
/**
 * Bulk upsert runbooks into platform-agent pgvector via POST /rag/learn.
 *
 * Env:
 *   SRE_PLATFORM_URL or PLATFORM_URL (default http://localhost:9090)
 *   SRE_INTERNAL_TOKEN (optional — platform may not require on local)
 *
 * Usage:
 *   npx tsx scripts/ingest-runbooks/bulk-learn.ts [--dry-run] [--component compute]
 */
import {
  dedupeRunbooks,
  loadRunbooksFromDir,
  type RunbookComponent,
  type RunbookEntry,
} from '../../shared/src/runbook-corpus.js';

function platformUrl(): string {
  return (
    process.env['SRE_PLATFORM_URL'] ??
    process.env['PLATFORM_URL'] ??
    'http://localhost:9090'
  ).replace(/\/$/, '');
}

async function learnRunbook(
  baseUrl: string,
  entry: RunbookEntry
): Promise<{ ok: boolean; status: number; body: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = process.env['SRE_INTERNAL_TOKEN'];
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const timeoutMs = Number(process.env['RUNBOOK_INGEST_TIMEOUT_MS'] ?? 120_000);
  const res = await fetch(`${baseUrl}/rag/learn`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      error_signature: entry.error_signature,
      target_component: entry.target_component,
      playbook_markdown: entry.playbook_markdown,
      incident_id: 'runbook-corpus-ingest',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const componentArg = process.argv.find((a) => a.startsWith('--component='));
  const componentFilter = componentArg?.split('=')[1] as RunbookComponent | undefined;

  let runbooks = dedupeRunbooks(loadRunbooksFromDir());
  if (componentFilter) {
    runbooks = runbooks.filter((r) => r.target_component === componentFilter);
  }

  const baseUrl = platformUrl();
  console.log(`Ingesting ${runbooks.length} runbooks → ${baseUrl}/rag/learn`);

  let ok = 0;
  let fail = 0;

  for (const entry of runbooks) {
    const label = `${entry.target_component}/${entry.error_signature}`;
    if (dryRun) {
      console.log(`[dry-run] ${label}`);
      ok++;
      continue;
    }
    const result = await learnRunbook(baseUrl, entry);
    if (result.ok) {
      console.log(`OK ${label}`);
      ok++;
    } else {
      console.error(`FAIL ${label} (${result.status}) ${result.body}`);
      fail++;
    }
  }

  console.log(`Done: ${ok} ok, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
