/**
 * Validate compiled tool calls against registry schemas.
 */

import type { ToolCall, ToolCallName } from './tool-contracts.js';
import { TOOL_REGISTRY } from './tool-registry.js';

export interface ToolValidationResult {
  ok: boolean;
  errors: string[];
}

function hasField(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined || cur === null) return false;
  if (typeof cur === 'string' && cur.trim() === '') return false;
  return true;
}

export function validateToolCall(call: ToolCall): ToolValidationResult {
  const errors: string[] = [];
  const def = TOOL_REGISTRY[call.name as ToolCallName];
  if (!def) {
    return { ok: false, errors: [`Unknown tool: ${call.name}`] };
  }

  const input = call.input as Record<string, unknown>;
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: [`${call.name}: input must be an object`] };
  }

  for (const field of def.requiredFields) {
    if (!hasField(input, field)) {
      errors.push(`${call.name}: missing required field "${field}"`);
    }
  }

  if (call.name === 'gitops.apply_plan') {
    const plan = input['plan'] as Record<string, unknown> | undefined;
    if (plan && typeof plan === 'object') {
      const action = plan['action'];
      if (typeof action !== 'string' || action.trim() === '') {
        errors.push('gitops.apply_plan: plan.action is required');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateToolCalls(calls: ToolCall[]): ToolValidationResult {
  const errors: string[] = [];
  for (const call of calls) {
    const result = validateToolCall(call);
    if (!result.ok) errors.push(...result.errors);
  }
  if (calls.length === 0) {
    errors.push('Compiled plan has no tool calls');
  }
  return { ok: errors.length === 0, errors };
}
