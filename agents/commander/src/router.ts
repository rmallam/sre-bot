import { v4 as uuidv4 } from 'uuid';
import { formatFetchError, postWithRetry, log } from '../../../shared/src/http.js';
import type { DeployRequest, DiagnosisContext, Platform, StartRunRequest } from '../../../shared/src/types.js';
import type { HealthOutcome, AppReviewOutcome, UndeployOutcomePayload } from '../../../shared/src/command-outcome.js';
import type { ParsedCommand } from './parser.js';
import { prepareDeleteCommand, storeDeleteChoice } from './delete-choice.js';
import type { ResourceKind } from '../../../shared/src/types.js';
import type { WorkloadStatusFacts } from '../../../shared/src/workload-status.js';
import { setSession, linkRunToSession } from './sessions.js';
import { rememberDeployDraft, rememberWorkloadStatusQuery } from './conversation.js';
import { syncActiveTopicFromCommand } from './active-topic.js';
import { getChannelPref } from './channel-prefs.js';
import { composeUserReply } from './compose-outcome.js';
import { formatRcaPointersForPlan } from '../../../shared/src/rca-pointers.js';
import { buildEventInvestigation } from '../../../shared/src/k8s-event-investigation.js';
import type { ClusterHealthSnapshot } from '../../../shared/src/cluster-health.js';
import type { AppReviewResult } from '../../../shared/src/app-graph.js';
import { subjectFromInvestigate, subjectFromDeploy } from '../../../shared/src/agent-case.js';
import { resolveAgentMode } from '../../../shared/src/agent-mode.js';
import {
  openOrResumeCase,
  bindRunToCase,
  operatorMessageFromCase,
} from './case-manager.js';
import {
  validateDeployCommand,
  validateStartRunRequest,
  formatDeployDispatchError,
} from '../../../shared/src/deploy-command.js';
import {
  evaluateDeployConfidence,
  type DeployRoutingSource,
} from '../../../shared/src/deploy-confidence.js';
import { parseCommand } from './parser.js';

const AGENT = 'commander-agent';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';
const USE_ORCHESTRATOR = (process.env['USE_ORCHESTRATOR'] ?? 'true').toLowerCase() === 'true';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';

export interface CommandHandleResult {
  incidentId: string;
  /** Set for synchronous read-only cluster queries (no orchestrator run). */
  immediateReply?: string;
  /** Inline Approve/Reject for Telegram when a HIL approval is still open. */
  quickActions?: Array<{ id: string; label: string }>;
  /** When orchestrator deduplicated to an in-flight run. */
  existingRunId?: string;
  /** Keep polling chat for run updates (dedupe or async). */
  waitingForRun?: boolean;
}

interface DispatchRunResult {
  started: boolean;
  deduplicated?: boolean;
  existingRunId?: string;
  existingIncidentId?: string;
  existingStatus?: string;
}

async function dispatchRun(payload: StartRunRequest, incidentId: string): Promise<DispatchRunResult> {
  const preflight = validateStartRunRequest(payload);
  if (!preflight.ok) {
    throw new Error(preflight.userMessage);
  }

  if (USE_ORCHESTRATOR) {
    const url = `${ORCHESTRATOR_URL}/runs`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      accepted?: boolean;
      deduplicated?: boolean;
      existingRunId?: string;
      existingIncidentId?: string;
      existingStatus?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(
        formatDeployDispatchError(
          new Error(data.error ?? `Orchestrator rejected run (${res.status})`),
          payload
        )
      );
    }
    log('info', AGENT, data.deduplicated ? 'Run deduplicated' : 'POST OK', {
      incidentId,
      url,
      deduplicated: data.deduplicated,
      existingRunId: data.existingRunId,
      existingStatus: data.existingStatus,
    });
    if (data.deduplicated) {
      return {
        started: false,
        deduplicated: true,
        existingRunId: data.existingRunId,
        existingIncidentId: data.existingIncidentId,
        existingStatus: data.existingStatus,
      };
    }
    return { started: true };
  }
  if (payload.mode === 'pre-deploy') {
    await postWithRetry({
      url: `${INVESTIGATOR_URL}/pre-deploy`,
      payload: payload as DeployRequest,
      incidentId,
      callerAgent: AGENT,
    });
  } else {
    await postWithRetry({
      url: `${INVESTIGATOR_URL}/investigate`,
      payload,
      incidentId,
      callerAgent: AGENT,
    });
  }
  return { started: true };
}

function isActiveRunStatus(status?: string): boolean {
  return status === 'running' || status === 'awaiting_human';
}

async function buildDedupeRunReply(
  result: DispatchRunResult,
  parsed: import('./parser.js').InvestigateCmd
): Promise<string> {
  const runRef = result.existingRunId ?? result.existingIncidentId ?? 'existing run';
  const target = `**${parsed.namespace}/${parsed.resourceName}**`;

  if (result.existingStatus === 'awaiting_human') {
    const imageHint = parsed.operatorSuggestion ? `\nYour hint: \`${parsed.operatorSuggestion}\`.` : '';
    return (
      `⏸️ A fix for ${target} is waiting for your approval (\`${runRef}\`).` +
      `${imageHint}\n\nUse **Approve/Reject** below, or reply **cancel run** to clear and start over.`
    );
  }

  let progress = '';
  if (result.existingRunId) {
    try {
      const detail = await fetchRunDetailsText(result.existingRunId, { verbose: false });
      const lines = detail
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4);
      if (lines.length > 0) {
        progress = `\n\n**Current progress:**\n${lines.map((l) => `• ${l.replace(/^#+\s*/, '')}`).join('\n')}`;
      }
    } catch {
      /* optional */
    }
  }

  return (
    `ℹ️ Already investigating ${target} (\`${runRef}\`, status: **${result.existingStatus ?? 'active'}**).` +
    `${progress}\n\n` +
    `Open **View run** for details, **Cancel stuck run** if this looks frozen, or ask **what's happening**.`
  );
}

async function hilQuickActionsForRun(
  incidentId?: string,
  runId?: string
): Promise<Array<{ id: string; label: string }> | undefined> {
  if (!incidentId && !runId) return undefined;
  try {
    const res = await fetch(`${HIL_URL}/api/approvals`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      approvals?: Array<{ incidentId: string; runId?: string; status?: string }>;
    };
    const pending = (data.approvals ?? []).find(
      (a) =>
        a.status === 'PENDING' &&
        (a.incidentId === incidentId || (runId && a.runId === runId))
    );
    if (!pending) return undefined;
    return [
      { id: `hil_approve_${pending.incidentId}`, label: '✅ Approve' },
      { id: `hil_reject_${pending.incidentId}`, label: '❌ Reject' },
      { id: `hil_suggest_${pending.incidentId}`, label: '✏️ Suggest fix' },
    ];
  } catch {
    return undefined;
  }
}

async function fetchUndeploy(
  namespace: string,
  releaseName: string,
  incidentId: string
): Promise<{ ok: boolean; outcome: UndeployOutcomePayload }> {
  const url = `${GITOPS_URL}/undeploy`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, releaseName, incidentId }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw formatFetchError(err, url);
  }
  const data = (await res.json()) as {
    ok?: boolean;
    outcome?: UndeployOutcomePayload;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `POST /undeploy failed ${res.status}`);
  }
  if (!data.outcome) {
    throw new Error('Undeploy returned no outcome payload');
  }
  return { ok: data.ok !== false, outcome: data.outcome };
}

async function fetchClusterGet(
  resource: string,
  namespace: string | undefined,
  incidentId: string
): Promise<{
  text: string;
  resource: string;
  namespace?: string;
  total: number;
  shown: number;
}> {
  const params = new URLSearchParams({ resource, incidentId });
  if (namespace) params.set('namespace', namespace);
  const url = `${INVESTIGATOR_URL}/get?${params}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    const formatted = formatFetchError(err, url);
    if (formatted.message.includes('ENOTFOUND') && formatted.message.includes('investigator-agent')) {
      throw new Error(
        `${formatted.message}. Start the investigator: podman compose up investigator-agent kube-proxy (or full stack: podman compose up)`
      );
    }
    throw formatted;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET /get failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    text?: string;
    resource?: string;
    namespace?: string;
    total?: number;
    shown?: number;
  };
  return {
    text: data.text ?? 'No results.',
    resource,
    namespace,
    total: data.total ?? 0,
    shown: data.shown ?? 0,
  };
}

/** Synchronous cluster/namespace health — report-only, no orchestrator run. */
function healthLabel(parsed: Extract<ParsedCommand, { type: 'investigate' }>): string {
  if (parsed.scope === 'cluster') return 'the cluster';
  if (parsed.scope === 'namespace') return `namespace ${parsed.namespace}`;
  return parsed.label;
}

async function fetchEventInvestigation(
  parsed: Extract<ParsedCommand, { type: 'investigate' }>,
  incidentId: string,
  composeOpts: import('../../../shared/src/command-outcome.js').ComposeOptions
): Promise<string> {
  const reason = parsed.eventReason ?? parsed.label;
  const message = parsed.eventMessage ?? '';

  let snapshot: ClusterHealthSnapshot | null = null;
  try {
    const res = await fetch(`${INVESTIGATOR_URL}/cluster-health?force=true`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      snapshot = (await res.json()) as ClusterHealthSnapshot;
    }
  } catch (err) {
    log('warn', AGENT, 'cluster-health fetch for event investigation failed', {
      incidentId,
      error: String(err),
    });
  }

  const data = buildEventInvestigation({ reason, message, snapshot });
  return composeUserReply({ kind: 'event_investigation', data }, composeOpts);
}

async function loadAppReview(
  parsed: Extract<ParsedCommand, { type: 'investigate' }>
): Promise<AppReviewResult | null> {
  const appId = parsed.resourceName;
  const params = new URLSearchParams({ appId, force: 'true' });
  if (parsed.namespace && parsed.namespace !== '_all' && parsed.namespace !== 'default') {
    params.set('namespace', parsed.namespace);
  }
  try {
    const res = await fetch(`${INVESTIGATOR_URL}/app-review?${params}`, {
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET /app-review failed ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as AppReviewResult;
  } catch {
    return null;
  }
}

function appReviewToOutcome(review: AppReviewResult): AppReviewOutcome {
  const fn = review.frontierNode;
  return {
    appId: review.appId,
    namespace: review.namespace,
    overallStatus: review.overallStatus,
    narrative: review.narrative,
    frontierName: fn?.name,
    frontierKind: fn?.kind,
    frontierDetail: fn?.detail,
    nodeCount: review.graph.nodes.length,
    clusterReachable: review.clusterReachable,
    reachable: review.reachable,
    error: review.error,
  };
}

async function fetchAppReview(
  parsed: Extract<ParsedCommand, { type: 'investigate' }>,
  incidentId: string,
  composeOpts: import('../../../shared/src/command-outcome.js').ComposeOptions
): Promise<string> {
  const review = await loadAppReview(parsed);
  if (!review) {
    const data: AppReviewOutcome = {
      appId: parsed.resourceName,
      namespace: parsed.namespace,
      overallStatus: 'unknown',
      narrative: 'App review request failed',
      nodeCount: 0,
      reachable: false,
      clusterReachable: false,
      error: 'fetch failed',
    };
    return composeUserReply({ kind: 'app_review', data }, composeOpts);
  }
  return composeUserReply({ kind: 'app_review', data: appReviewToOutcome(review) }, composeOpts);
}

function lastAppReviewFromResult(review: AppReviewResult): import('./sessions.js').LastAppReview {
  const fn = review.frontierNode;
  return {
    appId: review.appId,
    namespace: review.namespace,
    overallStatus: review.overallStatus,
    frontierNodeId: review.frontierNodeId,
    frontierName: fn?.name,
    frontierKind: fn?.kind,
    frontierNamespace: fn?.namespace,
    reviewedAt: review.checkedAt,
  };
}

/** Target workload for remediation after app review (frontier deployment/pod). */
function remediationTargetFromAppReview(review: AppReviewResult): {
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
} {
  const fn = review.frontierNode;
  if (fn?.kind === 'deployment' && fn.namespace) {
    return { namespace: fn.namespace, resourceName: fn.name, resourceKind: 'Deployment' };
  }
  if (fn?.kind === 'pod' && fn.namespace) {
    return { namespace: fn.namespace, resourceName: fn.name, resourceKind: 'Pod' };
  }
  return {
    namespace: review.namespace,
    resourceName: review.appId,
    resourceKind: 'Deployment',
  };
}

async function fetchHealthInvestigation(
  parsed: Extract<ParsedCommand, { type: 'investigate' }>,
  incidentId: string
): Promise<HealthOutcome> {
  const params = new URLSearchParams({
    incidentId,
    namespace: parsed.namespace,
    resourceName: parsed.resourceName,
    resourceKind: parsed.resourceKind ?? 'Deployment',
    mode: 'diagnose',
    investigateScope: parsed.scope,
  });
  const url = `${INVESTIGATOR_URL}/facts?${params}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    throw formatFetchError(err, url);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET /facts failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const facts = (await res.json()) as DiagnosisContext;
  const warnings = (facts.recentEvents ?? [])
    .filter((e) => e.type === 'Warning')
    .slice(0, 6)
    .map((e) => ({ reason: e.reason, message: e.message }));

  return {
    label: healthLabel(parsed),
    summary: facts.currentLogs?.trim() || facts.observabilitySummary?.trim(),
    warnings,
    deployments: facts.existingDeployments ?? [],
    evidence:
      facts.observabilitySummary?.trim() ||
      formatRcaPointersForPlan(facts.rcaPointers ?? []).slice(0, 1200) ||
      undefined,
    clusterReachable: facts.clusterReachable,
  };
}

/** Synchronous "is X running?" — no orchestrator run. */
export async function fetchWorkloadStatusReply(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  resourceKind?: ResourceKind;
  podName?: string;
  compose?: import('../../../shared/src/command-outcome.js').ComposeOptions;
}): Promise<string> {
  const params = new URLSearchParams({
    incidentId: opts.incidentId,
    namespace: opts.namespace,
    resourceName: opts.resourceName,
    resourceKind: opts.resourceKind ?? 'Deployment',
  });
  if (opts.podName) params.set('podName', opts.podName);
  const url = `${INVESTIGATOR_URL}/workload-status?${params}`;
  let res: Response;
  try {
    const timeoutMs = opts.namespace === '_all' ? 120_000 : 60_000;
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw formatFetchError(err, url);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET /workload-status failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const facts = (await res.json()) as WorkloadStatusFacts;
  return composeUserReply(
    { kind: 'workload_status', facts },
    opts.compose ?? { incidentId: opts.incidentId }
  );
}

export interface CommandDispatchContext {
  routingConfidence?: number;
  routingSource?: DeployRoutingSource;
  llmRawGithubRepo?: string;
}

export async function handleCommand(
  parsed: ParsedCommand,
  userId: string,
  platform: Platform,
  channelId: string,
  rawMessage: string,
  dispatchCtx?: CommandDispatchContext
): Promise<CommandHandleResult> {
  const incidentId = uuidv4();
  const triggeredAt = new Date().toISOString();

  log('info', AGENT, `Routing command type=${parsed.type}`, { incidentId, platform, userId });

  const composeOpts = {
    verbose: getChannelPref(platform, channelId).verbose,
    incidentId,
    platform,
  };

  switch (parsed.type) {
    case 'get': {
      const data = await fetchClusterGet(parsed.resource, parsed.namespace, incidentId);
      const text = await composeUserReply(
        {
          kind: 'cluster_get',
          data: {
            resource: data.resource,
            namespace: data.namespace,
            text: data.text,
            total: data.total,
            shown: data.shown,
          },
        },
        composeOpts
      );
      return { incidentId, immediateReply: text };
    }
    case 'workload-status': {
      const text = await fetchWorkloadStatusReply({
        incidentId,
        namespace: parsed.namespace,
        resourceName: parsed.resourceName,
        resourceKind: parsed.resourceKind,
        podName: parsed.podName,
        compose: composeOpts,
      });
      await rememberWorkloadStatusQuery(platform, channelId, userId, {
        resourceName: parsed.resourceName,
        resourceKind: parsed.resourceKind,
        namespace: parsed.namespace,
      });
      return { incidentId, immediateReply: text };
    }
    case 'delete': {
      const prep = await prepareDeleteCommand(parsed);
      if (prep.status === 'not_found') {
        const text = await composeUserReply(
          {
            kind: 'not_found',
            subject: parsed.resourceName,
            namespace: parsed.namespace !== '_all' ? parsed.namespace : undefined,
            context: 'Try `get deployments in <namespace>` to see what is running.',
          },
          composeOpts
        );
        return { incidentId, immediateReply: text };
      }
      if (prep.status === 'prompt') {
        storeDeleteChoice(platform, channelId, userId, parsed, parsed.resourceName, prep.candidates);
        const text = await composeUserReply(
          {
            kind: 'choice_prompt',
            data: {
              subject: parsed.resourceName,
              options: prep.candidates.map((c) => ({
                label: c.label,
                score: c.score,
              })),
            },
          },
          composeOpts
        );
        return { incidentId, immediateReply: text };
      }
      const resolved = prep.command;
      const { ok, outcome } = await fetchUndeploy(
        resolved.namespace,
        resolved.resourceName,
        incidentId
      );
      const text = await composeUserReply(
        {
          kind: 'undeploy',
          ok,
          userHint: resolved.userHint,
          payload: outcome,
        },
        composeOpts
      );
      return { incidentId, immediateReply: text };
    }
    case 'deploy': {
      const validated = validateDeployCommand(parsed);
      if (!validated.ok) {
        return { incidentId, immediateReply: validated.userMessage };
      }
      const regexParsed = parseCommand(rawMessage);
      const routingSource =
        dispatchCtx?.routingSource ?? (dispatchCtx === undefined ? 'regex' : 'llm');
      const bypassConfidenceGate =
        routingSource === 'followup' || routingSource === 'clarification';
      if (!bypassConfidenceGate) {
        const confidence = evaluateDeployConfidence({
          rawText: rawMessage,
          deploy: validated.deploy,
          routingConfidence: dispatchCtx?.routingConfidence,
          routingSource,
          regexDeploy: regexParsed.type === 'deploy' ? regexParsed : undefined,
          llmRawGithubRepo: dispatchCtx?.llmRawGithubRepo,
        });
        log('info', AGENT, 'Deploy confidence gate', {
          incidentId,
          ok: confidence.ok,
          score: confidence.score,
          threshold: confidence.threshold,
          reasons: confidence.reasons,
          routingSource,
        });
        if (!confidence.ok) {
          return { incidentId, immediateReply: confidence.clarifyMessage! };
        }
      }
      const deploy = validated.deploy;
      const appName = validated.appName;
      const agentCase = await openOrResumeCase({
        platform,
        channelId,
        userId,
        subject: subjectFromDeploy({
          namespace: deploy.namespace,
          appName,
          githubRepo: deploy.githubRepo || undefined,
        }),
        userHint: rawMessage,
      });
      const mode = resolveAgentMode();
      const payload: StartRunRequest = {
        incidentId,
        triggeredBy: 'commander',
        triggeredAt,
        namespace: deploy.namespace,
        resourceKind: 'Deployment',
        resourceName: appName,
        mode: 'pre-deploy',
        githubRepo: deploy.githubRepo || undefined,
        containerImage: deploy.containerImage,
        gitRef: deploy.gitRef,
        deployStrategy: deploy.deployStrategy,
        createNamespace: deploy.createNamespace,
        stackServices: deploy.stackServices,
        requestedBy: userId,
        platform,
        channelId,
        rawMessage,
        caseId: agentCase.caseId,
        agentMode: mode.agentMode,
        userHints: agentCase.evidence.userHints,
      };
      await dispatchRun(payload, incidentId);
      await bindRunToCase(platform, channelId, userId, agentCase.caseId, incidentId);
      await setSession(platform, channelId, userId, {
        lastIncidentId: incidentId,
        lastMode: 'pre-deploy',
        activeCaseId: agentCase.caseId,
      });
      void linkRunToSession(platform, channelId, userId, incidentId);
      await rememberDeployDraft(platform, channelId, userId, deploy);
      break;
    }
    case 'rollback': {
      const payload: StartRunRequest = {
        incidentId,
        triggeredBy: 'commander',
        triggeredAt,
        namespace: parsed.namespace,
        resourceKind: 'Deployment',
        resourceName: parsed.resourceName,
        mode: 'rollback',
        requestedBy: userId,
        platform,
        channelId,
        rawMessage,
      };
      await dispatchRun(payload, incidentId);
      await setSession(platform, channelId, userId, {
        lastIncidentId: incidentId,
        lastMode: 'rollback',
      });
      void linkRunToSession(platform, channelId, userId, incidentId);
      break;
    }
    case 'investigate': {
      if (parsed.scope === 'event') {
        const text = await fetchEventInvestigation(parsed, incidentId, composeOpts);
        return { incidentId, immediateReply: text };
      }
      if (parsed.scope === 'cluster' || parsed.scope === 'namespace') {
        const health = await fetchHealthInvestigation(parsed, incidentId);
        const text = await composeUserReply({ kind: 'health', data: health }, composeOpts);
        return { incidentId, immediateReply: text };
      }
      if (parsed.scope === 'app') {
        const review = await loadAppReview(parsed);
        const text = review
          ? await composeUserReply({ kind: 'app_review', data: appReviewToOutcome(review) }, composeOpts)
          : await fetchAppReview(parsed, incidentId, composeOpts);

        if (review) {
          await setSession(platform, channelId, userId, {
            lastAppReview: lastAppReviewFromResult(review),
            activeTopic: {
              kind: 'investigate',
              resourceName: review.appId,
              namespace: review.namespace,
              label: `app ${review.appId}`,
              updatedAt: new Date().toISOString(),
            },
          });
        }

        const wantsRemediation =
          parsed.operatorSuggestion ||
          (/\b(fix|remediate|repair|patch)\b/i.test(rawMessage) &&
            !/\b(cluster|namespace)\b/i.test(rawMessage));

        if (wantsRemediation && review && review.overallStatus !== 'ok') {
          const target = remediationTargetFromAppReview(review);
          const agentCase = await openOrResumeCase({
            platform,
            channelId,
            userId,
            subject: subjectFromInvestigate({
              scope: 'app',
              namespace: review.namespace,
              resourceName: review.appId,
              label: parsed.label,
            }),
            userHint: rawMessage,
          });
          const mode = resolveAgentMode();
          const payload: StartRunRequest = {
            incidentId,
            triggeredBy: 'commander',
            triggeredAt,
            namespace: target.namespace,
            resourceKind: target.resourceKind,
            resourceName: target.resourceName,
            mode: 'diagnose',
            eventReason: 'AppReviewRemediation',
            eventMessage: `App ${review.appId} review: ${review.narrative}`,
            requestedBy: userId,
            platform,
            channelId,
            rawMessage,
            investigateScope: 'app',
            investigationLabel: parsed.label,
            caseId: agentCase.caseId,
            agentMode: mode.agentMode,
            userHints: agentCase.evidence.userHints,
            deployProvenance: parsed.deployProvenance,
            allowClusterHotFix: parsed.allowClusterHotFix,
          };
          await dispatchRun(payload, incidentId);
          await bindRunToCase(platform, channelId, userId, agentCase.caseId, incidentId);
          await setSession(platform, channelId, userId, {
            lastIncidentId: incidentId,
            lastMode: 'diagnose',
            activeCaseId: agentCase.caseId,
            waitingForRun: true,
          });
          void linkRunToSession(platform, channelId, userId, incidentId);
          return {
            incidentId,
            immediateReply: `${text}\n\nStarting remediation on **${target.namespace}/${target.resourceName}**…`,
          };
        }

        return { incidentId, immediateReply: text };
      }
      const agentCase = await openOrResumeCase({
        platform,
        channelId,
        userId,
        subject: subjectFromInvestigate({
          scope: parsed.scope,
          namespace: parsed.namespace,
          resourceName: parsed.resourceName,
          resourceKind: parsed.resourceKind,
          label: parsed.label,
        }),
        userHint: parsed.operatorSuggestion ?? rawMessage,
      });
      const opMsg = operatorMessageFromCase(agentCase, parsed.operatorSuggestion ?? rawMessage);
      const mode = resolveAgentMode();
      const payload: StartRunRequest = {
        incidentId,
        triggeredBy: 'commander',
        triggeredAt,
        namespace: parsed.namespace,
        resourceKind: parsed.resourceKind ?? 'Deployment',
        resourceName: parsed.resourceName,
        mode: 'diagnose',
        podName: parsed.podName,
        eventReason: 'ManualInvestigation',
        eventMessage: opMsg,
        requestedBy: userId,
        platform,
        channelId,
        rawMessage: opMsg ?? rawMessage,
        investigateScope: parsed.scope,
        investigationLabel: parsed.label,
        caseId: agentCase.caseId,
        agentMode: mode.agentMode,
        userHints: agentCase.evidence.userHints,
        deployProvenance: parsed.deployProvenance,
        allowClusterHotFix: parsed.allowClusterHotFix,
      };
      const dispatch = await dispatchRun(payload, incidentId);
      if (dispatch.deduplicated) {
        const quickActions = await hilQuickActionsForRun(
          dispatch.existingIncidentId,
          dispatch.existingRunId
        );
        const viewRunAction = dispatch.existingRunId
          ? [
              { id: `view_run_${dispatch.existingRunId}`, label: 'View run' },
              { id: `cancel_run_${dispatch.existingRunId}`, label: 'Cancel stuck run' },
            ]
          : [];
        return {
          incidentId: dispatch.existingIncidentId ?? incidentId,
          immediateReply: await buildDedupeRunReply(dispatch, parsed),
          quickActions: [...viewRunAction, ...(quickActions ?? [])],
          existingRunId: dispatch.existingRunId,
          waitingForRun: isActiveRunStatus(dispatch.existingStatus),
        };
      }
      await bindRunToCase(platform, channelId, userId, agentCase.caseId, incidentId);
      await setSession(platform, channelId, userId, {
        lastIncidentId: incidentId,
        lastMode: 'diagnose',
        activeCaseId: agentCase.caseId,
      });
      void linkRunToSession(platform, channelId, userId, incidentId);
      break;
    }
    case 'ci-failure': {
      const repoSlug = parsed.githubRepo.replace(/^github\.com\//i, '');
      const appName = repoSlug.split('/').pop() ?? 'ci';
      const payload: StartRunRequest = {
        incidentId,
        triggeredBy: 'commander',
        triggeredAt,
        namespace: 'ci',
        resourceKind: 'Job',
        resourceName: appName,
        mode: 'ci-failure',
        githubRepo: parsed.githubRepo,
        workflowRunId: parsed.workflowRunId,
        workflowName: parsed.workflowName,
        ciBranch: parsed.gitRef,
        requestedBy: userId,
        platform,
        channelId,
        rawMessage,
      };
      await dispatchRun(payload, incidentId);
      await setSession(platform, channelId, userId, {
        lastIncidentId: incidentId,
        lastMode: 'ci-failure',
        lastRepo: parsed.githubRepo,
        lastWorkflowRunId: parsed.workflowRunId,
      });
      void linkRunToSession(platform, channelId, userId, incidentId);
      break;
    }
    case 'unknown':
      log('warn', AGENT, 'Unknown command', { incidentId, rawMessage });
      break;
  }

  if (parsed.type !== 'unknown') {
    syncActiveTopicFromCommand(platform, channelId, userId, parsed);
  }

  return { incidentId };
}
