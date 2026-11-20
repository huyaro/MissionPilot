// reviser tests — revise (<=2) -> reroute -> replan.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { decideNextAction, MAX_REVISIONS } from '../src/reviser.js';
import type { VerifyResult } from '../src/verifier.js';
import { tempDbPath } from './helpers.js';

const failedVerify: VerifyResult = {
  passed: false,
  checks: [{ name: 'repo:test', status: 'fail', detail: 'npm run test failed' }],
  review: { reviewer: 'qoder', verdict: 'fail', notes: 'contract not met' },
};

describe('reviser', () => {
  it('revises with the same agent while revisions remain', () => {
    const store = new Store(tempDbPath());
    try {
      const m = store.createMission({ goal: 'g', repo: '/tmp/r', source: 'codex' });
      const t = store.createTask({
        missionId: m.id,
        key: 't1',
        title: 'T',
        prompt: 'do it',
        contract: 'c',
        acceptance: 'a',
      });
      const a = store.createAttempt({ taskId: t.id, agent: 'codebuddy' });
      const d = decideNextAction(t, a, failedVerify);
      assert.equal(d.action, 'revise');
      if (d.action === 'revise') {
        assert.equal(d.agent, 'codebuddy');
        assert.match(d.prompt, /repo:test FAILED/);
        assert.match(d.prompt, /contract not met/);
      }
      assert.equal(MAX_REVISIONS, 2);
    } finally {
      store.close();
    }
  });

  it('reroutes to the other agent after 2 revisions', () => {
    const store = new Store(tempDbPath());
    try {
      const m = store.createMission({ goal: 'g', repo: '/tmp/r', source: 'codex' });
      const t = store.createTask({
        missionId: m.id,
        key: 't1',
        title: 'T',
        prompt: 'do it',
        contract: 'c',
        acceptance: 'a',
      });
      store.updateTaskFields(t.id, { revisionsUsed: 2 });
      const t2 = store.getTask(t.id);
      const a = store.createAttempt({ taskId: t.id, agent: 'codebuddy' });
      const d = decideNextAction(t2!, a, failedVerify);
      assert.equal(d.action, 'reroute');
      if (d.action === 'reroute') assert.equal(d.agent, 'qoder');
    } finally {
      store.close();
    }
  });

  it('proposes a replan after reroute also fails', () => {
    const store = new Store(tempDbPath());
    try {
      const m = store.createMission({ goal: 'g', repo: '/tmp/r', source: 'codex' });
      const t = store.createTask({
        missionId: m.id,
        key: 't1',
        title: 'T',
        prompt: 'do it',
        contract: 'c',
        acceptance: 'a',
      });
      store.updateTaskFields(t.id, { revisionsUsed: 2, rerouted: true });
      const t2 = store.getTask(t.id);
      const a = store.createAttempt({ taskId: t.id, agent: 'qoder' });
      const d = decideNextAction(t2!, a, failedVerify);
      assert.equal(d.action, 'replan');
      if (d.action === 'replan') assert.match(d.reason, /t1/);
    } finally {
      store.close();
    }
  });
});
