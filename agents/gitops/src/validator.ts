/**
 * validator.ts — Fixes Issue #6: no validation before git push.
 *
 * Runs `kubectl apply --dry-run=server` against the patched YAML before
 * any commit is made. Writes content to a temp file, invokes kubectl,
 * returns structured result, and always cleans up.
 */

import { exec } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { log } from '../../../shared/src/http.js';

const execAsync = promisify(exec);

const AGENT = 'gitops-agent';

export interface DryRunResult {
  passed: boolean;
  error?: string;
}

/**
 * Validates the given YAML content by running `kubectl apply --dry-run=server`.
 *
 * @param manifestPath - Original manifest path (used only for logging context)
 * @param content      - Patched YAML string to validate
 */
export async function dryRunValidate(
  manifestPath: string,
  content: string,
): Promise<DryRunResult> {
  const tmpFile = join(tmpdir(), `sre-bot-dryrun-${randomUUID()}.yaml`);

  try {
    await writeFile(tmpFile, content, 'utf8');

    log('info', AGENT, 'Running kubectl dry-run validation', {
      manifestPath,
      tmpFile,
    });

    const { stdout, stderr } = await execAsync(
      `kubectl apply --dry-run=server -f "${tmpFile}"`,
    );

    log('info', AGENT, 'kubectl dry-run passed', {
      manifestPath,
      stdout: stdout.trim(),
    });

    // kubectl may write warnings to stderr even on success; treat exit-0 as pass
    if (stderr && stderr.trim()) {
      log('warn', AGENT, 'kubectl dry-run stderr (non-fatal)', {
        manifestPath,
        stderr: stderr.trim(),
      });
    }

    return { passed: true };
  } catch (err: unknown) {
    // execAsync rejects when exit code != 0; the error has .stderr / .stdout
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const errorMsg = execErr.stderr?.trim() || execErr.stdout?.trim() || String(err);

    log('error', AGENT, 'kubectl dry-run FAILED', {
      manifestPath,
      error: errorMsg,
    });

    return { passed: false, error: errorMsg };
  } finally {
    // Always clean up the temp file — even if kubectl was not found
    await unlink(tmpFile).catch((cleanupErr: unknown) => {
      log('warn', AGENT, 'Failed to delete tmp dry-run file', {
        tmpFile,
        error: String(cleanupErr),
      });
    });
  }
}
