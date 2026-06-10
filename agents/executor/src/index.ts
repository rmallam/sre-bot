import express, { type Request, type Response } from 'express';
import type { RemediateCommand } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { createInternalAuthMiddleware } from '../../../shared/src/internal-auth.js';
import { emitSecurityAudit } from '../../../shared/src/audit-siem.js';
import { executeRestart } from './restart.js';

const AGENT = 'executor-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(createInternalAuthMiddleware());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: AGENT });
});

app.post('/execute', async (req: Request, res: Response) => {
  const cmd = req.body as RemediateCommand;
  if (!cmd?.incidentId || !cmd?.plan || cmd.plan.action !== 'restart') {
    res.status(400).json({ error: 'RemediateCommand with plan.action=restart required' });
    return;
  }

  const result = await executeRestart(cmd);

  await emitSecurityAudit({
    eventType: 'act_executed',
    incidentId: cmd.incidentId,
    runId: cmd.runId,
    namespace: cmd.namespace,
    resourceName: cmd.resourceName,
    action: 'restart',
    message: result.success ? 'Restart succeeded' : (result.error ?? 'Restart failed'),
    timestamp: new Date().toISOString(),
  });

  log('info', AGENT, 'Execute complete', {
    incidentId: cmd.incidentId,
    success: result.success,
  });

  res.json(result);
});

app.listen(PORT, () => {
  log('info', AGENT, 'executor-agent listening', { port: PORT });
});
