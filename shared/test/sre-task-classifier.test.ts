import assert from 'node:assert/strict';
import {
  classifyFromParsedCommand,
  classifySreTaskText,
} from '../src/sre/sre-task-classifier.js';
import { SRE_TASK_MATRIX } from '../src/sre/sre-task-scenarios.js';
import { describe, test } from 'vitest';

describe('sre-task-classifier', () => {
  test('legacy assertions', () => {
    assert.ok(SRE_TASK_MATRIX.length >= 32);

    const deploy = classifyFromParsedCommand({ type: 'deploy' });
    assert.ok(deploy);
    assert.equal(deploy!.scenario, 'deploy-app');
    assert.equal(deploy!.handler, 'async-run');

    const cluster = classifyFromParsedCommand({ type: 'investigate', scope: 'cluster' });
    assert.equal(cluster!.scenario, 'cluster-health');

    const dr = classifySreTaskText('what is our disaster recovery plan?');
    assert.ok(dr);
    assert.equal(dr!.scenario, 'rag-disaster-recovery');
    assert.equal(dr!.advisoryOnly, true);

    const crash = classifySreTaskText('investigate CrashLoopBackOff in staging/nginx');
    assert.ok(crash);
    assert.equal(crash!.scenario, 'rag-crash-loop');
    assert.equal(crash!.advisoryOnly, false);
  });
});
