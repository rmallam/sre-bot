import assert from 'node:assert/strict';
import { truncateUtf8, LOG_MERGE_MAX_CHARS } from '../src/observability-limits.js';
import { mergeLogExcerpts } from '../src/log-excerpt.js';
import { describe, test } from 'vitest';

describe('observability-limits', () => {
  test('legacy assertions', () => {
    const big = 'error line\n'.repeat(5000);
    const merged = mergeLogExcerpts(big, 'warn tail');
    assert.ok(merged.length <= LOG_MERGE_MAX_CHARS);

    const truncated = truncateUtf8('hello 🌍 world', 8);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= 8);
  });
});
