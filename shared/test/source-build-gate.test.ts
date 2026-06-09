import assert from 'node:assert/strict';
import {
  shouldRunSourceBuild,
  sourceBuildRequiresHil,
  sourceBuildEnabled,
} from '../src/deploy/source-build-gate.js';

const prev = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in prev)) delete process.env[key];
  }
  Object.assign(process.env, prev);
}

process.env['SOURCE_BUILD_ENABLED'] = 'true';
assert.equal(sourceBuildEnabled(), true);

assert.equal(
  shouldRunSourceBuild({
    mode: 'pre-deploy',
    needsImageBuild: true,
    buildStrategy: 'buildpacks',
  }),
  true
);

assert.equal(
  shouldRunSourceBuild({
    mode: 'diagnose',
    needsImageBuild: true,
    buildStrategy: 'buildpacks',
  }),
  false
);

assert.equal(
  shouldRunSourceBuild({
    mode: 'pre-deploy',
    needsImageBuild: true,
    buildStrategy: 'buildpacks',
    suggestedImage: 'ghcr.io/org/app:main',
  }),
  false
);

process.env['SOURCE_BUILD_TRUSTED_REPOS'] = 'my-org/apps';
assert.equal(sourceBuildRequiresHil('github.com/my-org/apps/demo'), false);
assert.equal(sourceBuildRequiresHil('https://github.com/other/demo'), true);

process.env['SOURCE_BUILD_REQUIRE_HIL'] = 'false';
assert.equal(sourceBuildRequiresHil('github.com/other/demo'), false);

restoreEnv();
console.log('source-build-gate.test.ts ok');
