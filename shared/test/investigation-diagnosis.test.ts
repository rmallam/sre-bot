import assert from 'node:assert/strict';
import {
  adjustPlanForPrimaryFailure,
  enrichFactsWithPrimaryFailure,
  extractImageRefFromText,
  extractPrimaryFailure,
} from '../src/investigation-diagnosis.js';
import type { DiagnosisContext, RemediationPlan } from '../src/types.js';

const imagePullStatuses = [
  {
    name: 'rabbitmq',
    state: {
      waiting: {
        reason: 'ImagePullBackOff',
        message:
          'Back-off pulling image "docker.io/bitnami/rabbitmq:4.1.3-debian-12-r1": ErrImagePull: manifest unknown',
      },
    },
  },
];

const imagePullEvents = [
  {
    reason: 'Failed',
    message:
      'Failed to pull image "docker.io/bitnami/rabbitmq:4.1.3-debian-12-r1": rpc error: code = NotFound desc = manifest unknown',
    type: 'Warning',
    count: 3,
    firstTimestamp: '2026-06-05T10:00:00Z',
    lastTimestamp: '2026-06-05T10:01:00Z',
  },
];

const facts: Partial<DiagnosisContext> = {
  containerStatuses: imagePullStatuses,
  recentEvents: imagePullEvents,
};

const primary = extractPrimaryFailure(facts);
assert.ok(primary);
assert.equal(primary!.signature, 'ImagePullBackOff');
assert.equal(primary!.terminal, true);
assert.equal(primary!.suggestedAction, 'ask_image');
assert.ok(primary!.imageRef?.includes('bitnami/rabbitmq'));

const enriched = enrichFactsWithPrimaryFailure(facts);
assert.equal(enriched.detectedErrorSignature, 'ImagePullBackOff');
assert.ok(enriched.observabilitySummary?.includes('Image pull failed'));

assert.equal(
  extractImageRefFromText('Failed to pull image "ghcr.io/acme/app:v2": not found'),
  'ghcr.io/acme/app:v2'
);

const genericPlan: RemediationPlan = {
  action: 'escalate_human',
  rootCause: 'Unknown failure',
  reasoning: 'Need human review',
  severity: 'HIGH',
  proposedPatch: [],
  targetManifestPath: '',
  commitMessage: 'fix: review',
  rollbackSafe: true,
};

const ctx = { ...facts, incidentId: 'x', mode: 'diagnose', namespace: 'redis-test', resourceName: 'rabbit-rabbitmq-0', resourceKind: 'StatefulSet', recentEvents: imagePullEvents, currentLogs: '', previousLogs: '', podSpec: {}, containerStatuses: imagePullStatuses, resourceLimits: {} } as DiagnosisContext;

const adjusted = adjustPlanForPrimaryFailure(ctx, genericPlan);
assert.ok(adjusted.rootCause.includes('Image pull failed'));
assert.ok(adjusted.reasoning.includes('image tag'));
assert.equal(adjusted.patchTarget, 'cluster');

console.log('investigation-diagnosis.test.ts: ok');
