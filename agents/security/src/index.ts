import express, { type Request, type Response } from 'express';
import type {
  AuthorizeActionRequest,
  SanitizeForLlmRequest,
} from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { emitSecurityAudit } from '../../../shared/src/audit-siem.js';
import { sanitizeForLlm, sanitizeText } from './sanitize.js';
import { authorizeAction } from './authorize.js';

const AGENT = 'security-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: AGENT });
});

app.post('/sanitize-for-llm', async (req: Request, res: Response) => {
  const body = req.body as SanitizeForLlmRequest;
  const incidentId = body.incidentId ?? 'unknown';

  if (body.text !== undefined) {
    const result = sanitizeText(body.text);
    if (result.blocked) {
      await emitSecurityAudit({
        eventType: 'sanitize_blocked',
        incidentId,
        message: 'User text blocked by security policy',
        timestamp: new Date().toISOString(),
      });
    }
    res.json({
      sanitizedText: result.text,
      findings: result.findings,
      blocked: result.blocked,
    });
    return;
  }

  if (!body.context) {
    res.status(400).json({ error: 'context or text required' });
    return;
  }

  const { sanitized, findings, blocked } = sanitizeForLlm(body.context, incidentId);

  await emitSecurityAudit({
    eventType: blocked ? 'sanitize_blocked' : 'sanitize_redacted',
    incidentId,
    namespace: body.context.namespace,
    resourceName: body.context.resourceName,
    message: blocked ? 'Context blocked' : `Sanitized with ${findings.length} findings`,
    timestamp: new Date().toISOString(),
  });

  res.json({ sanitized, findings, blocked });
});

app.post('/authorize-action', async (req: Request, res: Response) => {
  const body = req.body as AuthorizeActionRequest;
  if (!body.plan || !body.namespace || !body.incidentId) {
    res.status(400).json({ error: 'plan, namespace, incidentId required' });
    return;
  }

  const result = authorizeAction(body);

  await emitSecurityAudit({
    eventType: result.allowed ? 'authorize_allowed' : 'authorize_denied',
    incidentId: body.incidentId,
    namespace: body.namespace,
    resourceName: body.resourceName,
    action: body.plan.action,
    message: result.reason,
    timestamp: new Date().toISOString(),
  });

  res.json(result);
});

app.listen(PORT, () => {
  log('info', AGENT, 'security-agent listening', { port: PORT });
});
