import { describe, expect, it } from 'vitest';
import { redactString } from '../../src/redact-secrets.js';

describe('redactString', () => {
  it('redacts GitHub PATs', () => {
    const { text, hits } = redactString('token ghp_abcdefghijklmnopqrstuvwxyz1234567890AB');
    expect(text).toContain('[REDACTED]');
    expect(hits).toContain('github_pat');
  });

  it('redacts high-entropy base64 blobs', () => {
    const blob = 'A'.repeat(20) + 'BCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const { text, hits } = redactString(blob);
    expect(hits).toContain('high_entropy');
    expect(text).toContain('[REDACTED]');
  });
});
