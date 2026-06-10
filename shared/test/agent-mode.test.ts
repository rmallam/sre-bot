import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

describe('agent-mode', () => {
  test('legacy assertions', async () => {
    process.env['SRE_AGENT_MODE'] = 'agentic';
    process.env['INVESTIGATE_GATHER_MODE'] = '';
    process.env['ORCHESTRATOR_GRAPH_MODE'] = '';
    process.env['USE_CAPABILITY_PLANNER'] = '';

    const { resolveAgentMode } = await import('../src/agent-mode.js');

    const mode = resolveAgentMode();
    assert.equal(mode.investigateGatherMode, 'tool_loop', 'blank INVESTIGATE_GATHER_MODE → tool_loop');
    assert.equal(mode.graphMode, 'react', 'blank ORCHESTRATOR_GRAPH_MODE → react');
    assert.equal(mode.useCapabilityPlanner, true, 'blank USE_CAPABILITY_PLANNER → true when agentic');
  });
});
