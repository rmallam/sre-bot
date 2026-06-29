#!/usr/bin/env npx tsx
/**
 * Validate shared/data/runbooks/*.json against taxonomy and required sections.
 * Usage: npx tsx scripts/ingest-runbooks/validate.ts [--strict]
 */
import { validateCorpus } from '../../shared/src/runbook-corpus.js';

const strict = process.argv.includes('--strict');

const result = validateCorpus();

console.log(`Runbooks: ${result.runbookCount}, Taxonomy: ${result.taxonomyCount}`);

if (result.issues.length === 0) {
  console.log('OK — corpus valid');
  process.exit(0);
}

for (const issue of result.issues) {
  console.error(`${issue.path}: ${issue.message}`);
}

if (strict || result.issues.some((i) => !i.message.includes('fixture'))) {
  process.exit(1);
}

console.warn('Non-fatal issues only — exiting 0');
process.exit(0);
