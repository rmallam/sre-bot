/**
 * Extract missing dependency hints from CI job logs.
 */

export interface MissingDependencyHint {
  ecosystem: 'python' | 'node' | 'go' | 'rust' | 'java' | 'unknown';
  packageName: string;
  rawLine: string;
}

export function parseMissingDependency(log: string): MissingDependencyHint | null {
  const patterns: Array<{ re: RegExp; ecosystem: MissingDependencyHint['ecosystem'] }> = [
    {
      re: /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/i,
      ecosystem: 'python',
    },
    {
      re: /ImportError: cannot import name ['"]([^'"]+)['"]/i,
      ecosystem: 'python',
    },
    {
      re: /No module named ['"]([^'"]+)['"]/i,
      ecosystem: 'python',
    },
    {
      re: /Cannot find module ['"]([^'"]+)['"]/i,
      ecosystem: 'node',
    },
    {
      re: /Error: Cannot find module ['"]([^'"]+)['"]/i,
      ecosystem: 'node',
    },
    {
      re: /npm ERR!.*(?:Could not resolve|404 Not Found)[^\n]*['"](@[^'"]+|[^'"]+)['"]/i,
      ecosystem: 'node',
    },
    {
      re: /go: [^\n]*cannot find module providing package ([^\s;]+)/i,
      ecosystem: 'go',
    },
    {
      re: /error: could not find `([^`]+)` in [^\n]+/i,
      ecosystem: 'rust',
    },
    {
      re: /package ([^\s]+) is not in go\.mod/i,
      ecosystem: 'go',
    },
  ];

  for (const { re, ecosystem } of patterns) {
    const m = log.match(re);
    if (m?.[1]) {
      const pkg = m[1].trim();
      if (pkg.length > 0 && pkg.length < 120) {
        return {
          ecosystem,
          packageName: pkg.split('.')[0] ?? pkg,
          rawLine: m[0].slice(0, 200),
        };
      }
    }
  }
  return null;
}

export function logLooksLikeMissingDependency(log: string): boolean {
  return parseMissingDependency(log) !== null;
}
