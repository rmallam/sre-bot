import { v4 as uuidv4 } from 'uuid';
import { postWithRetry, log } from '../../../shared/src/http.js';
import type { DeployRequest, Platform, StartRunRequest } from '../../../shared/src/types.js';
import type { ParsedCommand } from './parser.js';
import { setSession } from './sessions.js';

const AGENT = 'commander-agent';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const USE_ORCHESTRATOR = (process.env['USE_ORCHESTRATOR'] ?? 'true').toLowerCase() === 'true';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';

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
  // Legacy path
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

export async function handleCommand(
  parsed: ParsedCommand,
  userId: string,
  platform: Platform,
  channelId: string,
  rawMessage: string
): Promise<string> {
  const incidentId = uuidv4();
  const triggeredAt = new Date().toISOString();

  log('info', AGENT, `Routing command type=${parsed.type}`, { incidentId, platform, userId });

  switch (parsed.type) {
    case 'deploy': {
      const payload: StartRunRequest = {
        incidentId,
        triggeredBy: 'commander',
        triggeredAt,
        namespace: parsed.namespace,
        resourceKind: 'Deployment',
        resourceName: parsed.githubRepo.split('/').pop() ?? 'unknown',
        mode: 'pre-deploy',
        githubRepo: parsed.githubRepo,
        gitRef: parsed.gitRef,
        deployStrategy: parsed.deployStrategy,
        requestedBy: userId,
        platform,
        channelId,
        rawMessage,
      };
      await dispatchRun(payload, incidentId);
      setSession(platform, channelId, userId, { lastIncidentId: incidentId });
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
        resourceKind: 'Deployment',
        resourceName: parsed.resourceName,
        mode: 'diagnose',
        podName: parsed.resourceName,
        eventReason: 'ManualInvestigation',
        eventMessage: rawMessage,
        requestedBy: userId,
        platform,
        channelId,
        rawMessage,
      };
      await dispatchRun(payload, incidentId);
      setSession(platform, channelId, userId, { lastIncidentId: incidentId });
      break;
    }
    case 'unknown':
      log('warn', AGENT, 'Unknown command', { incidentId, rawMessage });
      break;
  }

  return incidentId;
}
