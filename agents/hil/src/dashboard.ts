/**
 * src/dashboard.ts
 *
 * Renders the HIL Web Dashboard as a complete self-contained HTML page.
 * Auto-refreshes every 10 seconds via <meta http-equiv="refresh">.
 * Dark theme with severity badges, patch diffs, countdown timers, and
 * escalation banners.
 */

import type { PendingApproval } from './store.js';
import type { JsonPatchOp } from '../../../shared/src/types.js';

function severityColor(sev: string): string {
  switch (sev) {
    case 'CRITICAL': return '#ff4444';
    case 'HIGH':     return '#ff8800';
    case 'MEDIUM':   return '#ffcc00';
    case 'LOW':      return '#44cc44';
    default:         return '#888888';
  }
}

function severityTextColor(sev: string): string {
  return sev === 'MEDIUM' || sev === 'LOW' ? '#000' : '#fff';
}

function statusColor(status: string): string {
  switch (status) {
    case 'PENDING':  return '#ffcc00';
    case 'APPROVED': return '#44cc44';
    case 'REJECTED': return '#ff4444';
    case 'IGNORED':  return '#6688aa';
    case 'EXPIRED':  return '#888888';
    default:         return '#aaaaaa';
  }
}

function formatCountdown(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return '⏰ EXPIRED';
  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);
  return `⏱ ${mins}m ${secs}s remaining`;
}

function renderPatch(ops: JsonPatchOp[]): string {
  return ops
    .map((op) => {
      const valStr =
        op.value !== undefined ? ` = ${JSON.stringify(op.value)}` : '';
      let lineClass = 'patch-neutral';
      if (op.op === 'add')     lineClass = 'patch-add';
      if (op.op === 'remove')  lineClass = 'patch-remove';
      if (op.op === 'replace') lineClass = 'patch-replace';
      return `<div class="${lineClass}">${op.op.padEnd(7)} ${op.path}${valStr}</div>`;
    })
    .join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCard(approval: PendingApproval): string {
  const { request, status, expiresAt, lockedBy, lockedVia, lockedAt, rejectionReason } = approval;
  const { plan, incidentId, resourceName, namespace, resourceKind, escalated } = request;
  const isPending = status === 'PENDING';
  const countdown = isPending ? formatCountdown(expiresAt) : '';

  const escalationBanner = escalated
    ? `<div class="escalation-banner">⚠️ ESCALATED — Circuit breaker fired. Human action required.</div>`
    : '';

  const humanNote = request.humanSuggestion
    ? `<div class="section-label">Your suggestion</div><div class="reasoning">${escapeHtml(request.humanSuggestion)}</div>`
    : '';

  const actionButtons = isPending
    ? `
      <form method="POST" action="/approve/${encodeURIComponent(incidentId)}" style="display:inline">
        <button type="submit" class="btn-approve">✅ Approve</button>
      </form>
      <form method="POST" action="/reject/${encodeURIComponent(incidentId)}" style="display:inline">
        <input type="hidden" name="reason" value="Rejected via web dashboard" />
        <button type="submit" class="btn-reject">❌ Reject</button>
      </form>
      <form method="POST" action="/ignore/${encodeURIComponent(incidentId)}" style="display:inline">
        <input type="hidden" name="reason" value="Ignored via web dashboard" />
        <button type="submit" class="btn-ignore">🔕 Ignore</button>
      </form>
      <div class="suggest-box">
        <div class="section-label">✏️ Suggest your own fix</div>
        <form method="POST" action="/suggest-fix/${encodeURIComponent(incidentId)}">
          <textarea name="suggestion" rows="3" placeholder="e.g. restart deployment, add imagePullSecrets ghcr-creds, set image to app:v2" required></textarea>
          <button type="submit" name="apply" value="0" class="btn-suggest">Update plan from suggestion</button>
          <button type="submit" name="apply" value="1" class="btn-approve">Apply suggestion now</button>
        </form>
      </div>`
    : `<div class="handled-badge" style="background:${statusColor(status)}; color:#fff">
        ${status}${lockedBy ? ` by ${lockedBy}` : ''}${lockedVia ? ` via ${lockedVia}` : ''}${lockedAt ? ` at ${new Date(lockedAt).toLocaleTimeString()}` : ''}
       </div>`;

  return `
  <div class="card ${escalated ? 'escalated' : ''}">
    ${escalationBanner}
    <div class="card-header">
      <div class="card-title">
        <span class="resource-name">${resourceKind}/${resourceName}</span>
        <span class="namespace-badge">${namespace}</span>
        <span class="severity-badge" style="background:${severityColor(plan.severity)};color:${severityTextColor(plan.severity)}">${plan.severity}</span>
        <span class="status-badge" style="background:${statusColor(status)};color:${status === 'PENDING' ? '#000' : '#fff'}">${status}</span>
      </div>
      <div class="incident-id">🔑 ${incidentId}</div>
      ${isPending ? `<div class="countdown">${countdown}</div>` : ''}
    </div>

    <div class="card-body">
      <div class="section-label">Root Cause</div>
      <div class="root-cause">${plan.rootCause}</div>

      <div class="section-label">Reasoning</div>
      <div class="reasoning">${plan.reasoning}</div>
      ${humanNote}
      ${request.planSource === 'human' ? '<div class="meta-row"><span>Plan source: <strong>operator suggestion</strong></span></div>' : ''}

      <div class="section-label">Proposed Patch — <code>${plan.targetManifestPath}</code></div>
      <div class="patch-block">
        ${renderPatch(plan.proposedPatch)}
      </div>

      <div class="section-label">Commit Message</div>
      <div class="commit-msg">${plan.commitMessage}</div>

      <div class="meta-row">
        <span>Rollback Safe: <strong>${plan.rollbackSafe ? '✅ Yes' : '❌ No'}</strong></span>
        <span>Attempt: <strong>#${request.attemptNumber}</strong></span>
        <span>CB Limit: <strong>${request.circuitBreakerLimit}</strong></span>
      </div>

      ${rejectionReason ? `<div class="rejection-reason">Rejection reason: ${rejectionReason}</div>` : ''}
    </div>

    <div class="card-footer">
      ${actionButtons}
    </div>
  </div>`;
}

export function renderDashboard(
  approvals: PendingApproval[],
  ignored: import('../../../shared/src/incident-ignore.js').IgnoredResource[] = []
): string {
  const pending = approvals.filter((a) => a.status === 'PENDING').length;
  const cards = approvals.length === 0
    ? '<div class="empty-state">🎉 No pending approvals. All quiet.</div>'
    : approvals
        // Sort: escalated first, then by expiry
        .sort((a, b) => {
          if (a.request.escalated !== b.request.escalated)
            return a.request.escalated ? -1 : 1;
          return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
        })
        .map(renderCard)
        .join('\n');

  const ignoredPanel =
    ignored.length > 0
      ? `<div class="ignored-panel">
          <div class="section-label">🔕 Ignored resources (won't be remediated again)</div>
          ${ignored
            .map(
              (i) =>
                `<div class="ignored-row">
                  <span><code>${escapeHtml(i.key)}</code> — since ${new Date(i.ignoredAt).toLocaleString()}</span>
                  <form method="POST" action="/unignore/${encodeURIComponent(i.key)}" style="display:inline">
                    <button type="submit" class="btn-ignore">Unignore</button>
                  </form>
                </div>`
            )
            .join('')}
        </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="10" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HIL Dashboard — Kube SRE</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      padding: 1.5rem;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #21262d;
    }

    header h1 { font-size: 1.5rem; color: #58a6ff; }
    header .subtitle { font-size: 0.85rem; color: #8b949e; margin-top: 0.2rem; }
    header .badge-count {
      background: ${pending > 0 ? '#ff8800' : '#238636'};
      color: #fff;
      border-radius: 2rem;
      padding: 0.25rem 0.75rem;
      font-size: 0.85rem;
      font-weight: 600;
    }

    .refresh-note {
      font-size: 0.75rem;
      color: #8b949e;
      margin-bottom: 1.5rem;
    }

    .card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      margin-bottom: 1.25rem;
      overflow: hidden;
      transition: border-color 0.2s;
    }

    .card.escalated {
      border-color: #ff8800;
      box-shadow: 0 0 0 1px #ff880055;
    }

    .escalation-banner {
      background: #ff880022;
      color: #ff8800;
      font-weight: 600;
      font-size: 0.9rem;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid #ff880044;
    }

    .card-header {
      padding: 1rem 1.25rem 0.75rem;
      border-bottom: 1px solid #21262d;
    }

    .card-title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.35rem;
    }

    .resource-name {
      font-size: 1.05rem;
      font-weight: 600;
      color: #e6edf3;
    }

    .namespace-badge {
      background: #1f3a5c;
      color: #58a6ff;
      font-size: 0.75rem;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-family: monospace;
    }

    .severity-badge, .status-badge {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 0.15rem 0.55rem;
      border-radius: 4px;
      letter-spacing: 0.04em;
    }

    .incident-id {
      font-family: monospace;
      font-size: 0.78rem;
      color: #8b949e;
    }

    .countdown {
      font-size: 0.8rem;
      color: #f0883e;
      margin-top: 0.25rem;
      font-weight: 600;
    }

    .card-body {
      padding: 1rem 1.25rem;
    }

    .section-label {
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: #8b949e;
      margin: 0.85rem 0 0.3rem;
    }

    .section-label:first-child { margin-top: 0; }

    .root-cause, .reasoning {
      color: #e6edf3;
      font-size: 0.9rem;
      line-height: 1.55;
    }

    .patch-block {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      overflow-x: auto;
    }

    .patch-add     { color: #3fb950; }
    .patch-remove  { color: #f85149; }
    .patch-replace { color: #58a6ff; }
    .patch-neutral { color: #c9d1d9; }

    .commit-msg {
      font-family: monospace;
      font-size: 0.85rem;
      color: #79c0ff;
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      margin-top: 0.75rem;
      font-size: 0.82rem;
      color: #8b949e;
    }

    .rejection-reason {
      margin-top: 0.6rem;
      font-size: 0.82rem;
      color: #f85149;
      font-style: italic;
    }

    .card-footer {
      padding: 0.75rem 1.25rem;
      background: #0d1117;
      border-top: 1px solid #21262d;
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }

    .suggest-box {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #30363d;
    }
    .suggest-box textarea {
      width: 100%;
      margin: 8px 0;
      padding: 8px;
      background: #0d1117;
      color: #e6edf3;
      border: 1px solid #30363d;
      border-radius: 6px;
      font-family: inherit;
      resize: vertical;
    }
    .btn-suggest {
      background: #1f6feb;
      color: #fff;
      border: none;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      margin-right: 8px;
    }
    .btn-approve, .btn-reject, .btn-ignore {
      padding: 0.45rem 1.1rem;
      border: none;
      border-radius: 6px;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }

    .btn-approve { background: #238636; color: #fff; }
    .btn-approve:hover { opacity: 0.85; }
    .btn-reject  { background: #da3633; color: #fff; }
    .btn-reject:hover  { opacity: 0.85; }
    .btn-ignore  { background: #484f58; color: #fff; }
    .btn-ignore:hover  { opacity: 0.85; }
    .ignored-panel { margin: 1.5rem 0; padding: 1rem; background: #161b22; border-radius: 8px; border: 1px solid #30363d; }
    .ignored-row { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #21262d; font-size: 0.9rem; }

    .handled-badge {
      display: inline-block;
      padding: 0.3rem 0.75rem;
      border-radius: 4px;
      font-size: 0.82rem;
      font-weight: 600;
    }

    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: #8b949e;
      font-size: 1.1rem;
    }

    code {
      font-family: monospace;
      font-size: 0.85em;
      background: #21262d;
      padding: 0.1em 0.35em;
      border-radius: 3px;
      color: #79c0ff;
    }
  </style>
  <script>
    // Update countdown timers client-side without waiting for meta refresh
    (function() {
      function updateCountdowns() {
        document.querySelectorAll('[data-expires]').forEach(function(el) {
          var expires = parseInt(el.getAttribute('data-expires'), 10);
          var remaining = expires - Date.now();
          if (remaining <= 0) {
            el.textContent = '⏰ EXPIRED';
            return;
          }
          var mins = Math.floor(remaining / 60000);
          var secs = Math.floor((remaining % 60000) / 1000);
          el.textContent = '⏱ ' + mins + 'm ' + secs + 's remaining';
        });
      }
      setInterval(updateCountdowns, 1000);
    })();
  </script>
</head>
<body>
  <header>
    <div>
      <h1>🛡️ HIL Approval Dashboard</h1>
      <div class="subtitle">Kube SRE Framework — Human-in-the-Loop</div>
    </div>
    <div class="badge-count">${pending} pending</div>
  </header>
  <div class="refresh-note">Auto-refreshes every 10 seconds. Last rendered: ${new Date().toUTCString()}</div>
  ${ignoredPanel}
  ${cards}
</body>
</html>`;
}
