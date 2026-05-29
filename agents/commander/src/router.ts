import { v4 as uuidv4 } from 'uuid';
import { formatFetchError, postWithRetry, log } from '../../../shared/src/http.js';
import type { DeployRequest, Platform, StartRunRequest } from '../../../shared/src/types.js';
import type { ParsedCommand } from './parser.js';
import { setSession } from './sessions.js';
import { rememberDeployDraft } from './conversation.js';

const AGENT = 'commander-agent';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const USE_ORCHESTRATOR = (process.env['USE_ORCHESTRATOR'] ?? 'true').toLowerCase() === 'true';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';

export interface CommandHandleResult {
  incidentId: string;
  /** Set for synchronous read-only cluster queries (no orchestrator run). */
  immediateReply?: string;
}

async function dispatchRun(payload: StartRunRequest, incidentId: string): Promise<void> {
  if (USE_ORCHESTRATOR) {
    await postWithRetry({
      url: `${ORCHESTRATOR_URL}/runs`,
      payload,
      incidentId,
      callerAgent: AGENT,
    });
    return;
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
}

async function fetchUndeploy(
  namespace: string,
  releaseName: string,
  incidentId: string
): Promise<string> {
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
  const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `POST /undeploy failed ${res.status}`);
  }
  return data.message ?? 'Workload removed.';
}

async function fetchClusterGet(
  resource: string,
  namespace: string | undefined,
  incidentId: string
): Promise<string> {
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
  const data = (await res.json()) as { text?: string };
  return data.text ?? 'No results.';
}

export async function handleCommand(
  parsed: ParsedCommand,
  userId: string,
  platform: Platform,
  channelId: string,
  rawMessage: string
): Promise<CommandHandleResult> {
  const incidentId = uuidv4();
  const triggeredAt = new Date().toISOString();

  log('info', AGENT, `Routing command type=${parsed.type}`, { incidentId, platform, userId });

  switch (parsed.type) {
    case 'get': {
      const text = await fetchClusterGet(parsed.resource, parsed.namespace, incidentId);
      return { incidentId, immediateReply: text };
    }
    case 'delete': {
      const text = await fetchUndeploy(parsed.namespace, parsed.resourceName, incidentId);
      return { incidentId, immediateReply: text };
    }
    case 'deploy': {
      const appName =
        parsed.appName ??
        (parsed.githubRepo ? parsed.githubRepo.split('/').pop() : undefined) ??
        'app';
      const payload: StartRunRequest = {
        incidentId,
        triggeredBy: 'commander',
        triggeredAt,
        namespace: parsed.namespace,
        resourceKind: 'Deployment',
        resourceName: appName,
        mode: 'pre-deploy',
        githubRepo: parsed.githubRepo || undefined,
        containerImage: parsed.containerImage,
        gitRef: parsed.gitRef,
        deployStrategy: parsed.deployStrategy,
        createNamespace: parsed.createNamespace,
        stackServices: parsed.stackServices,
        requestedBy: userId,
        platform,
        channelId,
        rawMessage,
      };
      await dispatchRun(payload, incidentId);
      setSession(platform, channelId, userId, { lastIncidentId: incidentId });
      rememberDeployDraft(platform, channelId, userId, parsed);
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
      setSession(platform, channelId, userId, { lastIncidentId: incidentId });
      break;
    }
    case 'investigate': {
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
        eventMessage: rawMessage,
        requestedBy: userId,
        platform,
        channelId,
        rawMessage,
        investigateScope: parsed.scope,
        investigationLabel: parsed.label,
      };
      await dispatchRun(payload, incidentId);
      setSession(platform, channelId, userId, { lastIncidentId: incidentId });
      break;
    }
    case 'unknown':
      log('warn', AGENT, 'Unknown command', { incidentId, rawMessage });
      break;
  }

  return { incidentId };
}
