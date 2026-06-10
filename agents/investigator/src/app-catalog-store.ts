/**
 * Persist user-edited and auto-proposed application catalog entries.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppCatalogEntry, AppCatalogMember } from '../../../shared/src/app-catalog.js';
import { catalogKey, mergeCatalogEntries } from '../../../shared/src/app-catalog.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';
const CATALOG_PATH =
  process.env['APP_CATALOG_PATH'] ?? join(process.env['TMPDIR'] ?? '/tmp', 'sre-app-catalog.json');

interface CatalogFile {
  entries: AppCatalogEntry[];
}

let cache: AppCatalogEntry[] | null = null;

/** Test hook — reset in-memory cache between tests. */
export function resetCatalogCache(): void {
  cache = null;
}

async function loadFile(): Promise<AppCatalogEntry[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(CATALOG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CatalogFile;
    cache = parsed.entries ?? [];
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

async function saveFile(entries: AppCatalogEntry[]): Promise<void> {
  cache = entries;
  await mkdir(dirname(CATALOG_PATH), { recursive: true });
  await writeFile(CATALOG_PATH, JSON.stringify({ entries }, null, 2), 'utf-8');
}

export async function listCatalogEntries(): Promise<AppCatalogEntry[]> {
  return loadFile();
}

export async function getCatalogEntry(
  namespace: string,
  appId: string
): Promise<AppCatalogEntry | undefined> {
  const entries = await loadFile();
  return entries.find((e) => catalogKey(e.namespace, e.appId) === catalogKey(namespace, appId));
}

export async function upsertCatalogEntry(entry: AppCatalogEntry): Promise<AppCatalogEntry> {
  const entries = await loadFile();
  const key = catalogKey(entry.namespace, entry.appId);
  const idx = entries.findIndex((e) => catalogKey(e.namespace, e.appId) === key);
  const next = { ...entry, updatedAt: new Date().toISOString() };
  if (idx >= 0) {
    entries[idx] = next;
  } else {
    entries.push(next);
  }
  await saveFile(entries);
  log('info', AGENT, 'Catalog entry saved', { appId: entry.appId, namespace: entry.namespace });
  return next;
}

/** Auto-propose from deploy — does not overwrite user-edited entries. */
export async function upsertAutoCatalogEntry(opts: {
  appId: string;
  namespace: string;
  members: AppCatalogMember[];
  dependsOn?: string[];
}): Promise<AppCatalogEntry | null> {
  const existing = await getCatalogEntry(opts.namespace, opts.appId);
  if (existing?.userEdited) return existing;

  return upsertCatalogEntry({
    appId: opts.appId,
    namespace: opts.namespace,
    source: 'auto',
    members: opts.members,
    dependsOn: opts.dependsOn,
    userEdited: false,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteCatalogEntry(namespace: string, appId: string): Promise<boolean> {
  const entries = await loadFile();
  const key = catalogKey(namespace, appId);
  const filtered = entries.filter((e) => catalogKey(e.namespace, e.appId) !== key);
  if (filtered.length === entries.length) return false;
  await saveFile(filtered);
  return true;
}

export function mergedWithAuto(
  discovered: AppCatalogEntry[],
  stored: AppCatalogEntry[]
): AppCatalogEntry[] {
  return mergeCatalogEntries(discovered, stored);
}
