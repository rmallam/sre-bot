import assert from 'node:assert/strict';
import {
  looksLikeNewCommand,
  looksLikeUserMetaQuestion,
  shouldResumeCaseWithHint,
} from '../src/case-continuation.js';

assert.equal(looksLikeNewCommand('deploy httpd in simple namespace'), true);
assert.equal(looksLikeNewCommand('get pods in staging'), true);
assert.equal(looksLikeNewCommand('cancel run'), true);
assert.equal(looksLikeNewCommand('use ghcr.io/vyogotech/frappe-operator:latest'), false);

assert.equal(looksLikeUserMetaQuestion("I can't see anything there"), true);
assert.equal(looksLikeUserMetaQuestion('why am I getting the same again?'), true);

assert.equal(shouldResumeCaseWithHint('deploy httpd in simple namespace'), false);
assert.equal(shouldResumeCaseWithHint("I can't see anything there"), false);
assert.equal(
  shouldResumeCaseWithHint('set image to ghcr.io/vyogotech/frappe-operator:latest'),
  true
);
assert.equal(shouldResumeCaseWithHint('try again with latest tag'), true);

console.log('case-continuation.test.ts: ok');
