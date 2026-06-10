/**
 * Allowlisted test commands for coding-agent — no arbitrary shell execution.
 */

export interface SafeExecSpec {
  cmd: string;
  args: string[];
}

/** Exact-match allowlist (normalized whitespace). */
const EXACT: Record<string, SafeExecSpec> = {
  'npm test': { cmd: 'npm', args: ['test'] },
  'npm run test': { cmd: 'npm', args: ['run', 'test'] },
  'npm run lint': { cmd: 'npm', args: ['run', 'lint'] },
  'npm run check': { cmd: 'npm', args: ['run', 'check'] },
  'yarn test': { cmd: 'yarn', args: ['test'] },
  'pnpm test': { cmd: 'pnpm', args: ['test'] },
  'pytest': { cmd: 'pytest', args: [] },
  'pytest -q': { cmd: 'pytest', args: ['-q'] },
  'pytest -v': { cmd: 'pytest', args: ['-v'] },
  'python -m pytest': { cmd: 'python', args: ['-m', 'pytest'] },
  'python3 -m pytest': { cmd: 'python3', args: ['-m', 'pytest'] },
  'go test ./...': { cmd: 'go', args: ['test', './...'] },
  'cargo test': { cmd: 'cargo', args: ['test'] },
  'make test': { cmd: 'make', args: ['test'] },
};

const PYTEST_FLAGS = /^-[qvx]|^--maxfail=?\d+$|^--tb=(short|line|native|auto|no)$/;

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/**
 * Parse an LLM-proposed test command into a safe argv exec spec, or null if disallowed.
 */
export function parseSafeTestCommand(command: string): SafeExecSpec | null {
  const normalized = normalize(command);
  if (!normalized) return null;

  const exact = EXACT[normalized];
  if (exact) return exact;

  if (/^go test(\s+-\w+=?\S*)*\s+\.\/(\.\.\.)?$/.test(normalized)) {
    const parts = normalized.split(/\s+/);
    return { cmd: 'go', args: parts.slice(1) };
  }

  if (normalized.startsWith('pytest ')) {
    const flags = normalized.slice('pytest '.length).split(/\s+/).filter(Boolean);
    if (flags.every((f) => PYTEST_FLAGS.test(f))) {
      return { cmd: 'pytest', args: flags };
    }
    return null;
  }

  if (/^npm run [a-z][a-z0-9_-]{0,31}$/i.test(normalized)) {
    const script = normalized.split(/\s+/).pop()!;
    if (['test', 'lint', 'check', 'unit', 'verify'].includes(script.toLowerCase())) {
      return { cmd: 'npm', args: ['run', script] };
    }
  }

  return null;
}

export function listAllowedTestCommands(): string[] {
  return Object.keys(EXACT).sort();
}
