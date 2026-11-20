// Scoreboard: success rates, Elo contests, average rounds, cost tokens.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { computeScoreboard } from '../src/scoreboard.js';

function seed(): Store {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-score-')), 'db.sqlite'));
  const m = store.createMission({ goal: 'test', repo: '/tmp/repo', source: 'codex' });
  // Task 1: codebuddy fails, qoder passes (contest: qoder wins Elo).
  const t1 = store.createTask({ missionId: m.id, key: 't1', title: 'one', contract: 'c' });
  const a1 = store.createAttempt({ taskId: t1.id, agent: 'codebuddy' });
  store.updateAttempt(a1.id, { status: 'failed', exitCode: 1 });
  const a2 = store.createAttempt({ taskId: t1.id, agent: 'qoder' });
  store.updateAttempt(a2.id, { status: 'done', exitCode: 0 });
  store.addEvent(a2.id, 'cost', { usage: { inputTokens: 100, outputTokens: 50 } });
  // Task 2: codebuddy passes alone (no opponent, no Elo change).
  const t2 = store.createTask({ missionId: m.id, key: 't2', title: 'two', contract: 'c' });
  const a3 = store.createAttempt({ taskId: t2.id, agent: 'codebuddy' });
  store.updateAttempt(a3.id, { status: 'done', exitCode: 0 });
  return store;
}

describe('scoreboard', () => {
  it('computes success rates, Elo, rounds and tokens', () => {
    const store = seed();
    try {
      const board = computeScoreboard(store);
      const codebuddy = board.agents.find((a) => a.agent === 'codebuddy');
      const qoder = board.agents.find((a) => a.agent === 'qoder');
      assert.ok(codebuddy && qoder);
      assert.equal(codebuddy.attempts, 2);
      assert.equal(codebuddy.passed, 1);
      assert.equal(codebuddy.failed, 1);
      assert.equal(codebuddy.successRate, 0.5);
      assert.equal(codebuddy.avgAttemptsPerTask, 1);
      assert.equal(qoder.attempts, 1);
      assert.equal(qoder.successRate, 1);
      assert.equal(qoder.inputTokens, 100);
      assert.equal(qoder.outputTokens, 50);
      // Elo: qoder beat codebuddy once, so qoder > 1200 > codebuddy.
      assert.ok(qoder.elo > 1200);
      assert.ok(codebuddy.elo < 1200);
      assert.equal(codebuddy.inputTokens, null);
      // Sorted by Elo descending.
      assert.equal(board.agents[0].agent, 'qoder');
    } finally {
      store.close();
    }
  });

  it('returns an empty board for an empty store', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-score-')), 'db.sqlite'));
    try {
      const board = computeScoreboard(store);
      assert.deepEqual(board.agents, []);
    } finally {
      store.close();
    }
  });
});
