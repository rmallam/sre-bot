import { describe, expect, test } from 'vitest';
import {
  isDirectRagBypassPlan,
  parseVerifiedRunbookPlan,
} from '../src/rag-runbook-plan.js';
import { formatVerifiedRunbookMarkdown } from '../src/rag-learn.js';
import type { RemediationOutcome } from '../src/remediation-outcome.js';

describe('rag-runbook-plan', () => {
  test('parses restart from verified runbook markdown', () => {
    const markdown = [
      '# CrashLoopBackOff — verified fix',
      '',
      '## Context',
      '- **Error signature:** CrashLoopBackOff',
      '- **Root cause:** stale config after deploy',
      '',
      '## Remediation (verified)',
      '1. **Primary fix:** restart the workload',
      '2. **Reasoning:** Transient crash after config reload',
    ].join('\n');

    const plan = parseVerifiedRunbookPlan(markdown, {
      namespace: 'default',
      resourceName: 'payments-api',
      errorSignature: 'CrashLoopBackOff',
    });

    expect(plan?.action).toBe('restart');
    expect(plan?.rootCause).toContain('stale config');
    expect(isDirectRagBypassPlan(plan!)).toBe(true);
  });

  test('round-trips formatVerifiedRunbookMarkdown for restart', () => {
    const outcome: RemediationOutcome = {
      resourceKey: 'k8s:default/payments-api',
      suggestedAction: 'restart',
      rootCause: 'OOM after traffic spike',
      reasoning: 'Memory limit too low',
      worked: true,
      finalStatus: 'succeeded',
      actionsTaken: [{ action: 'restart', success: true, summary: 'rolled restart' }],
      recordedAt: new Date().toISOString(),
      skillSummary: 'oom → restart (worked)',
    };

    const markdown = formatVerifiedRunbookMarkdown({
      outcome,
      errorSignature: 'OOMKilled',
      targetComponent: 'compute',
      runId: 'run-12345678',
      incidentId: 'inc-12345678',
      resourceLabel: 'payments-api',
      namespace: 'default',
      resourceName: 'payments-api',
    });

    const plan = parseVerifiedRunbookPlan(markdown, {
      namespace: 'default',
      resourceName: 'payments-api',
    });
    expect(plan?.action).toBe('restart');
  });

  test('git_patch is not a direct bypass plan', () => {
    const plan = parseVerifiedRunbookPlan(
      '## Remediation (verified)\n1. **Primary fix:** patch the deployment',
      { namespace: 'ns', resourceName: 'app' }
    );
    expect(plan?.action).toBe('git_patch');
    expect(isDirectRagBypassPlan(plan!)).toBe(false);
  });
});
