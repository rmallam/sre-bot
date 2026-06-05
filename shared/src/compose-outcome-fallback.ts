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

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').trim();
}

function formatClusterGet(data: ClusterGetOutcome, verbose: boolean): string {
  const where = data.namespace ? ` in **${data.namespace}**` : '';
  const headline = `Here are **${data.resource}**${where} (${data.shown} of ${data.total} shown).`;

  if (!verbose) {
    const stripped = stripCodeFences(data.text);
    const rows = stripped
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('Showing') && !l.includes('```'));
    const preview = rows.slice(0, 4).join('\n');
    if (preview.length > 20) {
      return joinParagraphs([headline, preview, 'Say **more detail** for the full table.']);
    }
    return joinParagraphs([headline, data.text.slice(0, 800)]);
  }

  return joinParagraphs([headline, data.text]);
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
