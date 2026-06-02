/**
 * Safe, deterministic patches for common GitHub Actions workflow issues.
 */

export interface WorkflowPatchResult {
  patched: boolean;
  content: string;
  changes: string[];
}

/** Bump well-known deprecated action pins when logs mention Node 20 / old actions. */
export function patchWorkflowYaml(content: string, logHint: string): WorkflowPatchResult {
  let next = content;
  const changes: string[] = [];

  const replacements: Array<{ from: RegExp; to: string; label: string }> = [
    { from: /actions\/checkout@v3\b/g, to: 'actions/checkout@v4', label: 'checkout v3 → v4' },
    { from: /actions\/setup-node@v3\b/g, to: 'actions/setup-node@v4', label: 'setup-node v3 → v4' },
    { from: /actions\/cache@v3\b/g, to: 'actions/cache@v4', label: 'cache v3 → v4' },
  ];

  for (const r of replacements) {
    if (r.from.test(next)) {
      next = next.replace(r.from, r.to);
      changes.push(r.label);
    }
  }

  const deprec =
    /Node\.js 20 actions are deprecated|deprecated.*actions\/checkout@v3/i.test(logHint) ||
    /actions\/checkout@v3|actions\/setup-node@v3/i.test(content);
  if (deprec && changes.length === 0 && !/FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/i.test(next)) {
    if (/runs-on:/m.test(next) && !/FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/.test(next)) {
      // Document-only env hint in a comment at top if we cannot match a pin
      if (!next.startsWith('# sre-bot:')) {
        next =
          '# sre-bot: GitHub is deprecating Node 20 actions — consider updating action versions (checkout/setup-node v4+) or set FORCE_JAVASCRIPT_ACTIONS_TO_NODE24.\n' +
          next;
        changes.push('added deprecation guidance comment');
      }
    }
  }

  return {
    patched: changes.length > 0,
    content: next,
    changes,
  };
}
