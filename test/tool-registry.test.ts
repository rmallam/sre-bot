import assert from 'node:assert/strict';
import type { RuntimeToolContext } from '../shared/src/tool-contracts.js';
import { listToolDefinitions } from '../shared/src/tool-registry.js';
import { validateToolCall } from '../shared/src/tool-validation.js';
import { evaluateCompiledToolPolicy } from '../shared/src/tool-policy.js';
import { compileAndValidatePlan } from '../agents/orchestrator/src/tool-compiler.js';

function baseCtx(overrides: Partial<RuntimeToolContext> = {}): RuntimeToolContext {
  return {
    incidentId: 'inc-1',
    runId: 'run-1',
    mode: 'pre-deploy',
    namespace: 'default',
    resourceName: 'api',
    resourceKind: 'Deployment',
    request: {
      incidentId: 'inc-1',
      triggeredBy: 'commander',
      triggeredAt: new Date().toISOString(),
      namespace: 'default',
      resourceKind: 'Deployment',
      resourceName: 'api',
      mode: 'pre-deploy',
      githubRepo: 'github.com/org/api',
      platform: 'telegram',
      channelId: '123',
    },
    plan: {
      action: 'helm_deploy',
      rootCause: 'test',
      reasoning: 'test',
      severity: 'MEDIUM',
      proposedPatch: [],
      targetManifestPath: 'deploy/helm/api/Chart.yaml',
      commitMessage: 'feat: test',
      rollbackSafe: true,
      githubRepo: 'github.com/org/api',
    },
    ...overrides,
  };
}

// restart compile includes verify pipeline
{
  const compiled = compileAndValidatePlan(
    baseCtx({
      mode: 'diagnose',
      request: { ...baseCtx().request, mode: 'diagnose', githubRepo: undefined },
      plan: {
        action: 'restart',
        rootCause: 'crash',
        reasoning: 'restart',
        severity: 'LOW',
        proposedPatch: [],
        targetManifestPath: '',
        commitMessage: '',
        rollbackSafe: true,
      },
    })
  );
  assert.equal(compiled.validation.ok, true);
  assert.ok(compiled.calls.some((c) => c.name === 'executor.restart_workload'));
  assert.ok(compiled.calls.some((c) => c.name === 'investigator.verify_health'));
}

// pre-deploy includes repo inspect
{
  const compiled = compileAndValidatePlan(baseCtx());
  assert.ok(compiled.calls.some((c) => c.name === 'investigator.repo_inspect'));
  assert.ok(compiled.calls.some((c) => c.name === 'gitops.apply_plan'));
}

// invalid gitops missing plan.action
{
  const bad = validateToolCall({
    name: 'gitops.apply_plan',
    input: {
      incidentId: 'x',
      namespace: 'default',
      resourceName: 'api',
      plan: { severity: 'LOW' },
    },
  });
  assert.equal(bad.ok, false);
}

// prod tool policy blocks high-risk gitops
{
  const compiled = compileAndValidatePlan(baseCtx());
  const gate = evaluateCompiledToolPolicy(compiled, 'production', false);
  assert.equal(gate.autoExecute, false);
}

assert.ok(listToolDefinitions().length >= 5);

console.log('tool-registry tests passed');
