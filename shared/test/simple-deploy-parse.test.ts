import assert from 'node:assert/strict';
import { parseSimpleDeploy, deployParseHint } from '../../agents/commander/src/parser.js';
import { describe, test } from 'vitest';

describe('simple-deploy-parse', () => {
  test('legacy assertions', () => {
    const httpd = parseSimpleDeploy('Deploy httpd container in simple namespace');
    assert.ok(httpd);
    assert.equal(httpd?.namespace, 'simple');
    assert.equal(httpd?.appName, 'httpd');
    assert.ok(httpd?.containerImage?.includes('httpd'));

    const httpsFix = parseSimpleDeploy('Deploy https into simple namespace');
    assert.ok(httpsFix);
    assert.equal(httpsFix?.appName, 'httpd');

    const redisHa = parseSimpleDeploy('deploy redis HA into redis namespace');
    assert.ok(redisHa);
    assert.equal(redisHa?.namespace, 'redis');
    assert.equal(redisHa?.appName, 'redis');

    const redisIntoThe = parseSimpleDeploy('deploy redis HA into the redis namespace');
    assert.ok(redisIntoThe);
    assert.equal(redisIntoThe?.namespace, 'redis');

    const gh = parseSimpleDeploy('deploy github.com/org/app in simple');
    assert.equal(gh, null);

    const hint = deployParseHint('deploy mycustomapp in dev');
    assert.ok(hint?.includes('Helm tools'));
  });
});
