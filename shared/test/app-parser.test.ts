import assert from 'node:assert/strict';
import { parseAppInvestigation } from '../../agents/commander/src/parser.js';
import { describe, test } from 'vitest';

describe('app-parser', () => {
  test('legacy assertions', () => {
    const cases: Array<{ text: string; appId: string; ns?: string }> = [
      { text: "why isn't app checkout working", appId: 'checkout' },
      { text: "why isn't the checkout app working", appId: 'checkout' },
      { text: 'investigate app commander in sre-bot-system', appId: 'commander', ns: 'sre-bot-system' },
      { text: 'app review for redis', appId: 'redis' },
      { text: 'fix app commander', appId: 'commander' },
    ];

    for (const { text, appId, ns } of cases) {
      const cmd = parseAppInvestigation(text);
      assert.ok(cmd, `expected parse for: ${text}`);
      assert.equal(cmd!.scope, 'app');
      assert.equal(cmd!.resourceName, appId);
      if (ns) assert.equal(cmd!.namespace, ns);
    }

    assert.equal(parseAppInvestigation('investigate cluster health')?.scope, undefined);
  });
});
