#!/usr/bin/env npx tsx
/**
 * Fetch K8s doc sources and merge normalized runbooks into shared/data/runbooks/.
 *
 * Usage:
 *   npx tsx scripts/ingest-runbooks/scrape-normalize.ts --merge
 *   npx tsx scripts/ingest-runbooks/scrape-normalize.ts --fetch --merge
 *   npx tsx scripts/ingest-runbooks/scrape-normalize.ts --dry-run
 *   npx tsx scripts/ingest-runbooks/scrape-normalize.ts --force --merge
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultDataDir,
  defaultRunbooksDir,
  loadJsonFile,
  type RunbookEntry,
} from '../../shared/src/runbook-corpus.js';
import {
  mergeRunbooksIntoComponent,
  sourceToRunbook,
  type K8sDocSourceCatalog,
} from '../../shared/src/runbook-normalize.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const doFetch = args.has('--fetch');
const doMerge = args.has('--merge');
const force = args.has('--force');

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
}

function cacheDir(root: string): string {
  return path.join(root, 'shared', 'data', 'runbook-imports', 'cache');
}

async function fetchUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'sre-bot-runbook-ingest/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

function componentFile(runbooksDir: string, component: string): string {
  return path.join(runbooksDir, `${component}.json`);
}

function loadComponentRunbooks(runbooksDir: string, component: string): RunbookEntry[] {
  const file = componentFile(runbooksDir, component);
  if (!fs.existsSync(file)) return [];
  const data = loadJsonFile<unknown>(file);
  if (!Array.isArray(data)) throw new Error(`${file}: expected array`);
  return data as RunbookEntry[];
}

function writeComponentRunbooks(
  runbooksDir: string,
  component: string,
  rows: RunbookEntry[]
): void {
  const file = componentFile(runbooksDir, component);
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
}

async function main(): Promise<void> {
  const root = repoRoot();
  const dataDir = defaultDataDir(root);
  const runbooksDir = defaultRunbooksDir(root);
  const catalogPath = path.join(dataDir, 'k8s-doc-sources.json');
  const catalog = loadJsonFile<K8sDocSourceCatalog>(catalogPath);
  const cache = cacheDir(root);

  if (!doMerge && !dryRun) {
    console.error('Pass --merge and/or --dry-run');
    process.exit(1);
  }

  if (doFetch && !dryRun) {
    fs.mkdirSync(cache, { recursive: true });
  }

  const incoming: RunbookEntry[] = [];
  for (const source of catalog.sources) {
    let scraped: string | undefined;
    const cacheFile = path.join(cache, `${source.error_signature}.html`);

    if (fs.existsSync(cacheFile)) {
      scraped = fs.readFileSync(cacheFile, 'utf8');
    } else if (doFetch) {
      try {
        scraped = await fetchUrl(source.url);
        if (!dryRun) fs.writeFileSync(cacheFile, scraped);
        console.log(`Fetched ${source.error_signature}`);
      } catch (err) {
        console.warn(`Fetch skipped ${source.error_signature}: ${err}`);
      }
    }

    const entry = sourceToRunbook(source, scraped);
    incoming.push(entry);
  }

  console.log(`Normalized ${incoming.length} sources`);

  if (dryRun && !doMerge) {
    for (const e of incoming) {
      console.log(`  ${e.target_component}/${e.error_signature} (${e.playbook_markdown.length} chars)`);
    }
    return;
  }

  const byComponent = new Map<string, RunbookEntry[]>();
  for (const rb of incoming) {
    const list = byComponent.get(rb.target_component) ?? [];
    list.push(rb);
    byComponent.set(rb.target_component, list);
  }

  let totalAdded = 0;
  let totalSkipped = 0;

  for (const [component, rows] of byComponent) {
    const existing = loadComponentRunbooks(runbooksDir, component);
    const { merged, result } = mergeRunbooksIntoComponent(existing, rows, force);
    totalAdded += result.added.length;
    totalSkipped += result.skipped.length;
    console.log(
      `${component}: +${result.added.length} ~${result.updated.length} =${result.skipped.length}`
    );
    if (!dryRun && doMerge) {
      writeComponentRunbooks(runbooksDir, component, merged);
    }
  }

  console.log(`Merge complete: added ${totalAdded}, skipped ${totalSkipped}${dryRun ? ' (dry-run)' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
