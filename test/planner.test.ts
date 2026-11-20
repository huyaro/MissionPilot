// planner-intake tests: create_mission / submit_plan validation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createMission, submitPlan } from '../src/planner.js';
import { tempDbPath } from './helpers.js';

function freshMission(budget?: number | null): { store: Store; missionId: string } {
  const store = new Store(tempDbPath());
  const m = createMission(store, { goal: 'build a thing', repo: '/tmp/r', budget });
  return { store, missionId: m.id };
}

const taskA = {
  key: 'a',
  title: 'Task A',
  prompt: 'do A',
  contract: 'A done',
  acceptance: 'A works',
};
const taskB = {
  key: 'b',
  title: 'Task B',
  prompt: 'do B',
  contract: 'B done',
  acceptance: 'B works',
  depends_on: ['a'],
};

describe('planner-intake', () => {
  it('accepts a valid plan and moves the mission to planned', () => {
    const { store, missionId } = freshMission();
    try {
      const r = submitPlan(store, { mission_id: missionId, tasks: [taskA, taskB] });
      assert.equal(r.taskIds.length, 2);
      assert.equal(store.getMission(missionId)?.status, 'planned');
      const tasks = store.listTasksByMission(missionId);
      assert.deepEqual(tasks.find((t) => t.key === 'b')?.dependsOn, ['a']);
    } finally {
      store.close();
    }
  });

  it('rejects a plan with a dependency cycle', () => {
    const { store, missionId } = freshMission();
    try {
      assert.throws(
        () =>
          submitPlan(store, {
            mission_id: missionId,
            tasks: [
              { ...taskA, depends_on: ['b'] },
              { ...taskB, depends_on: ['a'] },
            ],
          }),
        /cycle/,
      );
      assert.equal(store.getMission(missionId)?.status, 'created');
    } finally {
      store.close();
    }
  });

  it('rejects unknown dependencies, duplicate keys, missing acceptance', () => {
    const { store, missionId } = freshMission();
    try {
      assert.throws(
        () => submitPlan(store, { mission_id: missionId, tasks: [{ ...taskA, depends_on: ['zzz'] }] }),
        /unknown task/,
      );
      assert.throws(
        () => submitPlan(store, { mission_id: missionId, tasks: [taskA, taskA] }),
        /duplicate task key/,
      );
      assert.throws(
        () =>
          submitPlan(store, {
            mission_id: missionId,
            tasks: [{ ...taskA, acceptance: '  ' }],
          }),
        /acceptance/,
      );
    } finally {
      store.close();
    }
  });

  it('rejects unknown task fields instead of silently dropping them', () => {
    const { store, missionId } = freshMission();
    try {
      // dependsOn (camelCase) instead of depends_on: dropping it silently
      // would break the DAG, so the plan must be refused with a clear error.
      assert.throws(
        () =>
          submitPlan(store, {
            mission_id: missionId,
            tasks: [
              taskA,
              { ...taskB, dependsOn: ['a'] } as unknown as typeof taskB,
            ],
          }),
        /unknown field 'dependsOn'/,
      );
      // And the mission is still 'created' (rejection is atomic).
      assert.equal(store.getMission(missionId)?.status, 'created');
    } finally {
      store.close();
    }
  });

  it('rejects a plan whose estimates exceed the budget', () => {
    const { store, missionId } = freshMission(10);
    try {
      assert.throws(
        () =>
          submitPlan(store, {
            mission_id: missionId,
            tasks: [
              { ...taskA, estimate: 6 },
              { ...taskB, estimate: 5 },
            ],
          }),
        /exceeds mission budget/,
      );
      assert.throws(
        () => submitPlan(store, { mission_id: missionId, tasks: [taskA] }),
        /no estimate/,
      );
      const ok = submitPlan(store, {
        mission_id: missionId,
        tasks: [
          { ...taskA, estimate: 4 },
          { ...taskB, estimate: 5 },
        ],
      });
      assert.equal(ok.taskIds.length, 2);
    } finally {
      store.close();
    }
  });

  it('rejects a second plan for an already-planned mission', () => {
    const { store, missionId } = freshMission();
    try {
      submitPlan(store, { mission_id: missionId, tasks: [taskA] });
      assert.throws(
        () => submitPlan(store, { mission_id: missionId, tasks: [taskA] }),
        /only a 'created' mission/,
      );
    } finally {
      store.close();
    }
  });
});
