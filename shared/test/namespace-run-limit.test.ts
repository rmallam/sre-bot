import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  namespaceRunLimitExceeded,
  resolveNamespaceRunLimit,
} from '../src/namespace-run-limit.js';

describe('namespace-run-limit', () => {
  test('disabled when env unset or zero', () => {
    const prev = process.env['NAMESPACE_RUN_LIMIT'];
    delete process.env['NAMESPACE_RUN_LIMIT'];
    delete process.env['NAMESPACE_MAX_ACTIVE_RUNS'];
    const cfg = resolveNamespaceRunLimit();
    assert.equal(cfg.enabled, false);
    assert.equal(namespaceRunLimitExceeded(100, cfg), false);
    if (prev === undefined) delete process.env['NAMESPACE_RUN_LIMIT'];
    else process.env['NAMESPACE_RUN_LIMIT'] = prev;
  });

  test('enabled when NAMESPACE_RUN_LIMIT is positive', () => {
    const prev = process.env['NAMESPACE_RUN_LIMIT'];
    process.env['NAMESPACE_RUN_LIMIT'] = '5';
    const cfg = resolveNamespaceRunLimit();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.maxActive, 5);
    assert.equal(namespaceRunLimitExceeded(4, cfg), false);
    assert.equal(namespaceRunLimitExceeded(5, cfg), true);
    assert.equal(namespaceRunLimitExceeded(10, cfg), true);
    if (prev === undefined) delete process.env['NAMESPACE_RUN_LIMIT'];
    else process.env['NAMESPACE_RUN_LIMIT'] = prev;
  });

  test('NAMESPACE_MAX_ACTIVE_RUNS alias', () => {
    const prevLimit = process.env['NAMESPACE_RUN_LIMIT'];
    const prevAlias = process.env['NAMESPACE_MAX_ACTIVE_RUNS'];
    delete process.env['NAMESPACE_RUN_LIMIT'];
    process.env['NAMESPACE_MAX_ACTIVE_RUNS'] = '3';
    const cfg = resolveNamespaceRunLimit();
    assert.equal(cfg.maxActive, 3);
    assert.equal(namespaceRunLimitExceeded(3, cfg), true);
    if (prevLimit === undefined) delete process.env['NAMESPACE_RUN_LIMIT'];
    else process.env['NAMESPACE_RUN_LIMIT'] = prevLimit;
    if (prevAlias === undefined) delete process.env['NAMESPACE_MAX_ACTIVE_RUNS'];
    else process.env['NAMESPACE_MAX_ACTIVE_RUNS'] = prevAlias;
  });
});
