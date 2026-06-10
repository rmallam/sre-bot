/**
 * Ephemeral git workspace for local patch + test loop.
 */

import { execFile as execFileCb } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseOwnerRepo } from '../../../shared/src/github-repo.js';
import { parseSafeTestCommand } from '../../../shared/src/safe-test-command.js';

const execFile = promisify(execFileCb);
const WORK_ROOT = process.env['CODING_AGENT_WORK_DIR'] ?? '/tmp/coding-agent';

function token(): string {
  return (
    process.env['GITHUB_TOKEN'] ??
    process.env['DEPLOY_APP_REPO_WRITE_TOKEN'] ??
    process.env['GITHUB_PAT'] ??
    ''
  );
}

export async function cloneRepo(
  githubRepo: string,
  branch: string,
  jobId: string
): Promise<string> {
  const { owner, repo } = parseOwnerRepo(githubRepo);
  const dir = join(WORK_ROOT, jobId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(WORK_ROOT, { recursive: true });

  const t = token();
  if (!t) throw new Error('GITHUB_TOKEN required for coding-agent clone');

  const cloneUrl = `https://x-access-token:${t}@github.com/${owner}/${repo}.git`;
  await execFile('git', ['clone', '--depth', '1', '--branch', branch, cloneUrl, dir], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return dir;
}

export async function applyPatches(
  dir: string,
  patches: Array<{ path: string; content: string }>
): Promise<void> {
  for (const p of patches) {
    const full = join(dir, p.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, p.content, 'utf-8');
  }
}

function minimalTestEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    NODE_ENV: process.env['NODE_ENV'] ?? 'test',
    LANG: 'C.UTF-8',
    CI: 'true',
  };
}

export async function runTestCommand(dir: string, command: string): Promise<{ ok: boolean; output: string }> {
  const spec = parseSafeTestCommand(command);
  if (!spec) {
    return {
      ok: false,
      output: `Rejected test command (not allowlisted): ${command.slice(0, 200)}`,
    };
  }

  try {
    const { stdout, stderr } = await execFile(spec.cmd, spec.args, {
      cwd: dir,
      timeout: parseInt(process.env['CODING_AGENT_TEST_TIMEOUT_MS'] ?? '180000', 10),
      maxBuffer: 4 * 1024 * 1024,
      env: minimalTestEnv(),
    });
    const output = `${stdout}\n${stderr}`.trim();
    return { ok: true, output: output.slice(-4000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? String(err)}`.trim();
    return { ok: false, output: output.slice(-4000) };
  }
}

export async function cleanupWorkspace(jobId: string): Promise<void> {
  const dir = join(WORK_ROOT, jobId);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
