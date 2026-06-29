#!/usr/bin/env npx tsx
/**
 * Regenerate shared/data/k8s-issue-taxonomy.json from runbooks + fixture catalog.
 *
 * Usage: npx tsx scripts/ingest-runbooks/sync-taxonomy.ts [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultRunbooksDir,
  defaultTaxonomyPath,
  dedupeRunbooks,
  loadRunbooksFromDir,
  type K8sIssueTaxonomy,
  type TaxonomyEntry,
} from '../../shared/src/runbook-corpus.js';
import { taxonomyIdFromSignature } from '../../shared/src/runbook-normalize.js';

const dryRun = process.argv.includes('--dry-run');

const SEVERITY: Record<string, TaxonomyEntry['severity']> = {
  DisasterRecovery: 'critical',
  SecurityIncident: 'critical',
  EtcdBackupRestore: 'critical',
  WebhookConfigurationRejected: 'high',
  NodeNotReady: 'high',
  OOMKilled: 'high',
  CrashLoopBackOff: 'high',
  PersistentVolumeClaimLost: 'high',
};

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
}

function loadFixtureMap(root: string): Map<string, string> {
  const fixturesPath = path.join(root, 'scripts', 'k8s-failure-fixtures', 'fixtures.json');
  const data = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as {
    fixtures: { id: string; error_signature: string }[];
  };
  const map = new Map<string, string>();
  for (const f of data.fixtures) {
    map.set(f.error_signature, f.id);
  }
  return map;
}

function main(): void {
  const root = repoRoot();
  const runbooks = dedupeRunbooks(loadRunbooksFromDir(defaultRunbooksDir(root)));
  const fixtureMap = loadFixtureMap(root);

  const entries: TaxonomyEntry[] = runbooks.map((rb) => {
    const entry: TaxonomyEntry = {
      id: taxonomyIdFromSignature(rb.error_signature),
      error_signature: rb.error_signature,
      target_component: rb.target_component,
      category: rb.target_component,
      severity: SEVERITY[rb.error_signature] ?? 'medium',
      sources: extractSourceUrl(rb.playbook_markdown),
      keywords: rb.error_signature
        .split(/(?=[A-Z])/)
        .map((s) => s.toLowerCase())
        .filter(Boolean),
    };
    const fixtureId = fixtureMap.get(rb.error_signature);
    if (fixtureId) entry.fixture_id = fixtureId;
    return entry;
  });

  const taxonomy: K8sIssueTaxonomy = {
    version: 1,
    components: ['compute', 'storage', 'network', 'gitops', 'database', 'security'],
    entries,
  };

  console.log(`Taxonomy: ${entries.length} entries (${fixtureMap.size} fixtures mapped)`);

  if (dryRun) return;

  fs.writeFileSync(defaultTaxonomyPath(root), `${JSON.stringify(taxonomy, null, 2)}\n`);
  console.log(`Wrote ${defaultTaxonomyPath(root)}`);
}

function extractSourceUrl(markdown: string): string[] {
  const m = markdown.match(/## Source\s*\n- (https?:\/\/\S+)/);
  return m ? [m[1]!] : ['https://kubernetes.io/docs/tasks/debug/'];
}

main();
