/**
 * src/store.ts
 *
 * Atomic in-memory approval store.
 *
 * Fixes Issue #4 — race condition with dual-channel HIL.
 *
 * JavaScript's single-threaded event loop makes the synchronous check-and-set
 * on the Map naturally atomic — no mutex is needed. Once a status transitions
 * away from PENDING, all subsequent calls to tryApprove / tryReject return
 * 'already_handled', ensuring only ONE platform (Slack, Telegram, or Web) wins.
 */

import type { ApprovalRequest, ApprovalStatus, Platform } from '../../../shared/src/types.js';
import { approvalNotifyFingerprint } from '../../../shared/src/approval-dedupe.js';

export interface PendingApproval {
  request: ApprovalRequest;
  status: ApprovalStatus;
  lockedBy?: string;
  lockedAt?: string;
  lockedVia?: Platform;
  rejectionReason?: string;
  expiresAt: string; // ISO 8601
}

type TryResult = 'ok' | 'already_handled' | 'not_found' | 'expired';

export type MergeApprovalResult =
  | { action: 'created' }
  | { action: 'duplicate'; incidentId: string }
  | { action: 'updated'; incidentId: string; fingerprintChanged: boolean };

const APPROVAL_TIMEOUT_MINUTES = parseInt(
  process.env['APPROVAL_TIMEOUT_MINUTES'] ?? '60',
  10
);

class ApprovalStore {
  private readonly store = new Map<string, PendingApproval>();

  private isPending(entry: PendingApproval | undefined): entry is PendingApproval {
    if (!entry || entry.status !== 'PENDING') return false;
    return new Date(entry.expiresAt).getTime() > Date.now();
  }

  /** Find a non-expired PENDING approval for an orchestrator run. */
  findPendingByRunId(runId: string): PendingApproval | undefined {
    for (const entry of this.store.values()) {
      if (entry.request.runId === runId && this.isPending(entry)) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Create or refresh a pending approval without spamming notifications.
   * One active PENDING per incidentId; also collapses duplicate runId entries.
   */
  mergeOrCreate(request: ApprovalRequest): MergeApprovalResult {
    const expiresAt = new Date(
      Date.now() + APPROVAL_TIMEOUT_MINUTES * 60 * 1_000
    ).toISOString();

    const byIncident = this.store.get(request.incidentId);
    let existing = this.isPending(byIncident) ? byIncident : undefined;

    if (!existing && request.runId) {
      existing = this.findPendingByRunId(request.runId);
      if (existing && existing.request.incidentId !== request.incidentId) {
        this.store.delete(existing.request.incidentId);
      }
    }

    const nextFingerprint = approvalNotifyFingerprint(request);
    const canonicalId = existing?.request.incidentId ?? request.incidentId;

    if (existing) {
      const prevFingerprint = approvalNotifyFingerprint(existing.request);
      const fingerprintChanged = prevFingerprint !== nextFingerprint;
      const mergedRequest: ApprovalRequest = {
        ...request,
        incidentId: canonicalId,
      };
      this.store.set(canonicalId, {
        request: mergedRequest,
        status: 'PENDING',
        expiresAt,
      });
      if (!fingerprintChanged) {
        return { action: 'duplicate', incidentId: canonicalId };
      }
      return { action: 'updated', incidentId: canonicalId, fingerprintChanged: true };
    }

    this.store.set(canonicalId, {
      request: { ...request, incidentId: canonicalId },
      status: 'PENDING',
      expiresAt,
    });
    return { action: 'created' };
  }

  /** Add a new approval request. Idempotent — overwrites if already present. */
  add(request: ApprovalRequest): void {
    const expiresAt = new Date(
      Date.now() + APPROVAL_TIMEOUT_MINUTES * 60 * 1_000
    ).toISOString();

    this.store.set(request.incidentId, {
      request,
      status: 'PENDING',
      expiresAt,
    });
  }

  /** Retrieve a pending approval by incidentId. Returns undefined if not found. */
  get(incidentId: string): PendingApproval | undefined {
    return this.store.get(incidentId);
  }

  /** Return all stored approvals (any status). */
  getAll(): PendingApproval[] {
    return Array.from(this.store.values());
  }

  /** Return only PENDING (and non-expired) approvals. */
  getPending(): PendingApproval[] {
    const now = Date.now();
    return Array.from(this.store.values()).filter(
      (a) => a.status === 'PENDING' && new Date(a.expiresAt).getTime() > now
    );
  }

  /**
   * Atomically attempt to approve an incident.
   *
   * Returns:
   *   'ok'              — approval recorded; caller should dispatch to GitOps
   *   'already_handled' — another platform already acted on this incident
   *   'not_found'       — incidentId unknown
   *   'expired'         — approval window has passed
   */
  tryApprove(
    incidentId: string,
    userId: string,
    via: Platform
  ): TryResult {
    const entry = this.store.get(incidentId);
    if (!entry) return 'not_found';

    // Synchronous check-and-set — atomic in JS single-threaded event loop
    if (entry.status !== 'PENDING') return 'already_handled';

    if (new Date(entry.expiresAt).getTime() < Date.now()) {
      entry.status = 'EXPIRED';
      this.store.set(incidentId, entry);
      return 'expired';
    }

    entry.status = 'APPROVED';
    entry.lockedBy = userId;
    entry.lockedAt = new Date().toISOString();
    entry.lockedVia = via;
    this.store.set(incidentId, entry);
    return 'ok';
  }

  /**
   * Atomically attempt to reject an incident.
   *
   * Returns:
   *   'ok'              — rejection recorded; caller should notify brain
   *   'already_handled' — another platform already acted on this incident
   *   'not_found'       — incidentId unknown
   */
  tryReject(
    incidentId: string,
    userId: string,
    via: Platform,
    reason: string
  ): TryResult {
    const entry = this.store.get(incidentId);
    if (!entry) return 'not_found';

    if (entry.status !== 'PENDING') return 'already_handled';

    entry.status = 'REJECTED';
    entry.lockedBy = userId;
    entry.lockedAt = new Date().toISOString();
    entry.lockedVia = via;
    entry.rejectionReason = reason;
    this.store.set(incidentId, entry);
    return 'ok';
  }

  /** Replace the remediation plan on a pending approval (operator suggestion). */
  updatePlan(
    incidentId: string,
    plan: ApprovalRequest['plan'],
    meta?: { humanSuggestion?: string; planSource?: 'bot' | 'human' }
  ): boolean {
    const entry = this.store.get(incidentId);
    if (!entry || entry.status !== 'PENDING') return false;
    entry.request.plan = plan;
    if (meta?.humanSuggestion !== undefined) {
      entry.request.humanSuggestion = meta.humanSuggestion;
    }
    if (meta?.planSource) {
      entry.request.planSource = meta.planSource;
    }
    this.store.set(incidentId, entry);
    return true;
  }

  /** Update status of an incident (e.g. to DONE or FAILED after remediation). */
  updateStatus(incidentId: string, status: ApprovalStatus): void {
    const entry = this.store.get(incidentId);
    if (entry) {
      entry.status = status;
      this.store.set(incidentId, entry);
    }
  }

  /** Prune entries older than 24 hours to prevent unbounded growth. */
  pruneOld(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    for (const [id, entry] of this.store.entries()) {
      if (new Date(entry.expiresAt).getTime() < cutoff) {
        this.store.delete(id);
      }
    }
  }
}

// Singleton — shared across all modules in this process
export const approvalStore = new ApprovalStore();

// Run prune every hour
setInterval(() => approvalStore.pruneOld(), 60 * 60 * 1_000).unref();
