/**
 * SRE Operations Console — BFF + static UI.
 */

import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);
const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const CODING_AGENT_URL = process.env['CODING_AGENT_URL'] ?? 'http://coding-agent:8080';

const AGENT_HEALTH_URLS: Record<string, string> = {
  commander: `${COMMANDER_URL}/health`,
  orchestrator: `${ORCHESTRATOR_URL}/health`,
  hil: `${HIL_URL}/health`,
  investigator: process.env['INVESTIGATOR_URL']
    ? `${process.env['INVESTIGATOR_URL']}/health`
    : 'http://investigator-agent:8080/health',
  brain: process.env['BRAIN_URL'] ? `${process.env['BRAIN_URL']}/health` : 'http://brain-agent:8080/health',
  cicd: process.env['CICD_URL'] ? `${process.env['CICD_URL']}/health` : 'http://cicd-agent:8080/health',
  codingAgent: `${CODING_AGENT_URL}/health`,
};

const app = express();
app.use(express.json({ limit: '1mb' }));

async function proxyJson(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[console] upstream fetch failed: ${url} — ${msg}`);
    return new Response(JSON.stringify({ error: `Upstream unavailable: ${msg}`, url }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'console' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'console' });
});

app.get('/api/agents', async (_req, res) => {
  const results = await Promise.all(
    Object.entries(AGENT_HEALTH_URLS).map(async ([name, url]) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(4_000) });
        const body = (await r.json()) as Record<string, unknown>;
        return { name, ok: r.ok, status: body.status ?? 'unknown', detail: body };
      } catch (err) {
        return { name, ok: false, status: 'down', error: String(err) };
      }
    })
  );
  res.json({ agents: results });
});

app.get('/api/cluster-health', async (req, res) => {
  const force = req.query.force === 'true';
  const r = await proxyJson(`${INVESTIGATOR_URL}/cluster-health${force ? '?force=true' : ''}`);
  const body = await r.text();
  res.status(r.status).type('application/json').send(body);
});

app.get('/api/app-review', async (req, res) => {
  const appId = String(req.query.appId ?? '').trim();
  if (!appId) {
    res.status(400).json({ error: 'appId required' });
    return;
  }
  const params = new URLSearchParams({ appId });
  if (req.query.namespace) params.set('namespace', String(req.query.namespace));
  if (req.query.force === 'true') params.set('force', 'true');
  const r = await proxyJson(`${INVESTIGATOR_URL}/app-review?${params}`);
  const body = await r.text();
  res.status(r.status).type('application/json').send(body);
});

app.get('/api/apps', async (req, res) => {
  const params = req.query.namespace ? `?namespace=${encodeURIComponent(String(req.query.namespace))}` : '';
  const r = await proxyJson(`${INVESTIGATOR_URL}/apps${params}`);
  const body = await r.text();
  res.status(r.status).type('application/json').send(body);
});

app.get('/api/overview', async (_req, res) => {
  try {
    const [hilRes, runsRes] = await Promise.all([
      proxyJson(`${HIL_URL}/api/approvals`),
      proxyJson(`${ORCHESTRATOR_URL}/runs?limit=100`),
    ]);
    const hil = hilRes.ok ? ((await hilRes.json()) as { pending?: number; approvals?: unknown[] }) : {};
    const runs = runsRes.ok
      ? ((await runsRes.json()) as { runs?: Array<{ status: string }> }).runs ?? []
      : [];

    const byStatus = (s: string) => runs.filter((r) => r.status === s).length;

    res.json({
      pendingApprovals: hil.pending ?? 0,
      runsTotal: runs.length,
      runsRunning: byStatus('running'),
      runsAwaiting: byStatus('awaiting_human'),
      runsSucceeded: byStatus('succeeded'),
      runsFailed: byStatus('failed') + byStatus('escalated'),
      runsCancelled: byStatus('cancelled'),
    });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get('/api/activity', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '60'), 10) || 60, 200);
  try {
    const [runsRes, hilRes] = await Promise.all([
      proxyJson(`${ORCHESTRATOR_URL}/runs?limit=${limit}`),
      proxyJson(`${HIL_URL}/api/approvals`),
    ]);
    const runs = runsRes.ok
      ? ((await runsRes.json()) as {
          runs?: Array<{
            runId: string;
            incidentId: string;
            status: string;
            updatedAt: string;
            startedAt: string;
            displayName?: string;
            resourceName?: string;
            namespace?: string;
            mode?: string;
          }>;
        }).runs ?? []
      : [];
    const approvals = hilRes.ok
      ? ((await hilRes.json()) as {
          approvals?: Array<{
            incidentId: string;
            runId?: string;
            status: string;
            namespace: string;
            resourceName: string;
            resourceKind: string;
            mode: string;
            triggeredAt: string;
            triggeredBy?: string;
            lockedVia?: string;
            plan?: { action?: string };
          }>;
        }).approvals ?? []
      : [];

    type Ev = {
      id: string;
      kind: 'run' | 'approval' | 'approval_decision';
      at: string;
      title: string;
      detail?: string;
      status?: string;
      source?: string;
      runId?: string;
      incidentId?: string;
    };

    const events: Ev[] = [];

    for (const run of runs) {
      const label = run.displayName ?? run.resourceName ?? run.runId.slice(0, 8);
      events.push({
        id: `run-${run.runId}-${run.updatedAt}`,
        kind: 'run',
        at: run.updatedAt ?? run.startedAt,
        title: `${label} — ${run.status.replace(/_/g, ' ')}`,
        detail: run.mode ? `Mode: ${run.mode.replace(/-/g, ' ')}` : undefined,
        status: run.status,
        source: 'orchestrator',
        runId: run.runId,
        incidentId: run.incidentId,
      });
    }

    for (const a of approvals) {
      const label = `${a.namespace}/${a.resourceName}`;
      const action = a.plan?.action?.replace(/_/g, ' ') ?? a.mode;
      if (a.status === 'PENDING') {
        events.push({
          id: `approval-${a.incidentId}`,
          kind: 'approval',
          at: a.triggeredAt,
          title: `Approval needed: ${label}`,
          detail: action,
          status: a.status,
          source: a.lockedVia ?? a.triggeredBy ?? 'hil',
          runId: a.runId,
          incidentId: a.incidentId,
        });
      } else {
        events.push({
          id: `approval-${a.incidentId}-${a.status}`,
          kind: 'approval_decision',
          at: a.triggeredAt,
          title: `${a.status}: ${label}`,
          detail: action,
          status: a.status,
          source: a.lockedVia ?? a.triggeredBy ?? 'hil',
          runId: a.runId,
          incidentId: a.incidentId,
        });
      }
    }

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    res.json({ events: events.slice(0, limit) });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get('/api/approvals', async (_req, res) => {
  const r = await proxyJson(`${HIL_URL}/api/approvals`);
  const body = await r.text();
  res.status(r.status).type('application/json').send(body);
});

app.get('/api/ignored', async (_req, res) => {
  const r = await proxyJson(`${HIL_URL}/api/ignored`);
  res.status(r.status).json(await r.json());
});

app.delete('/api/ignored/:key', async (req, res) => {
  const key = encodeURIComponent(req.params.key ?? '');
  const r = await proxyJson(`${HIL_URL}/api/ignored/${key}`, { method: 'DELETE' });
  res.status(r.status).json(await r.json());
});

app.post('/api/approvals/:incidentId/approve', async (req, res) => {
  const id = req.params.incidentId;
  const r = await proxyJson(`${HIL_URL}/api/approve/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'console', platform: 'web' }),
  });
  res.status(r.status).json(await r.json());
});

app.post('/api/approvals/:incidentId/reject', async (req, res) => {
  const id = req.params.incidentId;
  const r = await proxyJson(`${HIL_URL}/api/reject/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'console',
      platform: 'web',
      reason: (req.body as { reason?: string })?.reason ?? 'Rejected via console',
    }),
  });
  res.status(r.status).json(await r.json());
});

app.post('/api/approvals/:incidentId/ignore', async (req, res) => {
  const id = req.params.incidentId;
  const r = await proxyJson(`${HIL_URL}/api/ignore/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'console',
      platform: 'web',
      reason: (req.body as { reason?: string })?.reason ?? 'Ignored via console',
    }),
  });
  res.status(r.status).json(await r.json());
});

app.post('/api/approvals/:incidentId/suggest', async (req, res) => {
  const id = req.params.incidentId;
  const { suggestion, applyNow } = req.body as { suggestion?: string; applyNow?: boolean };
  const r = await proxyJson(`${HIL_URL}/api/suggest-fix/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestion,
      userId: 'console',
      platform: 'web',
      applyNow: applyNow ?? false,
    }),
  });
  res.status(r.status).json(await r.json());
});

app.get('/api/runs', async (req, res) => {
  const limit = req.query.limit ?? '50';
  const incidentId = req.query.incidentId ? `&incidentId=${req.query.incidentId}` : '';
  const r = await proxyJson(`${ORCHESTRATOR_URL}/runs?limit=${limit}${incidentId}`);
  res.status(r.status).json(await r.json());
});

app.get('/api/runs/grouped', async (req, res) => {
  const limit = req.query.limit ?? '150';
  const r = await proxyJson(`${ORCHESTRATOR_URL}/runs/by-resource?limit=${limit}`);
  res.status(r.status).json(await r.json());
});

app.get('/api/skills/export', async (req, res) => {
  const limit = req.query.limit ?? '150';
  const r = await proxyJson(`${ORCHESTRATOR_URL}/runs/skills-export?limit=${limit}`);
  res.status(r.status).json(await r.json());
});

app.get('/api/runs/:runId', async (req, res) => {
  const r = await proxyJson(`${ORCHESTRATOR_URL}/runs/${encodeURIComponent(req.params.runId ?? '')}`);
  res.status(r.status).json(await r.json());
});

app.get('/api/runs/:runId/summary', async (req, res) => {
  const verbose = req.query.verbose === 'true' ? '?verbose=true' : '';
  const r = await proxyJson(
    `${ORCHESTRATOR_URL}/runs/${encodeURIComponent(req.params.runId ?? '')}/summary${verbose}`
  );
  res.status(r.status).json(await r.json());
});

app.post('/api/runs/:runId/cancel', async (req, res) => {
  const r = await proxyJson(
    `${ORCHESTRATOR_URL}/runs/${encodeURIComponent(req.params.runId ?? '')}/cancel`,
    { method: 'POST' }
  );
  res.status(r.status).json(await r.json());
});

app.get('/api/coding-agent/jobs/:jobId', async (req, res) => {
  const r = await proxyJson(
    `${CODING_AGENT_URL}/jobs/${encodeURIComponent(req.params.jobId ?? '')}`
  );
  res.status(r.status).json(await r.json());
});

app.post('/api/coding-agent/jobs/:jobId/cancel', async (req, res) => {
  const r = await proxyJson(
    `${CODING_AGENT_URL}/jobs/${encodeURIComponent(req.params.jobId ?? '')}/cancel`,
    { method: 'POST' }
  );
  res.status(r.status).json(await r.json());
});

app.get('/api/chat/sessions', async (req, res) => {
  const userId = (req.query.userId as string) ?? 'console';
  const r = await proxyJson(`${COMMANDER_URL}/chat/sessions?userId=${encodeURIComponent(userId)}`);
  res.status(r.status).json(await r.json());
});

app.post('/api/chat/sessions', async (req, res) => {
  const r = await proxyJson(`${COMMANDER_URL}/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  res.status(r.status).json(await r.json());
});

app.post('/api/chat/sessions/:channelId/reset', async (req, res) => {
  const r = await proxyJson(
    `${COMMANDER_URL}/chat/sessions/${encodeURIComponent(req.params.channelId ?? '')}/reset`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    }
  );
  res.status(r.status).json(await r.json());
});

app.post('/api/chat', async (req, res) => {
  const r = await proxyJson(`${COMMANDER_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  res.status(r.status).json(await r.json());
});

app.get('/api/chat/transcript', async (req, res) => {
  const channelId = req.query.channelId as string;
  const userId = (req.query.userId as string) ?? 'console';
  if (!channelId) {
    res.status(400).json({ error: 'channelId required' });
    return;
  }
  const r = await proxyJson(
    `${COMMANDER_URL}/chat/session?channelId=${encodeURIComponent(channelId)}&userId=${encodeURIComponent(userId)}`
  );
  const body = (await r.json()) as { transcript?: unknown };
  res.status(r.status).json({ transcript: body.transcript ?? [] });
});

app.get('/api/chat/session', async (req, res) => {
  const channelId = req.query.channelId as string;
  const userId = (req.query.userId as string) ?? 'console';
  if (!channelId) {
    res.status(400).json({ error: 'channelId required' });
    return;
  }
  const r = await proxyJson(
    `${COMMANDER_URL}/chat/session?channelId=${encodeURIComponent(channelId)}&userId=${encodeURIComponent(userId)}`
  );
  res.status(r.status).json(await r.json());
});

const webDist = path.join(__dirname, '../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text/html').send(
      '<h1>SRE Console</h1><p>UI not built. Run <code>npm run build:web</code> in agents/console.</p>'
    );
  });
}

app.listen(PORT, () => {
  console.log(`[console] listening on ${PORT}, hil=${HIL_URL}, orchestrator=${ORCHESTRATOR_URL}`);
});
