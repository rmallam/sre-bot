import assert from 'node:assert/strict';
import {
  evaluateDeployConfidence,
  rawTextHasExplicitNamespace,
} from '../src/deploy-confidence.js';
import { normalizeDeployCommand, validateDeployCommand } from '../src/deploy-command.js';

const USER_MSG =
  'deploy frappe-operators latest from this repo https://github.com/vyogotech/frappe-operator';

assert.equal(rawTextHasExplicitNamespace('deploy foo to staging namespace'), true);
assert.equal(rawTextHasExplicitNamespace(USER_MSG), false);

const validated = validateDeployCommand({
  type: 'deploy',
  githubRepo: 'github.com/vyogotech/frappe-operator',
  gitRef: 'latest',
  namespace: '',
  deployStrategy: 'gitops',
  deployStrategyExplicit: false,
});
assert.equal(validated.ok, true);
if (!validated.ok) throw new Error('expected valid deploy');

const regexDeploy = normalizeDeployCommand({
  type: 'deploy',
  githubRepo: 'github.com/vyogotech/frappe-operator',
  gitRef: 'latest',
  namespace: '',
  deployStrategy: 'gitops',
  deployStrategyExplicit: false,
});

// LLM path with high confidence + regex agreement should pass
const llmGood = evaluateDeployConfidence({
  rawText: USER_MSG,
  deploy: validated.deploy,
  routingConfidence: 0.9,
  routingSource: 'llm',
  regexDeploy,
  llmRawGithubRepo: 'https://github.com/vyogotech/frappe-operator',
});
assert.equal(llmGood.ok, true, `expected pass, score=${llmGood.score}`);
assert.ok(llmGood.score >= 0.75);

// Malformed LLM repo still passes when regex agrees (normalization fixes it)
const llmMalformed = evaluateDeployConfidence({
  rawText: USER_MSG,
  deploy: validated.deploy,
  routingConfidence: 0.9,
  routingSource: 'llm',
  regexDeploy,
  llmRawGithubRepo: 'github.com/https://github.com/vyogotech/frappe-operator',
});
assert.equal(llmMalformed.ok, true, `malformed should pass, score=${llmMalformed.score}`);
assert.ok(llmMalformed.reasons.includes('double_prefixed_repo'));

// Low routing confidence + repo mismatch should block
const blocked = evaluateDeployConfidence({
  rawText: USER_MSG,
  deploy: validated.deploy,
  routingConfidence: 0.4,
  routingSource: 'llm',
  regexDeploy: {
    githubRepo: 'github.com/other/wrong-repo',
    namespace: 'wrong-ns',
    gitRef: 'develop',
  },
});
assert.equal(blocked.ok, false, `expected block, score=${blocked.score}`);
assert.ok(blocked.clarifyMessage?.includes('vyogotech/frappe-operator'));

// Regex fast path without LLM metadata should pass
const regexPath = evaluateDeployConfidence({
  rawText: USER_MSG,
  deploy: validated.deploy,
  routingConfidence: 0.95,
  routingSource: 'regex',
  regexDeploy,
});
assert.equal(regexPath.ok, true);

// Follow-up confirmations skip the gate (handled in router); full fields still score high
const followUp = evaluateDeployConfidence({
  rawText: 'deploy github.com/vyogotech/frappe-operator to frappe-operator-system namespace',
  deploy: validated.deploy,
  routingSource: 'followup',
  regexDeploy,
});
assert.equal(followUp.ok, true, `followup score=${followUp.score}`);

console.log('deploy-confidence.test.ts ok');
