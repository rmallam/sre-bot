/**
 * git-mirror.ts
 *
 * Fixes Issue #5 — gitops-agent clones repo on every request.
 *
 * Maintains a persistent local mirror of the GitOps repo at /tmp/gitops-mirror.
 * Clones once on startup, then syncs every GIT_SYNC_INTERVAL_SECONDS seconds.
 * All manifest lookups use the local mirror — no network round-trip per request.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { log } from '../../../shared/src/http.js';

const MIRROR_DIR = process.env.GIT_MIRROR_DIR ?? '/tmp/gitops-mirror';
const AGENT = 'investigator';

let syncTimer: ReturnType<typeof setInterval> | null = null;
let mirrorGit: SimpleGit | null = null;
let mirroredRepoUrl: string | null = null;
let lastSyncAt: Date | null = null;

/**
 * Ensures the local mirror is cloned and up to date.
 * Safe to call concurrently — a simple mutex-style guard prevents overlapping pulls.
 */
let syncInFlight = false;

export async function ensureMirrorSynced(repoUrl: string): Promise<void> {
  if (syncInFlight) {
    log('debug', AGENT, 'Mirror sync already in flight, skipping', { repoUrl });
    return;
  }
  syncInFlight = true;
  try {
    await _doSync(repoUrl);
  } finally {
    syncInFlight = false;
  }
}

async function _doSync(repoUrl: string): Promise<void> {
  const repoChanged = mirroredRepoUrl !== repoUrl;

  if (!existsSync(MIRROR_DIR) || repoChanged) {
    log('info', AGENT, 'Cloning GitOps repo mirror', { repoUrl, dest: MIRROR_DIR });
    const git = simpleGit();
    await git.clone(repoUrl, MIRROR_DIR, ['--depth', '1']);
    mirrorGit = simpleGit(MIRROR_DIR);
    mirroredRepoUrl = repoUrl;
    lastSyncAt = new Date();
    log('info', AGENT, 'GitOps repo mirror cloned successfully', { repoUrl, dest: MIRROR_DIR });
    return;
  }

  // Mirror dir already exists for the same repo — just pull
  if (!mirrorGit) {
    mirrorGit = simpleGit(MIRROR_DIR);
  }

  try {
    await mirrorGit.pull('origin', 'HEAD', ['--ff-only']);
    lastSyncAt = new Date();
    log('info', AGENT, 'GitOps mirror synced (pull)', {
      repoUrl,
      syncedAt: lastSyncAt.toISOString(),
    });
  } catch (err) {
    // If pull fails (e.g. diverged history), do a hard reset to remote HEAD
    log('warn', AGENT, 'Mirror pull failed — attempting hard reset', {
      repoUrl,
      error: String(err),
    });
    await mirrorGit.fetch('origin');
    await mirrorGit.reset(['--hard', 'origin/HEAD']);
    lastSyncAt = new Date();
    log('info', AGENT, 'GitOps mirror reset to origin/HEAD', {
      repoUrl,
      syncedAt: lastSyncAt.toISOString(),
    });
  }
}

/**
 * Starts the background sync timer.
 * Call once at agent startup after the initial clone.
 */
export function startMirrorSyncScheduler(
  repoUrl: string,
  intervalSeconds: number
): void {
  if (syncTimer) clearInterval(syncTimer);

  const ms = intervalSeconds * 1000;
  log('info', AGENT, 'Starting GitOps mirror sync scheduler', {
    repoUrl,
    intervalSeconds,
  });

  syncTimer = setInterval(async () => {
    try {
      await ensureMirrorSynced(repoUrl);
    } catch (err) {
      log('error', AGENT, 'Scheduled GitOps mirror sync failed', {
        repoUrl,
        error: String(err),
      });
    }
  }, ms);

  // Allow the Node.js process to exit even if the timer is still running
  if (syncTimer.unref) syncTimer.unref();
}

/**
 * Recursively walks a directory collecting YAML file paths.
 */
async function collectYamlFiles(dir: string, results: string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const ext = extname(entry).toLowerCase();
    if (ext === '.yaml' || ext === '.yml') {
      results.push(full);
    } else {
      // Recurse into subdirectories (no stat needed — readdir tells us via extname)
      // We'll try to readdir and silently skip non-dirs
      await collectYamlFiles(full, results);
    }
  }
  return results;
}

/**
 * Searches the local mirror for a YAML manifest that manages the given resource.
 *
 * Strategy:
 *  1. Walk all YAML files in the mirror.
 *  2. For each file, look for the combination of:
 *     - `kind: <resourceKind>`
 *     - `name: <resourceName>` (in metadata)
 *     - `namespace: <namespace>` (in metadata, if present)
 *
 * Returns the first match found, or null if none.
 */
export async function findManifest(
  resourceName: string,
  resourceKind: string,
  namespace: string
): Promise<{ path: string; content: string } | null> {
  if (!existsSync(MIRROR_DIR)) {
    log('warn', AGENT, 'Mirror directory does not exist — cannot search manifests', {
      mirrorDir: MIRROR_DIR,
    });
    return null;
  }

  const yamlFiles = await collectYamlFiles(MIRROR_DIR);
  log('debug', AGENT, `Searching ${yamlFiles.length} YAML files for manifest`, {
    resourceName,
    resourceKind,
    namespace,
  });

  for (const filePath of yamlFiles) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Fast string-based checks before parsing — avoids YAML parse overhead on every file
    const hasKind = content.includes(`kind: ${resourceKind}`);
    const hasName = content.includes(`name: ${resourceName}`);
    if (!hasKind || !hasName) continue;

    // Validate namespace if present in the manifest
    const hasNamespace =
      content.includes(`namespace: ${namespace}`) || !content.includes('namespace:');

    if (!hasNamespace) continue;

    log('info', AGENT, 'Found matching manifest in GitOps mirror', {
      resourceName,
      resourceKind,
      namespace,
      path: filePath,
    });

    return { path: filePath, content };
  }

  log('info', AGENT, 'No matching manifest found in GitOps mirror', {
    resourceName,
    resourceKind,
    namespace,
  });
  return null;
}

export function getMirrorStatus(): {
  mirrorDir: string;
  repoUrl: string | null;
  lastSyncAt: string | null;
} {
  return {
    mirrorDir: MIRROR_DIR,
    repoUrl: mirroredRepoUrl,
    lastSyncAt: lastSyncAt?.toISOString() ?? null,
  };
}
