/**
 * Run timeline + success banner (mirrors shared tool-user-labels / run-end-state for the UI).
 */

export function formatToolDisplayLabel(tool: string, planAction?: string): string {
  const labels: Record<string, string> = {
    'investigator.repo_inspect': 'Reviewed repository for deploy instructions',
    'gitops.apply_plan': 'Applied changes to the cluster',
    'investigator.verify_health': 'Checked that workloads are healthy',
    'executor.restart_workload': 'Restarted the workload',
    'argo.wait_sync': 'Waited for Argo CD to sync',
    'argo.rollout_promote': 'Promoted the rollout',
    'commander.notify': 'Sent you an update',
  };
  const planLabels: Record<string, string> = {
    repo_apply: 'Deployed to the cluster',
    git_patch: 'Applied a configuration fix',
    helm_deploy: 'Installed via Helm / GitOps',
    restart: 'Restarted the workload',
  };
  if (tool === 'gitops.apply_plan' && planAction && planLabels[planAction]) {
    return planLabels[planAction]!;
  }
  return labels[tool] ?? tool.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatToolSummaryDetail(
  tool: string,
  summary?: string,
  planAction?: string
): string | undefined {
  const details: Record<string, string> = {
    repo_apply: 'Charts and manifests were applied to your cluster.',
    git_patch: 'Configuration was updated on the cluster.',
    helm_deploy: 'Helm release was registered or upgraded.',
    restart: 'Workload restart completed.',
    healthy: 'All checked components are ready.',
    degraded: 'Some components are not ready yet.',
    repo_inspect: 'Located deploy entry point in the repository.',
  };
  if (!summary?.trim()) {
    if (tool === 'gitops.apply_plan' && planAction && details[planAction]) return details[planAction];
    return undefined;
  }
  const raw = summary.trim();
  if (details[raw]) return details[raw];
  if (tool === 'gitops.apply_plan' && raw === planAction && planAction && details[planAction]) {
    return details[planAction];
  }
  if (raw.startsWith('Found ') || raw.startsWith('No manifests')) return raw;
  if (raw.startsWith('argo-sync:')) {
    const status = raw.slice('argo-sync:'.length);
    return status === 'Synced' ? 'Application synced successfully' : `Sync status: ${status}`;
  }
  if (/^Release ".+" ready —/.test(raw)) return raw;
  return raw.slice(0, 300);
}

export function formatToolPipelineLabel(tools: string[], planAction?: string): string {
  return tools.map((t) => formatToolDisplayLabel(t, planAction)).join(' → ');
}

interface VerifySnapshot {
  healthy?: boolean;
  namespace?: string;
  releaseName?: string;
  message?: string;
  readyReplicas?: number;
  desiredReplicas?: number;
}

interface DeployWorkloadRef {
  resourceName: string;
}

interface DeployReleaseTargets {
  workloads?: DeployWorkloadRef[];
}

function parseReadyParts(message: string): Array<{ name: string; ready: string }> {
  const dash = message.indexOf(' — ');
  if (dash < 0) return [];
  return message
    .slice(dash + 3)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.+?)\s+(\d+\/\d+)$/);
      if (m) return { name: m[1]!.trim(), ready: m[2]! };
      return { name: part, ready: '' };
    });
}

export function formatRunSuccessBanner(run: Record<string, unknown>): string | null {
  if (String(run.status) !== 'succeeded') return null;

  const meta = (run.metadata as Record<string, unknown> | undefined) ?? {};
  const request = meta.request as Record<string, unknown> | undefined;
  const mode = String(meta.mode ?? request?.mode ?? '');
  const namespace = String(request?.namespace ?? '');
  const releaseName = String(request?.resourceName ?? '');
  const verify = meta.verifySnapshot as VerifySnapshot | undefined;

  const targetsRaw = meta.deployReleaseTargets;
  const targetsList = Array.isArray(targetsRaw)
    ? (targetsRaw as DeployReleaseTargets[])
    : targetsRaw
      ? [targetsRaw as DeployReleaseTargets]
      : [];
  const workloads = targetsList.flatMap((t) => t.workloads ?? []);

  const transcript = (run.transcript as Array<{ tool?: string; success?: boolean; summary?: string; error?: string }>) ?? [];
  const verifyEntry = [...transcript].reverse().find((e) => e.tool === 'investigator.verify_health');
  const verifyOk = verify?.healthy ?? verifyEntry?.success;

  if (mode !== 'pre-deploy' && !verifyOk) return null;

  const ns = verify?.namespace || namespace;
  const app = verify?.releaseName || releaseName || 'the app';
  const lines: string[] = [`Deploy complete — ${app} is running${ns ? ` in ${ns}` : ''}.`];

  const ready = verify?.readyReplicas;
  const desired = verify?.desiredReplicas;
  if (ready != null && desired != null && desired > 0) {
    lines.push(`All components report ready (${ready}/${desired} replicas).`);
  }

  const verifyMsg = verify?.message ?? verifyEntry?.error ?? verifyEntry?.summary;
  const parts = verifyMsg ? parseReadyParts(verifyMsg) : [];
  const byName = new Map(parts.map((p) => [p.name, p.ready]));

  const items =
    workloads.length > 0
      ? workloads.map((w) => {
          const r = byName.get(w.resourceName);
          return r ? `${w.resourceName} (${r} ready)` : w.resourceName;
        })
      : parts.map((p) => (p.ready ? `${p.name} (${p.ready} ready)` : p.name));

  if (items.length > 0) {
    lines.push('', 'Running now:', ...items.slice(0, 10).map((x) => `• ${x}`));
  }

  if (ns) {
    lines.push('', `kubectl get pods -n ${ns}`);
  }

  return lines.join('\n');
}
