/**
 * Existing workload collision — upgrade vs reinstall semantics for enterprise deploys.
 */

export type DeployCollisionMode = 'fresh' | 'upgrade' | 'reinstall' | 'blocked';

export interface DeployCollisionAssessment {
  mode: DeployCollisionMode;
  hasExistingDeployments: boolean;
  matchingDeployments: string[];
  warning?: string;
  requireReinstallConfirm: boolean;
}

export interface DeployCollisionInput {
  namespace: string;
  appName: string;
  existingDeployments?: string[];
  userHint?: string;
}

const REINSTALL_WORDS = /\b(reinstall|replace|overwrite|force|fresh\s+install)\b/i;
const UPGRADE_WORDS = /\b(upgrade|update|roll\s*out|redeploy)\b/i;

function nameMatchesApp(depName: string, appName: string): boolean {
  const d = depName.toLowerCase();
  const a = appName.toLowerCase();
  return d === a || d.includes(a) || a.includes(d.replace(/-operator$/, ''));
}

export function assessDeployCollision(input: DeployCollisionInput): DeployCollisionAssessment {
  const existing = input.existingDeployments ?? [];
  const matching = existing.filter((d) => nameMatchesApp(d, input.appName));
  const hasExisting = existing.length > 0;
  const hint = input.userHint ?? '';

  if (REINSTALL_WORDS.test(hint)) {
    return {
      mode: 'reinstall',
      hasExistingDeployments: hasExisting,
      matchingDeployments: matching,
      requireReinstallConfirm: hasExisting,
      warning: hasExisting
        ? `Reinstall requested — namespace \`${input.namespace}\` has ${existing.length} existing deployment(s). Confirm to proceed.`
        : undefined,
    };
  }

  if (UPGRADE_WORDS.test(hint) || matching.length > 0) {
    return {
      mode: 'upgrade',
      hasExistingDeployments: hasExisting,
      matchingDeployments: matching,
      requireReinstallConfirm: false,
      warning: matching.length
        ? `Upgrade path — found related deployment(s): ${matching.join(', ')}.`
        : hasExisting
          ? `Namespace \`${input.namespace}\` has ${existing.length} deployment(s); treating as upgrade.`
          : undefined,
    };
  }

  if (hasExisting) {
    return {
      mode: 'fresh',
      hasExistingDeployments: true,
      matchingDeployments: matching,
      requireReinstallConfirm: true,
      warning:
        `Namespace \`${input.namespace}\` already has deployment(s): ${existing.slice(0, 6).join(', ')}` +
        (existing.length > 6 ? ` (+${existing.length - 6} more)` : '') +
        `. Approve only if this is an upgrade or intentional reinstall.`,
    };
  }

  return {
    mode: 'fresh',
    hasExistingDeployments: false,
    matchingDeployments: [],
    requireReinstallConfirm: false,
  };
}
