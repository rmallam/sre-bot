import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'vitest';
import {
  dedupeRunbooks,
  loadRunbooksFromDir,
  loadTaxonomy,
  validateCorpus,
  validateRunbook,
} from '../src/runbook-corpus.js';

describe('runbook-corpus', () => {
  test('corpus validates against taxonomy', () => {
    const result = validateCorpus();
    if (!result.ok) {
      console.error(result.issues);
    }
    assert.equal(result.ok, true, result.issues.map((i) => i.message).join('; '));
    assert.ok(result.runbookCount >= 70);
    assert.equal(result.runbookCount, result.taxonomyCount);
  });

  test('every taxonomy fixture_id has a manifest', () => {
    const taxonomy = loadTaxonomy();
    const fixturesPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../scripts/k8s-failure-fixtures/fixtures.json'
    );
    const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as {
      fixtures: { id: string; manifest: string }[];
    };
    const manifestIds = new Set(fixtures.fixtures.map((f) => f.id));

    for (const entry of taxonomy.entries) {
      if (entry.fixture_id) {
        assert.ok(
          manifestIds.has(entry.fixture_id),
          `missing manifest for fixture_id ${entry.fixture_id}`
        );
      }
    }
  });

  test('dedupe keeps last entry per signature', () => {
    const dupes = dedupeRunbooks([
      {
        error_signature: 'OOMKilled',
        target_component: 'compute',
        playbook_markdown:
          '# X\n\n## Symptoms\na\n\n## Diagnosis\nb\n\n## Verification\nc',
      },
      {
        error_signature: 'OOMKilled',
        target_component: 'compute',
        playbook_markdown:
          '# Y\n\n## Symptoms\na\n\n## Diagnosis\nb\n\n## Verification\nc',
      },
    ]);
    assert.equal(dupes.length, 1);
    assert.match(dupes[0]!.playbook_markdown, /# Y/);
  });

  test('validateRunbook rejects missing sections', () => {
    const issues = validateRunbook({
      error_signature: 'Bad',
      target_component: 'compute',
      playbook_markdown: 'too short',
    });
    assert.ok(issues.length >= 2);
  });

  test('loadRunbooksFromDir returns corpus with unique signatures', () => {
    const books = loadRunbooksFromDir();
    assert.ok(books.length >= 70);
    const sigs = books.map((b) => `${b.target_component}:${b.error_signature}`);
    assert.equal(new Set(sigs).size, sigs.length);
    const sorted = dedupeRunbooks(books);
    assert.equal(sorted.length, new Set(sigs).size);
  });
});
