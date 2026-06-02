/**
 * Persisted ignore list — suppressed resources skip HIL and watcher re-fire.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Platform } from '../../../shared/src/types.js';
import type { ApprovalRequest } from '../../../shared/src/types.js';
import {
  type IgnoredResource,
  ignoreKeysForApproval,
  ignoreKeysForRun,
  resourceIgnoreKey,
} from '../../../shared/src/incident-ignore.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'hil-ignore-store';
const STORE_PATH = process.env['IGNORE_STORE_PATH'] ?? '/data/ignored-resources.json';

class IgnoreStore {
  private byKey = new Map<string, IgnoredResource>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(STORE_PATH)) return;
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const list = JSON.parse(raw) as IgnoredResource[];
      for (const item of list) {
        if (item?.key) this.byKey.set(item.key, item);
      }
      log('info', AGENT, `Loaded ${this.byKey.size} ignored resource(s)`, { path: STORE_PATH });
    } catch (err) {
      log('warn', AGENT, 'Failed to load ignore store', { error: String(err) });
    }
  }

  private persist(): void {
    try {
      const dir = dirname(STORE_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(STORE_PATH, JSON.stringify([...this.byKey.values()], null, 2));
    } catch (err) {
      log('warn', AGENT, 'Failed to persist ignore store', { error: String(err) });
    }
  }

  list(): IgnoredResource[] {
    return [...this.byKey.values()].sort(
      (a, b) => new Date(b.ignoredAt).getTime() - new Date(a.ignoredAt).getTime()
    );
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  isIgnored(namespace: string, resourceName: string): boolean {
    return this.byKey.has(resourceIgnoreKey(namespace, resourceName));
  }

  isKeyIgnored(key: string): boolean {
    return this.byKey.has(key);
  }

  /** True if any ignore key for this approval matches. */
  isRequestIgnored(request: ApprovalRequest): boolean {
    return ignoreKeysForApproval(request).some((k) => this.byKey.has(k));
  }

  addFromRequest(
    request: ApprovalRequest,
    ignoredBy: string,
    ignoredVia: Platform,
    sourceIncidentId: string,
    reason?: string
  ): IgnoredResource[] {
    const keys = ignoreKeysForApproval(request);
    const added: IgnoredResource[] = [];
    const now = new Date().toISOString();

    for (const key of keys) {
      const entry: IgnoredResource = {
        key,
        namespace: request.namespace,
        resourceName: request.resourceName,
        resourceKind: request.resourceKind,
        githubRepo: request.plan.githubRepo,
        ignoredAt: now,
        ignoredBy,
        ignoredVia,
        sourceIncidentId,
        reason: reason ?? 'Ignored by operator',
      };
      this.byKey.set(key, entry);
      added.push(entry);
    }

    this.persist();
    log('info', AGENT, 'Resource(s) ignored', {
      incidentId: sourceIncidentId,
      keys,
      namespace: request.namespace,
      resourceName: request.resourceName,
    });
    return added;
  }

  remove(key: string): boolean {
    const ok = this.byKey.delete(key);
    if (ok) this.persist();
    return ok;
  }
}

export const ignoreStore = new IgnoreStore();
