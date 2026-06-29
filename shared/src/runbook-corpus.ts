/**
 * Load, validate, and dedupe the K8s/OpenShift runbook corpus under shared/data/.
 */

import fs from 'node:fs';
import path from 'node:path';

export const RUNBOOK_COMPONENTS = [
  'compute',
  'storage',
  'network',
  'gitops',
  'database',
  'security',
] as const;

export type RunbookComponent = (typeof RUNBOOK_COMPONENTS)[number];

export interface RunbookEntry {
  error_signature: string;
  target_component: RunbookComponent;
  playbook_markdown: string;
}

export interface TaxonomyEntry {
  id: string;
  error_signature: string;
  target_component: RunbookComponent;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  fixture_id?: string;
  sources?: string[];
  keywords?: string[];
  openshift_notes?: string;
}

export interface K8sIssueTaxonomy {
  version: number;
  components: RunbookComponent[];
  entries: TaxonomyEntry[];
}

export interface RunbookValidationIssue {
  path: string;
  message: string;
}

export interface CorpusValidationResult {
  ok: boolean;
  runbookCount: number;
  taxonomyCount: number;
  issues: RunbookValidationIssue[];
}

const REQUIRED_PLAYBOOK_SECTIONS = ['## Symptoms', '## Diagnosis', '## Verification'];

function repoRootFromModule(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..');
}

export function defaultDataDir(root = repoRootFromModule()): string {
  return path.join(root, 'shared', 'data');
}

export function defaultRunbooksDir(root = repoRootFromModule()): string {
  return path.join(defaultDataDir(root), 'runbooks');
}

export function defaultTaxonomyPath(root = repoRootFromModule()): string {
  return path.join(defaultDataDir(root), 'k8s-issue-taxonomy.json');
}

export function isRunbookComponent(value: string): value is RunbookComponent {
  return (RUNBOOK_COMPONENTS as readonly string[]).includes(value);
}

export function validateRunbook(entry: RunbookEntry, filePath = ''): RunbookValidationIssue[] {
  const issues: RunbookValidationIssue[] = [];
  const prefix = filePath || entry.error_signature;

  if (!entry.error_signature?.trim()) {
    issues.push({ path: prefix, message: 'error_signature is required' });
  }
  if (!entry.target_component || !isRunbookComponent(entry.target_component)) {
    issues.push({
      path: prefix,
      message: `target_component must be one of: ${RUNBOOK_COMPONENTS.join(', ')}`,
    });
  }
  const md = entry.playbook_markdown ?? '';
  if (md.trim().length < 80) {
    issues.push({ path: prefix, message: 'playbook_markdown too short (min ~80 chars)' });
  }
  for (const section of REQUIRED_PLAYBOOK_SECTIONS) {
    if (!md.includes(section)) {
      issues.push({ path: prefix, message: `missing required section: ${section}` });
    }
  }
  return issues;
}

export function loadJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

/** Load all runbooks from shared/data/runbooks/*.json (sorted by filename). */
export function loadRunbooksFromDir(runbooksDir = defaultRunbooksDir()): RunbookEntry[] {
  if (!fs.existsSync(runbooksDir)) {
    return [];
  }
  const files = fs
    .readdirSync(runbooksDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: RunbookEntry[] = [];
  for (const file of files) {
    const filePath = path.join(runbooksDir, file);
    const data = loadJsonFile<unknown>(filePath);
    if (!Array.isArray(data)) {
      throw new Error(`${filePath}: expected JSON array`);
    }
    for (const row of data) {
      out.push(row as RunbookEntry);
    }
  }
  return out;
}

export function loadTaxonomy(taxonomyPath = defaultTaxonomyPath()): K8sIssueTaxonomy {
  return loadJsonFile<K8sIssueTaxonomy>(taxonomyPath);
}

/** Dedupe by (error_signature, target_component); later entries win. */
export function dedupeRunbooks(runbooks: RunbookEntry[]): RunbookEntry[] {
  const map = new Map<string, RunbookEntry>();
  for (const rb of runbooks) {
    const key = `${rb.target_component}::${rb.error_signature}`;
    map.set(key, rb);
  }
  return [...map.values()].sort((a, b) =>
    `${a.target_component}:${a.error_signature}`.localeCompare(
      `${b.target_component}:${b.error_signature}`
    )
  );
}

export function validateCorpus(opts?: {
  runbooksDir?: string;
  taxonomyPath?: string;
}): CorpusValidationResult {
  const runbooksDir = opts?.runbooksDir ?? defaultRunbooksDir();
  const taxonomyPath = opts?.taxonomyPath ?? defaultTaxonomyPath();
  const issues: RunbookValidationIssue[] = [];

  let runbooks: RunbookEntry[] = [];
  try {
    runbooks = loadRunbooksFromDir(runbooksDir);
  } catch (err) {
    issues.push({ path: runbooksDir, message: String(err) });
  }

  let taxonomy: K8sIssueTaxonomy | null = null;
  try {
    taxonomy = loadTaxonomy(taxonomyPath);
  } catch (err) {
    issues.push({ path: taxonomyPath, message: String(err) });
  }

  const seenKeys = new Set<string>();
  for (const rb of runbooks) {
    const fileLabel = `${rb.target_component}/${rb.error_signature}`;
    issues.push(...validateRunbook(rb, fileLabel).map((i) => ({ ...i, path: fileLabel })));
    const key = `${rb.target_component}::${rb.error_signature}`;
    if (seenKeys.has(key)) {
      issues.push({ path: fileLabel, message: 'duplicate error_signature in corpus' });
    }
    seenKeys.add(key);
  }

  if (taxonomy) {
    const taxKeys = new Set<string>();
    for (const entry of taxonomy.entries) {
      const key = `${entry.target_component}::${entry.error_signature}`;
      if (taxKeys.has(key)) {
        issues.push({
          path: entry.id,
          message: 'duplicate taxonomy entry for same signature/component',
        });
      }
      taxKeys.add(key);
      if (!seenKeys.has(key)) {
        issues.push({
          path: entry.id,
          message: `taxonomy entry has no matching runbook (${entry.error_signature})`,
        });
      }
    }
    for (const key of seenKeys) {
      if (!taxKeys.has(key)) {
        const [component, signature] = key.split('::');
        issues.push({
          path: signature,
          message: `runbook missing from taxonomy (${component}/${signature})`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    runbookCount: runbooks.length,
    taxonomyCount: taxonomy?.entries.length ?? 0,
    issues,
  };
}
