/**
 * Cached app review snapshot for investigator HTTP routes.
 */

import { type AppReviewResult } from '../../../shared/src/app-graph.js';
import { buildAppReview } from './app-graph-builder.js';

const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { expiresAt: number; review: AppReviewResult }>();

function cacheKey(appId: string, namespace?: string): string {
  return `${namespace ?? ''}|${appId}`.toLowerCase();
}

export async function getAppReviewSnapshot(
  appId: string,
  namespace?: string,
  force = false
): Promise<AppReviewResult> {
  const key = cacheKey(appId, namespace);
  const now = Date.now();
  const hit = cache.get(key);
  if (!force && hit && hit.expiresAt > now) {
    return hit.review;
  }

  const review = await buildAppReview({ appId, namespace, incidentId: 'app-review' });
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, review });
  return review;
}

export function clearAppReviewCache(): void {
  cache.clear();
}
