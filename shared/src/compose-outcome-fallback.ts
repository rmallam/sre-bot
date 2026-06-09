/**
 * UX-18 — Deterministic chat templates (no LLM). Used in tests and when polish is off.
 */

import type {
  ChoicePromptOutcome,
  ClusterGetOutcome,
  CommandOutcome,
  ComposeOptions,
  HealthOutcome,
} from './command-outcome.js';
import type { WorkloadStatusFacts } from './workload-status.js';

function joinParagraphs(parts: string[]): string {
  return parts.filter(Boolean).join('\n\n').trim();
}

function formatUndeploy(outcome: Extract<CommandOutcome, { kind: 'undeploy' }>, verbose: boolean): string {
  const { payload: p, userHint, ok } = outcome;
  const name = p.releaseName;
  const ns = p.namespace;
  const hint = userHint && userHint.toLowerCase() !== name.toLowerCase() ? userHint : undefined;

  const nothing =
    !p.found.deployment && !p.found.helmRelease && p.found.labeledResources === 0;

  if (!ok && nothing) {
    const subj = hint ? `**${hint}**` : `**${name}**`;
    return joinParagraphs([
      `I couldn't find ${subj} in **${ns}**.`,
      verbose
        ? 'I looked for a Helm release, Deployment, Service, and matching app labels — nothing matched.'
        : `Try \`get deployments in ${ns}\` to see what's running.`,
    ]);
  }

  if (!ok && p.incomplete) {
    return joinParagraphs([
      `I wasn't able to fully remove **${name}** in **${ns}** — it may still be terminating.`,
      `Check \`get pods -n ${ns}\` in a moment.`,
    ]);
  }

  if (!ok) {
    return `Something went wrong removing **${name}** in **${ns}**. Check the cluster and try again.`;
  }

  const lead = hint
    ? `Done — you asked for **${hint}**; I removed **${name}** from **${ns}**.`
    : `Done — I removed **${name}** from **${ns}**.`;

  let how = '';
  if (p.found.helmRelease && !p.found.deployment) {
    how = 'It was installed as a Helm release.';
  } else if (p.found.deployment && !p.found.helmRelease) {
    how = 'It was a plain kubectl Deployment (no Helm release with that name).';
  } else if (p.found.helmRelease && p.found.deployment) {
    how = 'It had both a Helm release and a Deployment with this name.';
  } else {
    how = 'It was only resources with matching app labels.';
  }

  if (!verbose) {
    const did: string[] = [];
    if (p.actions.some((a) => a.type === 'helm_uninstalled')) did.push('uninstalled the Helm release');
    if (p.actions.some((a) => a.type === 'deployment_deleted')) did.push('deleted the Deployment');
    if (p.actions.some((a) => a.type === 'deployment_removed_by_helm')) {
      did.push('the Deployment was removed by Helm');
    }
    if (p.actions.some((a) => a.type === 'service_deleted')) did.push('deleted the Service');
    const actionLine =
      did.length > 0 ? `I ${did.join(', ')}.` : 'Cleanup finished.';
    return joinParagraphs([lead, how, actionLine, 'Pods should finish terminating shortly.']);
  }

  const bullets: string[] = [];
  for (const a of p.actions) {
    switch (a.type) {
      case 'helm_uninstalled':
        bullets.push(`Uninstalled Helm release **${name}**`);
        break;
      case 'deployment_deleted':
        bullets.push(`Deleted Deployment **${name}**`);
        break;
      case 'deployment_removed_by_helm':
        bullets.push(`Deployment **${name}** was removed by Helm`);
        break;
      case 'service_deleted':
        bullets.push(`Deleted Service **${name}**`);
        break;
      case 'labeled_resources_deleted':
        bullets.push(
          `Removed ${a.count ?? 'some'} resource(s) with label app.kubernetes.io/instance=${name}`
        );
        break;
      case 'action_failed':
        bullets.push(`⚠️ ${a.detail ?? 'A step failed'}`);
        break;
      default:
        break;
    }
  }
  for (const s of p.skipped) {
    if (s.reason === 'not_present') {
      const label =
        s.type === 'helm'
          ? 'Helm'
          : s.type === 'deployment'
            ? 'Deployment'
            : s.type === 'service'
              ? 'Service'
              : 'Labeled resources';
      bullets.push(`${label} — not present (skipped)`);
    }
  }

  return joinParagraphs([
    lead,
    how,
    bullets.length > 0 ? bullets.map((b) => `• ${b}`).join('\n') : '',
    `Verify with \`get pods -n ${ns}\`.`,
  ]);
}

function formatWorkloadStatus(facts: WorkloadStatusFacts, verbose: boolean): string {
  if (facts.scope === 'cluster' && facts.matches) {
    const matches = facts.matches;
    if (matches.length === 0) {
      return `I didn't find **${facts.resourceName}** running in any namespace.`;
    }
    const healthy = matches.filter((m) => m.healthy);
    if (healthy.length === 1 && !verbose) {
      const m = healthy[0]!;
      return `Yes — **${m.resourceName}** is running in **${m.namespace}** (${m.readyReplicas ?? '?'}/${m.desiredReplicas ?? '?'} ready).`;
    }
    if (healthy.length > 0 && !verbose) {
      const nsList = healthy.map((m) => m.namespace).join(', ');
      return `Yes — **${facts.resourceName}** is running in: ${nsList}.`;
    }
    const lines = [`**${facts.resourceName}** across namespaces:`, ''];
    for (const m of matches.slice(0, verbose ? 12 : 6)) {
      const icon = m.healthy ? '✅' : '⚠️';
      lines.push(
        `${icon} **${m.namespace}/${m.resourceName}** — ${m.readyReplicas ?? '?'}/${m.desiredReplicas ?? '?'} ready`
      );
    }
    return lines.join('\n');
  }

  const target = `${facts.namespace}/${facts.resourceName}`;
  if (facts.resourceKind === 'Pod') {
    const pod = facts.pods[0];
    if (!pod) {
      return `No — pod **${facts.resourceName}** isn't in **${facts.namespace}**.`;
    }
    if (pod.phase === 'Running' && !pod.ready.startsWith('0/')) {
      return `Yes — pod **${pod.name}** is running in **${facts.namespace}** (${pod.ready} ready).`;
    }
    return `**${pod.name}** in **${facts.namespace}** is ${pod.phase} (${pod.ready} ready).`;
  }

  if (facts.healthy) {
    if (!verbose) {
      return `Yes — **${target}** is running (${facts.readyReplicas}/${facts.desiredReplicas} replicas ready).`;
    }
    const lines = [
      `Yes — **${target}** is healthy (${facts.readyReplicas}/${facts.desiredReplicas} replicas ready).`,
      '',
    ];
    for (const p of facts.pods.slice(0, 5)) {
      lines.push(`• **${p.name}** — ${p.phase}, ${p.ready} ready`);
    }
    return lines.join('\n');
  }

  if (facts.desiredReplicas === 0) {
    return `**${facts.resourceName}** exists in **${facts.namespace}** but has 0 desired replicas.`;
  }

  if (!verbose) {
    return `Not fully healthy — **${target}** has ${facts.readyReplicas ?? 0}/${facts.desiredReplicas ?? '?'} replicas ready.`;
  }

  const lines = [
    `**${target}** is not fully healthy (${facts.readyReplicas ?? 0}/${facts.desiredReplicas ?? '?'} ready).`,
    '',
  ];
  for (const p of facts.pods.slice(0, 5)) {
    lines.push(`• **${p.name}** — ${p.phase}, ${p.ready} ready`);
  }
  return lines.join('\n');
}

function extractListingBlock(text: string): string {
  const m = text.match(/```\n?([\s\S]*?)```/);
  if (m) return m[1]!.trim();
  return text.trim();
}

function formatClusterGet(data: ClusterGetOutcome, verbose: boolean): string {
  const titleLine =
    data.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('```')) ?? `📋 ${data.resource}`;
  const listing = extractListingBlock(data.text);
  const lines = listing.split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0] ?? '';
  const rows = lines.slice(1);
  const maxRows = verbose ? rows.length : 20;
  const body = [header, ...rows.slice(0, maxRows)].join('\n');
  const suffix =
    !verbose && rows.length > maxRows
      ? `\n… and ${rows.length - maxRows} more. Say **more detail** for the full list.`
      : '';

  return joinParagraphs([titleLine, '```', `${body}${suffix}`, '```']);
}

function formatEventInvestigation(data: import('./k8s-event-investigation.js').EventInvestigationOutcome): string {
  const statusLine = data.clusterHealthy
    ? '**Cluster is healthy right now** — nodes Ready, no failing workloads detected.'
    : '**Cluster has active problems** — see current state below.';

  const severityLabel =
    data.severity === 'benign'
      ? 'Low impact'
      : data.severity === 'warning'
        ? 'Warning'
        : 'Needs attention';

  const lines = [
    `**${data.title}** (${severityLabel})`,
    '',
    statusLine,
    '',
    `**Event:** \`${data.reason}\`${data.message ? ` — ${data.message.slice(0, 200)}` : ''}`,
    '',
    data.explanation,
    '',
    `**Recommendation:** ${data.recommendation}`,
  ];

  if (data.currentNotes.length > 0) {
    lines.push('', '**Current cluster state (just checked):**');
    for (const n of data.currentNotes) {
      lines.push(`• ${n}`);
    }
  }

  return lines.join('\n').slice(0, 3900);
}

function formatHealth(data: HealthOutcome, verbose: boolean): string {
  if (data.clusterReachable === false) {
    return joinParagraphs([
      `⚠️ I can't reach a live Kubernetes cluster for **${data.label}**.`,
      data.summary?.trim() ??
        'The API returned no nodes or refused the connection — the cluster may be stopped or kubeconfig may be wrong.',
      'Start or reconnect the cluster, then ask again (e.g. *investigate cluster health*).',
    ]);
  }

  const lines: string[] = [];
  lines.push(`Here's the health picture for **${data.label}**.`);

  if (data.summary?.trim()) {
    lines.push(data.summary.trim());
  }

  if (data.warnings.length > 0) {
    const limit = verbose ? 6 : 3;
    lines.push('');
    lines.push(
      data.warnings.length === 1 ? 'One warning stood out:' : 'Recent warnings:'
    );
    for (const w of data.warnings.slice(0, limit)) {
      lines.push(`• ${w.reason}: ${w.message.slice(0, verbose ? 200 : 120)}`);
    }
  } else if (!data.summary?.trim()) {
    lines.push('The quick scan looks quiet — no warnings jumped out.');
  }

  if (verbose && data.deployments.length > 0 && data.deployments.length <= 12) {
    lines.push('');
    lines.push(`Deployments: ${data.deployments.slice(0, 12).join(', ')}`);
  }

  if (!verbose) {
    lines.push('');
    lines.push('Ask about a specific app to dig deeper, e.g. *investigate nginx in default*.');
  } else if (data.evidence?.trim()) {
    lines.push('');
    lines.push(data.evidence.trim().slice(0, 900));
  }

  return lines.join('\n').slice(0, 3900);
}

function formatAppReview(data: import('./command-outcome.js').AppReviewOutcome, verbose: boolean): string {
  if (data.clusterReachable === false) {
    return joinParagraphs([
      `⚠️ I can't reach the Kubernetes cluster to review app **${data.appId}**.`,
      data.error ?? 'Check that the cluster is running and investigator can access the API.',
    ]);
  }

  if (!data.reachable) {
    return joinParagraphs([
      `I couldn't find app **${data.appId}** in namespace **${data.namespace}**.`,
      'Check the app name or add `sre.bot/app-id` on the Deployment.',
    ]);
  }

  const statusEmoji =
    data.overallStatus === 'ok' ? '✅' : data.overallStatus === 'degraded' ? '⚠️' : '❌';

  const lines = [
    `${statusEmoji} **App ${data.appId}** (${data.namespace}) — **${data.overallStatus}**`,
    '',
    data.narrative.replace(/\*\*/g, ''),
  ];

  if (data.frontierName && data.overallStatus !== 'ok') {
    lines.push('');
    lines.push(
      `Likely root cause: **${data.frontierKind ?? 'component'}** \`${data.frontierName}\`${data.frontierDetail ? ` — ${data.frontierDetail}` : ''}`
    );
  }

  if (verbose && data.nodeCount > 0) {
    lines.push('', `Tracked ${data.nodeCount} component(s) in the app graph.`);
  }

  if (!verbose && data.overallStatus !== 'ok') {
    lines.push('', 'Say *fix it* or *investigate* with the component name to start remediation.');
  }

  return lines.join('\n').slice(0, 3900);
}

function formatChoicePrompt(data: ChoicePromptOutcome): string {
  const lines = data.options.map((o, i) => `${i + 1}. ${o.label}`);
  return joinParagraphs([
    `I found a few matches for **${data.subject}** — which one did you mean?`,
    lines.join('\n'),
    'Reply with a number, or **cancel**.',
  ]);
}

function formatNotFound(subject: string, namespace?: string, context?: string): string {
  const where = namespace ? ` in **${namespace}**` : '';
  return joinParagraphs([
    `I couldn't find **${subject}**${where}.`,
    context ?? 'Try a more specific name or a different namespace.',
  ]);
}

export function formatCommandOutcomeFallback(
  outcome: CommandOutcome,
  opts: ComposeOptions = {}
): string {
  const verbose = opts.verbose === true;

  switch (outcome.kind) {
    case 'undeploy':
      return formatUndeploy(outcome, verbose);
    case 'workload_status':
      return formatWorkloadStatus(outcome.facts, verbose);
    case 'cluster_get':
      return formatClusterGet(outcome.data, verbose);
    case 'health':
      return formatHealth(outcome.data, verbose);
    case 'event_investigation':
      return formatEventInvestigation(outcome.data);
    case 'app_review':
      return formatAppReview(outcome.data, verbose);
    case 'not_found':
      return formatNotFound(outcome.subject, outcome.namespace, outcome.context);
    case 'choice_prompt':
      return formatChoicePrompt(outcome.data);
    case 'plain':
      return outcome.text;
    default:
      return "Here's what I found.";
  }
}
