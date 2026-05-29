/**
 * Multi-model LLM configuration (OpenRouter-first, optional Gemini native fallback).
 *
 * Env vars:
 *   LLM_PROVIDER              auto | openrouter | gemini (default: auto)
 *   OPENROUTER_API_KEY        primary for production
 *   OPENROUTER_BRAIN_MODEL    rich planner (default: anthropic/claude-sonnet-4)
 *   OPENROUTER_COMMANDER_MODEL fast router (default: google/gemini-2.5-flash)
 *   OPENROUTER_MODEL          legacy fallback for both roles
 *   GEMINI_API_KEY            optional native fallback
 *   GEMINI_BRAIN_MODEL / GEMINI_COMMANDER_MODEL / GEMINI_MODEL
 */

export type LlmProviderPreference = 'auto' | 'openrouter' | 'gemini';
export type LlmBackend = 'openrouter' | 'gemini';

export interface ResolvedLlm {
  backend: LlmBackend;
  model: string;
  role: 'brain' | 'commander';
}

const DEFAULTS = {
  openrouter: {
    brain: 'anthropic/claude-sonnet-4',
    commander: 'google/gemini-2.5-flash',
  },
  gemini: {
    brain: 'gemini-2.5-pro',
    commander: 'gemini-2.0-flash',
  },
} as const;

export function getLlmProviderPreference(): LlmProviderPreference {
  const raw = (process.env['LLM_PROVIDER'] ?? 'auto').toLowerCase();
  if (raw === 'openrouter' || raw === 'gemini') return raw;
  return 'auto';
}

function hasOpenRouterKey(): boolean {
  return Boolean(process.env['OPENROUTER_API_KEY']?.trim());
}

function hasGeminiKey(): boolean {
  return Boolean(process.env['GEMINI_API_KEY']?.trim());
}

function pickBackend(pref: LlmProviderPreference): LlmBackend | null {
  if (pref === 'openrouter') {
    if (hasOpenRouterKey()) return 'openrouter';
    if (hasGeminiKey()) return 'gemini';
    return null;
  }
  if (pref === 'gemini') {
    if (hasGeminiKey()) return 'gemini';
    if (hasOpenRouterKey()) return 'openrouter';
    return null;
  }
  if (hasOpenRouterKey()) return 'openrouter';
  if (hasGeminiKey()) return 'gemini';
  return null;
}

function openRouterModel(role: 'brain' | 'commander'): string {
  if (role === 'brain') {
    return (
      process.env['OPENROUTER_BRAIN_MODEL'] ??
      process.env['OPENROUTER_MODEL'] ??
      DEFAULTS.openrouter.brain
    );
  }
  return (
    process.env['OPENROUTER_COMMANDER_MODEL'] ??
    process.env['OPENROUTER_MODEL'] ??
    DEFAULTS.openrouter.commander
  );
}

function geminiModel(role: 'brain' | 'commander'): string {
  if (role === 'brain') {
    return (
      process.env['GEMINI_BRAIN_MODEL'] ??
      process.env['GEMINI_MODEL'] ??
      DEFAULTS.gemini.brain
    );
  }
  return (
    process.env['GEMINI_COMMANDER_MODEL'] ??
    process.env['GEMINI_MODEL'] ??
    DEFAULTS.gemini.commander
  );
}

export function resolveBrainLlm(): ResolvedLlm {
  const pref = getLlmProviderPreference();
  const backend = pickBackend(pref);
  if (!backend) {
    throw new Error(
      'No LLM configured for brain: set OPENROUTER_API_KEY (recommended) or GEMINI_API_KEY'
    );
  }
  return {
    role: 'brain',
    backend,
    model: backend === 'openrouter' ? openRouterModel('brain') : geminiModel('brain'),
  };
}

export function resolveCommanderLlm(): ResolvedLlm {
  const pref = getLlmProviderPreference();
  const backend = pickBackend(pref);
  if (!backend) {
    throw new Error(
      'No LLM configured for commander: set OPENROUTER_API_KEY (recommended) or GEMINI_API_KEY'
    );
  }
  return {
    role: 'commander',
    backend,
    model:
      backend === 'openrouter' ? openRouterModel('commander') : geminiModel('commander'),
  };
}

export function llmConfigSummary(): {
  provider: LlmProviderPreference;
  brain: ResolvedLlm | null;
  commander: ResolvedLlm | null;
} {
  let brain: ResolvedLlm | null = null;
  let commander: ResolvedLlm | null = null;
  try {
    brain = resolveBrainLlm();
  } catch {
    /* not configured */
  }
  try {
    commander = resolveCommanderLlm();
  } catch {
    /* not configured */
  }
  return { provider: getLlmProviderPreference(), brain, commander };
}
