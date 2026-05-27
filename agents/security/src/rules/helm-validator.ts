const DANGEROUS_PATTERNS = [
  /privileged:\s*true/i,
  /hostNetwork:\s*true/i,
  /hostPID:\s*true/i,
  /cluster-admin/i,
];

export function validateHelmChart(files: Record<string, string>): { allowed: boolean; reason?: string } {
  for (const [path, content] of Object.entries(files)) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(content)) {
        return { allowed: false, reason: `Dangerous pattern in ${path}: ${pattern.source}` };
      }
    }
  }
  return { allowed: true };
}
