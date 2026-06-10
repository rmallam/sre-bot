import assert from 'node:assert/strict';
import {
  parseCommand,
  parseRegexFastPath,
  extractGithubRepo,
} from '../src/parser.js';
import { commandIntentToParsed } from '../src/intent-mapper.js';
import {
  normalizeDeployCommand,
  validateDeployCommand,
  defaultDeployNamespace,
} from '../../../shared/src/deploy-command.js';
import { evaluateDeployConfidence } from '../../../shared/src/deploy-confidence.js';
import { describe, test } from 'vitest';

describe('deploy-parser', () => {
  test('legacy assertions', () => {
    const USER_MSG =
      'deploy frappe-operators latest from this repo https://github.com/vyogotech/frappe-operator';

    // ── Regex parser ─────────────────────────────────────────────────────────────

    assert.equal(extractGithubRepo(USER_MSG), 'github.com/vyogotech/frappe-operator');

    const parsed = parseCommand(USER_MSG);
    assert.equal(parsed.type, 'deploy');
    if (parsed.type === 'deploy') {
      assert.equal(parsed.githubRepo, 'github.com/vyogotech/frappe-operator');
      assert.equal(parsed.gitRef, 'latest');
    }

    const fast = parseRegexFastPath(USER_MSG);
    assert.ok(fast && fast.type === 'deploy');

    const normalized = normalizeDeployCommand(
      parsed.type === 'deploy' ? parsed : ({} as never)
    );
    assert.equal(normalized.namespace, 'frappe-operator-system');
    assert.equal(normalized.appName, 'frappe-operator');

    const validated = validateDeployCommand(
      parsed.type === 'deploy' ? parsed : ({} as never)
    );
    assert.equal(validated.ok, true);
    if (validated.ok) {
      assert.equal(validated.appName, 'frappe-operator');
      assert.equal(validated.deploy.namespace, 'frappe-operator-system');
      assert.equal(validated.deploy.gitRef, 'latest');
    }

    // ── LLM intent with empty namespace (regression) ─────────────────────────────

    const llmDeploy = commandIntentToParsed(
      {
        intent: 'deploy',
        confidence: 0.9,
        githubRepo: 'https://github.com/vyogotech/frappe-operator',
        namespace: '',
        gitRef: 'latest',
        userReply: 'Starting deploy…',
      },
      USER_MSG
    );
    assert.ok(llmDeploy && llmDeploy.type === 'deploy');
    assert.equal(llmDeploy.githubRepo, 'github.com/vyogotech/frappe-operator');

    const llmDeployMalformed = commandIntentToParsed(
      {
        intent: 'deploy',
        confidence: 0.9,
        githubRepo: 'github.com/https://github.com/vyogotech/frappe-operator',
        namespace: '',
        gitRef: 'latest',
        userReply: 'Starting deploy…',
      },
      USER_MSG
    );
    assert.ok(llmDeployMalformed && llmDeployMalformed.type === 'deploy');
    assert.equal(llmDeployMalformed.githubRepo, 'github.com/vyogotech/frappe-operator');
    const llmValidated = validateDeployCommand(llmDeploy);
    assert.equal(llmValidated.ok, true);
    if (llmValidated.ok) {
      assert.equal(llmValidated.deploy.namespace, 'frappe-operator-system');
      assert.equal(llmValidated.deploy.githubRepo, 'github.com/vyogotech/frappe-operator');
    }

    // ── "from this repo" must not become namespace ───────────────────────────────

    const fromThisRepo = parseCommand(
      'deploy https://github.com/vyogotech/frappe-operator from this repo'
    );
    assert.equal(fromThisRepo.type, 'deploy');
    if (fromThisRepo.type === 'deploy') {
      const ns = normalizeDeployCommand(fromThisRepo).namespace;
      assert.notEqual(ns, 'this');
      assert.notEqual(ns, 'repo');
      assert.equal(ns, 'frappe-operator-system');
    }

    assert.equal(defaultDeployNamespace('frappe-operator'), 'frappe-operator-system');
    assert.equal(defaultDeployNamespace('my-api'), 'default');

    // ── Confidence gate (golden utterance) ─────────────────────────────────────

    if (validated.ok) {
      const gate = evaluateDeployConfidence({
        rawText: USER_MSG,
        deploy: validated.deploy,
        routingConfidence: 0.9,
        routingSource: 'llm',
        regexDeploy: parsed.type === 'deploy' ? parsed : undefined,
        llmRawGithubRepo: 'github.com/https://github.com/vyogotech/frappe-operator',
      });
      assert.equal(gate.ok, true, `confidence gate should pass, score=${gate.score}`);
    }
  });
});
