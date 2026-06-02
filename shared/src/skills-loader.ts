/**
 * Load optional team SKILL.md runbooks into brain/commander prompts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = process.env['CICD_SKILLS_DIR'] ?? '/data/skills';

let cached: string | null = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

export function loadSkillsPrompt(maxChars = 4000): string {
  const now = Date.now();
  if (cached !== null && now - cachedAt < CACHE_MS) return cached;

  if (!existsSync(SKILLS_DIR)) {
    cached = '';
    cachedAt = now;
    return '';
  }

  const parts: string[] = [];
  try {
    for (const name of readdirSync(SKILLS_DIR)) {
      if (!name.endsWith('.md')) continue;
      const full = join(SKILLS_DIR, name);
      try {
        parts.push(`--- ${name} ---\n${readFileSync(full, 'utf-8').trim()}`);
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    cached = '';
    cachedAt = now;
    return '';
  }

  const combined = parts.join('\n\n').slice(0, maxChars);
  cached = combined;
  cachedAt = now;
  return combined;
}

export function skillsSystemAppendix(): string {
  const skills = loadSkillsPrompt();
  if (!skills.trim()) return '';
  return `\n\nTeam runbooks (SKILL.md):\n${skills}`;
}
