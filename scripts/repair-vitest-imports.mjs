#!/usr/bin/env node
/** Repair tests corrupted by first migration (split multi-line imports). */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

const CORRUPT = /^import assert[^\n]+\nimport \{\nimport \{ describe/m;

for (const file of walk(ROOT)) {
  let src = readFileSync(file, 'utf8');
  if (!CORRUPT.test(src)) continue;

  const lines = src.split('\n');
  const hoisted = [];
  let i = 0;
  const header = [lines[0]]; // assert import

  // skip broken import { and vitest import + describe opening until test callback
  while (i < lines.length && !lines[i].includes("test('legacy assertions'")) i++;
  i++; // skip test line
  if (lines[i]?.trim() === '() => {') i++;
  if (lines[i]?.trim().startsWith('async ()')) i++;

  const body = [];
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Hoist inline import blocks left inside test body
    if (trimmed.startsWith('import ')) {
      hoisted.push(trimmed);
      i++;
      continue;
    }

    // Multiline import fragment: ends with } from '...';
    if (/^\} from ['"]/.test(trimmed)) {
      const fromLine = trimmed;
      const importLines = [];
      i++;
      // walk back - collect preceding lines that are part of this import
      // Actually we're forward - the import start was lost. Collect from body start pattern:
      // We need to look at what we already collected in body for this import
      // Simpler: from current corrupted structure, lines after test( are:
      //   catalogKey,
      //   ...
      // } from '...';
      // So scan from first line after test opening
      break;
    }
    i++;
  }

  // Re-parse: find test body start index in original
  const testStart = src.indexOf("test('legacy assertions'");
  const braceStart = src.indexOf('{', testStart);
  let depth = 0;
  let j = braceStart;
  const inner = [];
  const extraImports = [];
  for (j = braceStart + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    if (ch === '}') {
      if (depth === 0) break;
      depth--;
    }
  }

  // Line-based repair
  const allLines = src.split('\n');
  let testLineIdx = allLines.findIndex((l) => l.includes("test('legacy assertions'"));
  let idx = testLineIdx + 1;
  if (allLines[idx]?.includes('=> {')) idx++;

  const importFrags = [];
  const restBody = [];
  while (idx < allLines.length) {
    const t = allLines[idx].trim();
    if (t.startsWith('import ')) {
      extraImports.push(t);
      idx++;
      continue;
    }
    if (/^} from ['"]/.test(t)) {
      importFrags.push(t);
      idx++;
      break;
    }
    if (importFrags.length === 0 || !/^} from/.test(t)) {
      if (importFrags.length === 0 && t && !t.startsWith('const ') && !t.startsWith('assert')) {
        importFrags.push(allLines[idx]);
        idx++;
        continue;
      }
    }
    break;
  }

  // Collect import block lines before } from
  const importBlock = [];
  idx = testLineIdx + 1;
  if (allLines[idx]?.includes('=> {')) idx++;
  while (idx < allLines.length) {
    const t = allLines[idx].trim();
    if (t.startsWith('import ')) {
      extraImports.push(t);
      idx++;
      continue;
    }
    if (/^} from ['"]/.test(t)) {
      importBlock.push(t);
      idx++;
      break;
    }
    importBlock.push(allLines[idx]);
    idx++;
  }

  const fromMatch = importBlock.join('\n').match(/\} from (['"][^'"]+['"])/);
  if (!fromMatch) {
    console.warn('skip (no from):', file);
    continue;
  }
  const fromClause = fromMatch[1];
  const specifiers = importBlock
    .join('\n')
    .replace(/\} from .+$/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

  const fixedImports = [
    allLines[0],
    `import {`,
    ...specifiers.split(',').map((s) => s.trim()).filter(Boolean).map((s) => `  ${s},`),
    `} from ${fromClause};`,
    ...extraImports,
    `import { describe, test } from 'vitest';`,
  ].join('\n');

  const rest = allLines.slice(idx);
  // Remove closing }); from rest if duplicate
  const bodyLines = rest.slice(0, -2).map((l) => (l.startsWith('    ') || l.trim() === '' ? l : `    ${l}`));

  const suite = file.split('/').pop().replace('.test.ts', '');
  const out = `${fixedImports}

describe('${suite}', () => {
  test('legacy assertions', () => {
${bodyLines.join('\n')}
  });
});
`;

  writeFileSync(file, out);
  console.log('repaired', file);
}
