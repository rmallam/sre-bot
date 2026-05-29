import assert from 'node:assert/strict';
import { parseDelete, parseCommand } from '../../agents/commander/src/parser.js';

const del = parseDelete('delete httpd from default namespace');
assert.ok(del);
assert.equal(del?.type, 'delete');
assert.equal(del?.resourceName, 'httpd');
assert.equal(del?.namespace, 'default');

const viaCmd = parseCommand('remove nginx in staging namespace');
assert.equal(viaCmd.type, 'delete');
assert.equal(viaCmd.type === 'delete' && viaCmd.resourceName, 'nginx');

const notPods = parseCommand('delete httpd from default namespace');
assert.notEqual(notPods.type, 'get');

console.log('delete-parse.test.ts: ok');
