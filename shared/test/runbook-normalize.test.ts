import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  buildPlaybookMarkdown,
  extractSectionsFromText,
  mergeRunbooksIntoComponent,
  sourceToRunbook,
  stripHtml,
  type K8sDocSource,
} from '../src/runbook-normalize.js';

describe('runbook-normalize', () => {
  test('stripHtml removes tags', () => {
    const text = stripHtml('<p>Pod <strong>CrashLoopBackOff</strong></p><script>x</script>');
    assert.match(text, /CrashLoopBackOff/);
    assert.doesNotMatch(text, /<p>/);
  });

  test('buildPlaybookMarkdown includes required sections', () => {
    const md = buildPlaybookMarkdown({
      title: 'Test Issue',
      sections: {
        symptoms: ['Pod pending'],
        diagnosis: ['kubectl describe pod'],
        remediation: ['Fix quota'],
        verification: ['Pod Running'],
      },
    });
    assert.match(md, /## Symptoms/);
    assert.match(md, /## Diagnosis/);
    assert.match(md, /## Verification/);
  });

  test('sourceToRunbook uses seed_sections', () => {
    const source: K8sDocSource = {
      error_signature: 'ResourceQuotaExceeded',
      target_component: 'compute',
      url: 'https://kubernetes.io/docs/concepts/policy/resource-quotas/',
      title: 'Resource Quota Exceeded',
      seed_sections: {
        symptoms: ['quota exceeded'],
        diagnosis: ['oc describe quota'],
        remediation: ['raise quota'],
        verification: ['pod running'],
      },
    };
    const rb = sourceToRunbook(source);
    assert.equal(rb.error_signature, 'ResourceQuotaExceeded');
    assert.match(rb.playbook_markdown, /## Symptoms/);
  });

  test('extractSectionsFromText finds kubectl lines', () => {
    const sections = extractSectionsFromText(
      'Pod fails with error\nkubectl describe pod foo\nVerify pod is Running after fix'
    );
    assert.ok((sections.diagnosis?.length ?? 0) >= 1);
  });

  test('mergeRunbooksIntoComponent skips existing unless force', () => {
    const existing = [
      {
        error_signature: 'OOMKilled',
        target_component: 'compute' as const,
        playbook_markdown:
          '# Old\n\n## Symptoms\na\n\n## Diagnosis\nb\n\n## Verification\nc',
      },
    ];
    const incoming = [
      {
        error_signature: 'OOMKilled',
        target_component: 'compute' as const,
        playbook_markdown:
          '# New\n\n## Symptoms\na\n\n## Diagnosis\nb\n\n## Verification\nc',
      },
      {
        error_signature: 'JobFailed',
        target_component: 'compute' as const,
        playbook_markdown:
          '# Job\n\n## Symptoms\na\n\n## Diagnosis\nb\n\n## Verification\nc',
      },
    ];
    const { merged, result } = mergeRunbooksIntoComponent(existing, incoming, false);
    assert.equal(result.added.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(merged.find((m) => m.error_signature === 'OOMKilled')!.playbook_markdown, /# Old/);
  });
});
