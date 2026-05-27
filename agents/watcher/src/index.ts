import express from 'express';
import { log } from '../../../shared/src/http.js';
import { startWatcher } from './watcher.js';

const AGENT_NAME = 'watcher-agent';
const PORT = parseInt(process.env.PORT ?? '8080', 10);

const app = express();
app.use(express.json());

// ── Health endpoint ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: AGENT_NAME });
});

// ── Start server ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log('info', AGENT_NAME, `HTTP server listening`, { port: PORT });
});

// ── Start Kubernetes watcher ───────────────────────────────────────────────────
startWatcher().catch((err: unknown) => {
  log('error', AGENT_NAME, 'Fatal: watcher startup failed', {
    error: String(err),
  });
  process.exit(1);
});
