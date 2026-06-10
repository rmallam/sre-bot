import { describe, expect, test } from 'vitest';
import {
  resolveBrainLlm,
  resolveCommanderLlm,
  resolveToolSelectLlm,
} from '../src/llm-config.js';

describe('llm-config tool select', () => {
  test('tool-select defaults to commander flash model on openrouter', () => {
    const keys = [
      'OPENROUTER_API_KEY',
      'OPENROUTER_TOOL_SELECT_MODEL',
      'OPENROUTER_COMMANDER_MODEL',
      'OPENROUTER_BRAIN_MODEL',
      'LLM_PROVIDER',
    ] as const;
    const saved: Partial<Record<(typeof keys)[number], string>> = {};
    for (const k of keys) {
      saved[k] = process.env[k];
    }

    process.env['LLM_PROVIDER'] = 'openrouter';
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    delete process.env['OPENROUTER_TOOL_SELECT_MODEL'];
    process.env['OPENROUTER_COMMANDER_MODEL'] = 'google/gemini-2.5-flash';
    process.env['OPENROUTER_BRAIN_MODEL'] = 'anthropic/claude-sonnet-4';

    const tool = resolveToolSelectLlm();
    const brain = resolveBrainLlm();
    const commander = resolveCommanderLlm();

    expect(tool.role).toBe('tool_select');
    expect(tool.model).toBe('google/gemini-2.5-flash');
    expect(brain.model).toBe('anthropic/claude-sonnet-4');
    expect(commander.model).toBe('google/gemini-2.5-flash');
    expect(tool.model).not.toBe(brain.model);

    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('OPENROUTER_TOOL_SELECT_MODEL overrides commander default', () => {
    const saved = {
      key: process.env['OPENROUTER_API_KEY'],
      provider: process.env['LLM_PROVIDER'],
      tool: process.env['OPENROUTER_TOOL_SELECT_MODEL'],
    };
    process.env['LLM_PROVIDER'] = 'openrouter';
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['OPENROUTER_TOOL_SELECT_MODEL'] = 'openai/gpt-4o-mini';

    expect(resolveToolSelectLlm().model).toBe('openai/gpt-4o-mini');

    if (saved.key === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = saved.key;
    if (saved.provider === undefined) delete process.env['LLM_PROVIDER'];
    else process.env['LLM_PROVIDER'] = saved.provider;
    if (saved.tool === undefined) delete process.env['OPENROUTER_TOOL_SELECT_MODEL'];
    else process.env['OPENROUTER_TOOL_SELECT_MODEL'] = saved.tool;
  });
});
