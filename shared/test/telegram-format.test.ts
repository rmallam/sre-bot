import assert from 'node:assert/strict';
import {
  markdownToTelegramHtml,
  plainTelegramFallback,
  splitTelegramMessage,
} from '../src/telegram-format.js';
import { describe, test } from 'vitest';

describe('telegram-format', () => {
  test('legacy assertions', () => {
    const html = markdownToTelegramHtml(
      'Pods in **sre-bot-system**:\n\n```\nNAME    STATUS\na       Running\n```'
    );
    assert.match(html, /<b>sre-bot-system<\/b>/);
    assert.match(html, /<pre>NAME\s+STATUS/);
    assert.match(html, /Running/);

    const inline = markdownToTelegramHtml('Incident `abc-123` failed');
    assert.match(inline, /<code>abc-123<\/code>/);

    const parts = splitTelegramMessage('a'.repeat(5000), 4096);
    assert.equal(parts.length, 2);
    assert.ok(parts[0]!.length <= 4096);

    const plain = plainTelegramFallback('**bold** and `code`');
    assert.equal(plain, 'bold and code');
  });
});
