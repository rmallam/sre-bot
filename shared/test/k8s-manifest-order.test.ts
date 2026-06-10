import assert from 'node:assert/strict';
import {
  isClusterScopedDocument,
  isCrdDocument,
  orderDocumentsForApply,
  splitKubernetesDocuments,
} from '../src/deploy/k8s-manifest-order.js';
import { describe, test } from 'vitest';

describe('k8s-manifest-order', () => {
  test('legacy assertions', () => {
    const multi = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: operator
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: operator-role
`;
    const docs = splitKubernetesDocuments(multi);
    assert.equal(docs.length, 3);

    const ordered = orderDocumentsForApply(docs);
    assert.ok(isCrdDocument(ordered[0]!));
    assert.ok(isClusterScopedDocument(ordered[1]!));
    assert.match(ordered[2]!, /kind:\s*Deployment/i);
  });
});
