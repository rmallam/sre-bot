import assert from 'node:assert/strict';
import { parseSimpleDeploy, deployParseHint } from '../../agents/commander/src/parser.js';

const httpd = parseSimpleDeploy('Deploy httpd container in simple namespace');
assert.ok(httpd);
assert.equal(httpd?.namespace, 'simple');
assert.equal(httpd?.appName, 'httpd');
assert.ok(httpd?.containerImage?.includes('httpd'));

const httpsFix = parseSimpleDeploy('Deploy https into simple namespace');
assert.ok(httpsFix);
assert.equal(httpsFix?.appName, 'httpd');

const gh = parseSimpleDeploy('deploy github.com/org/app in simple');
assert.equal(gh, null);

const hint = deployParseHint('deploy mycustomapp in dev');
assert.ok(hint?.includes('Built-in apps'));

console.log('simple-deploy-parse tests OK');
