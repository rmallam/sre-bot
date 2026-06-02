import assert from 'node:assert/strict';
import type { StartRunRequest } from '../../../shared/src/types.js';
import type { StoredRun } from '../../../shared/src/run-persistence.js';
import { findActiveDuplicateRun } from '../src/run-dedupe.js';

const incoming: StartRunRequest = {
  incidentId: 'new-incident',
  triggeredBy: 'commander',
  triggeredAt: new Date().toISOString(),
  namespace: 'default',
  resourceKind: 'Deployment',
  resourceName: 'apache',
  mode: 'diagnose',
};

const runs: StoredRun[] = [
  {
    runId: 'r1',
    incidentId: 'old-1',
    status: 'succeeded',
    transcript: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { request: incoming },
  },
  {
    runId: 'r2',
    incidentId: 'old-2',
    status: 'running',
    transcript: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { request: incoming },
  },
];

const dupe = findActiveDuplicateRun(incoming, runs);
assert.ok(dupe);
assert.equal(dupe?.runId, 'r2');
assert.equal(dupe?.incidentId, 'old-2');

const differentMode: StartRunRequest = { ...incoming, mode: 'pre-deploy' };
assert.equal(findActiveDuplicateRun(differentMode, runs), undefined);

console.log('run-dedupe.test.ts: ok');
