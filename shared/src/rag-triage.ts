/**
 * Pre-ReAct RAG triage — similarity gate to skip multi-turn investigation.
 */

import type { PlatformRagResult } from './platform-client.js';
import { ragGroundingEnabled } from './platform-client.js';

export function ragBypassReactEnabled(): boolean {
  if (!ragGroundingEnabled()) return false;
  const raw = process.env['SRE_RAG_BYPASS_REACT'];
  if (raw == null || raw.trim() === '') return true;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export function ragBypassSimilarityThreshold(): number {
  const raw = process.env['SRE_RAG_BYPASS_THRESHOLD'];
  if (raw == null || raw.trim() === '') return 0.9;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.9;
}

export function isVerifiedRunbookMarkdown(markdown: string): boolean {
  const m = markdown.trim();
  if (!m) return false;
  return (
    /verified fix/i.test(m) ||
    /ragLearn runId=/i.test(m) ||
    /## Remediation \(verified\)/i.test(m)
  );
}

export interface RagBypassAssessment {
  eligible: boolean;
  similarity: number;
  threshold: number;
  verified: boolean;
  reason: string;
}

export function assessRagBypass(rag: PlatformRagResult | null): RagBypassAssessment {
  const threshold = ragBypassSimilarityThreshold();
  if (!ragBypassReactEnabled()) {
    return { eligible: false, similarity: 0, threshold, verified: false, reason: 'bypass_disabled' };
  }
  if (!rag?.found || !rag.playbookMarkdown.trim()) {
    return { eligible: false, similarity: rag?.similarity ?? 0, threshold, verified: false, reason: 'no_runbook' };
  }
  if (rag.similarity < threshold) {
    return {
      eligible: false,
      similarity: rag.similarity,
      threshold,
      verified: false,
      reason: 'below_threshold',
    };
  }
  if (!isVerifiedRunbookMarkdown(rag.playbookMarkdown)) {
    return {
      eligible: false,
      similarity: rag.similarity,
      threshold,
      verified: false,
      reason: 'not_verified',
    };
  }
  return {
    eligible: true,
    similarity: rag.similarity,
    threshold,
    verified: true,
    reason: 'high_confidence_verified',
  };
}
