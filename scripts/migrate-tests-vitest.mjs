#!/usr/bin/env node
/**
 * Idempotent: wrap legacy top-level assert tests in vitest describe/test.
 * Handles multi-line imports. Skips files that already use vitest describe+test.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

/** Index after the last top-level import / type-only import line block. */
function findImportEnd(lines) {
  let i = 0;
  let inImport = false;

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (t === '' || t.startsWith('//')) {
      if (!inImport) i++;
      else i++;
      continue;
    }

    if (t.startsWith('import ') || t.startsWith('import{')) {
      inImport = true;
      i++;
      if (/\bfrom\s+['"]/.test(t)) inImport = false;
      continue;
    }

    if (inImport) {
      i++;
      if (/\bfrom\s+['"]/.test(t)) inImport = false;
      continue;
    }

    break;
  }
  return i;
}

const files = walk(ROOT);
let migrated = 0;
let skipped = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (/from ['"]vitest['"]/.test(src) && /\bdescribe\s*\(/.test(src)) {
    skipped++;
    continue;
  }

  const lines = src.split('\n');
  const importEnd = findImportEnd(lines);
  const imports = lines.slice(0, importEnd).join('\n').trimEnd();
  let body = lines.slice(importEnd).join('\n').trim();
  body = body.replace(/\nconsole\.log\([^)]*\);?\s*$/m, '').trim();

  const suite = basename(file, '.test.ts');
  const needsAsync = /\bawait\b/.test(body);
  const asyncKw = needsAsync ? 'async ' : '';

  const out = `${imports}
import { describe, test } from 'vitest';

describe('${suite}', () => {
  test('legacy assertions', ${asyncKw}() => {
${body
  .split('\n')
  .map((l) => (l.length ? `    ${l}` : ''))
  .join('\n')}
  });
});
`;

  writeFileSync(file, out.endsWith('\n') ? out : `${out}\n`);
  migrated++;
  console.log('migrated', relative(ROOT, file));
}

console.log(`Done: ${migrated} migrated, ${skipped} already vitest`);
