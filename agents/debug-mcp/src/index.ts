/**
 * Debug MCP sidecar — read-only tools for human troubleshooting (PLAT-11).
 */

import express from 'express';
import { log } from '../../../shared/src/http.js';
import { callDebugTool, DEBUG_TOOLS, mcpToolList } from './tools.js';

const AGENT = 'debug-mcp-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);
const ENABLED = (process.env['DEBUG_MCP_ENABLED'] ?? 'false').toLowerCase() === 'true';
const TOKEN = process.env['DEBUG_MCP_TOKEN'] ?? '';

const app = express();
app.use(express.json({ limit: '256kb' }));

function requireEnabled(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!ENABLED) {
    res.status(503).json({
      error: 'Debug MCP is disabled. Set DEBUG_MCP_ENABLED=true to enable (human-only).',
    });
    return;
  }
  next();
}

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!TOKEN) {
    if ((process.env['SRE_AUTH_STRICT'] ?? 'true').toLowerCase() === 'true') {
      res.status(503).json({ error: 'DEBUG_MCP_TOKEN is required when SRE_AUTH_STRICT=true' });
      return;
    }
    next();
    return;
  }
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (bearer !== TOKEN) {
    res.status(401).json({ error: 'Unauthorized — set Authorization: Bearer <DEBUG_MCP_TOKEN>' });
    return;
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    agent: AGENT,
    enabled: ENABLED,
    readOnly: true,
    autonomousLoop: false,
    toolCount: DEBUG_TOOLS.length,
  });
});

app.get('/v1/tools', requireEnabled, requireAuth, (_req, res) => {
  res.json({ tools: DEBUG_TOOLS, readOnly: true });
});

app.post('/v1/call', requireEnabled, requireAuth, async (req, res) => {
  const { tool, arguments: toolArgs } = req.body as {
    tool?: string;
    arguments?: Record<string, unknown>;
  };
  if (!tool) {
    res.status(400).json({ error: 'Missing tool name' });
    return;
  }
  try {
    const result = await callDebugTool(tool, toolArgs ?? {});
    res.json(result);
  } catch (err) {
    log('warn', AGENT, 'Tool call failed', { tool, error: String(err) });
    res.status(400).json({ error: String(err) });
  }
});

/** Minimal MCP JSON-RPC (tools/list, tools/call) for IDE clients. */
app.post('/mcp', requireEnabled, requireAuth, async (req, res) => {
  const { jsonrpc, id, method, params } = req.body as {
    jsonrpc?: string;
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };

  if (jsonrpc !== '2.0') {
    res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  try {
    if (method === 'initialize') {
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sre-bot-debug-mcp', version: '1.0.0' },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      res.json({ jsonrpc: '2.0', id, result: { tools: mcpToolList() } });
      return;
    }

    if (method === 'tools/call') {
      const name = String(params?.['name'] ?? '');
      const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;
      const result = await callDebugTool(name, args);
      res.json({ jsonrpc: '2.0', id, result });
      return;
    }

    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: String(err) },
    });
  }
});

app.listen(PORT, () => {
  log('info', AGENT, 'Debug MCP sidecar listening', {
    port: PORT,
    enabled: ENABLED,
    authRequired: Boolean(TOKEN),
  });
  if (ENABLED) {
    log('warn', AGENT, 'Debug MCP enabled — read-only, human-only; not for autonomous agents');
  }
});
