import { describe, expect, test } from 'vitest';
import { assessRagBypass, isVerifiedRunbookMarkdown, ragBypassSimilarityThreshold } from '../src/rag-triage.js';

describe('rag-triage', () => {
  test('default similarity threshold is 0.9', () => {
    const prev = process.env['SRE_RAG_BYPASS_THRESHOLD'];
    delete process.env['SRE_RAG_BYPASS_THRESHOLD'];
    expect(ragBypassSimilarityThreshold()).toBe(0.9);
    if (prev) process.env['SRE_RAG_BYPASS_THRESHOLD'] = prev;
  });

  test('detects verified runbook markers', () => {
    expect(isVerifiedRunbookMarkdown('# OOMKilled — verified fix')).toBe(true);
    expect(isVerifiedRunbookMarkdown('<!-- ragLearn runId=abc -->')).toBe(true);
    expect(isVerifiedRunbookMarkdown('generic troubleshooting steps')).toBe(false);
  });

  test('assessRagBypass requires high similarity and verified markdown', () => {
    const prevBypass = process.env['SRE_RAG_BYPASS_REACT'];
    const prevPlatform = process.env['SRE_PLATFORM_URL'];
    const prevGround = process.env['SRE_RAG_GROUNDING'];
    process.env['SRE_RAG_BYPASS_REACT'] = 'true';
    process.env['SRE_PLATFORM_URL'] = 'http://platform:8090';
    process.env['SRE_RAG_GROUNDING'] = 'true';

    expect(
      assessRagBypass({
        playbookMarkdown: '# OOMKilled — verified fix\n## Remediation (verified)',
        errorSignature: 'OOMKilled',
        targetComponent: 'compute',
        similarity: 0.92,
        found: true,
      }).eligible
    ).toBe(true);

    expect(
      assessRagBypass({
        playbookMarkdown: '# OOMKilled — verified fix',
        errorSignature: 'OOMKilled',
        targetComponent: 'compute',
        similarity: 0.85,
        found: true,
      }).reason
    ).toBe('below_threshold');

    if (prevBypass !== undefined) process.env['SRE_RAG_BYPASS_REACT'] = prevBypass;
    else delete process.env['SRE_RAG_BYPASS_REACT'];
    if (prevPlatform !== undefined) process.env['SRE_PLATFORM_URL'] = prevPlatform;
    else delete process.env['SRE_PLATFORM_URL'];
    if (prevGround !== undefined) process.env['SRE_RAG_GROUNDING'] = prevGround;
    else delete process.env['SRE_RAG_GROUNDING'];
  });
});
