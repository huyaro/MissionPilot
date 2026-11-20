// store (mission-store) tests — INV-8: state survives a backend restart.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tempDbPath } from './helpers.js';

describe('Store', () => {
  it('creates and reads back mission / task / attempt', () => {
    const store = new Store(tempDbPath());
    try {
      const m = store.createMission({ goal: 'test mission', repo: '/tmp/repo', source: 'codex' });
      assert.equal(m.status, 'created');
      const t = store.createTask({ missionId: m.id, key: 'task-1', title: 'Do it', contract: 'done' });
      assert.equal(t.status, 'pending');
      const a = store.createAttempt({ taskId: t.id, agent: 'codebuddy' });
      assert.equal(a.status, 'pending');
      assert.equal(a.exitCode, null);

      assert.equal(store.getMission(m.id)?.goal, 'test mission');
      assert.equal(store.getTask(t.id)?.title, 'Do it');
      assert.equal(store.getAttempt(a.id)?.agent, 'codebuddy');
      assert.equal(store.getMission('m_doesnotexist'), null);
    } finally {
      store.close();
    }
  });

  it('events get increasing seq numbers per attempt', () => {
    const store = new Store(tempDbPath());
    try {
      const m = store.createMission({ goal: 'g', repo: '/tmp/r', source: 'codex' });
      const t = store.createTask({ missionId: m.id, key: 'k', title: 't', contract: 'c' });
      const a = store.createAttempt({ taskId: t.id, agent: 'codebuddy' });
      store.addEvent(a.id, 'message', { text: 'hello' });
      store.addEvent(a.id, 'tool_call', { tool: 'write' });
      const events = store.listEvents(a.id);
      assert.equal(events.length, 2);
      assert.equal(events[0].seq, 1);
      assert.equal(events[1].seq, 2);
      assert.equal(events[1].type, 'tool_call');
    } finally {
      store.close();
    }
  });

  it('records survive close + reopen (INV-8)', () => {
    const dbPath = tempDbPath();
    let attemptId = '';
    {
      const store = new Store(dbPath);
      const m = store.createMission({ goal: 'persist', repo: '/tmp/r', source: 'codex' });
      const t = store.createTask({ missionId: m.id, key: 'k', title: 't', contract: 'c' });
      const a = store.createAttempt({ taskId: t.id, agent: 'codebuddy' });
      attemptId = a.id;
      store.addEvent(a.id, 'message', { text: 'before restart' });
      store.updateAttempt(a.id, { status: 'running' });
      store.close();
    }
    {
      const store = new Store(dbPath);
      try {
        const a = store.getAttempt(attemptId);
        assert.ok(a);
        assert.equal(a.status, 'running');
        assert.equal(store.listEvents(attemptId).length, 1);
        assert.equal(store.listRunningAttempts().length, 1);
      } finally {
        store.close();
      }
    }
  });

  it('updateAttempt rejects unknown attempt', () => {
    const store = new Store(tempDbPath());
    try {
      assert.throws(() => store.updateAttempt('att_nope', { status: 'done' }), /not found/);
    } finally {
      store.close();
    }
  });
});
