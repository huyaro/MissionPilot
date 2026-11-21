// Schema v1 -> v2 migration tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Store } from '../src/store.js';
import { tempDbPath } from './helpers.js';

// The exact v1 schema (copied from the P0 store.ts).
const V1_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE missions (id TEXT PRIMARY KEY, goal TEXT NOT NULL, constraints TEXT, repo TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), key TEXT NOT NULL, title TEXT NOT NULL, contract TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent TEXT NOT NULL, worktree_path TEXT, status TEXT NOT NULL, exit_code INTEGER, stderr TEXT, diff_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE events (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE worktrees (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), repo TEXT NOT NULL, base_commit TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL);
`;

function makeV1Db(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(V1_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO missions (id, goal, constraints, repo, status, source, created_at, updated_at) VALUES ('m_old', 'old goal', NULL, '/tmp/r', 'created', 'codex', ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO tasks (id, mission_id, key, title, contract, status, created_at, updated_at) VALUES ('t_old', 'm_old', 'task-1', 'Old task', 'contract', 'pending', ?, ?)",
  ).run(now, now);
  db.close();
}

describe('store migration v1 -> v2', () => {
  it('migrates a v1 database in place, keeping its rows', () => {
    const dbPath = tempDbPath();
    makeV1Db(dbPath);
    const store = new Store(dbPath);
    try {
      const task = store.getTask('t_old');
      assert.ok(task);
      assert.equal(task.title, 'Old task');
      assert.deepEqual(task.dependsOn, []);
      assert.equal(task.acceptance, '');
      assert.equal(task.prompt, '');
      assert.equal(task.revisionsUsed, 0);
      assert.equal(task.rerouted, false);
      assert.equal(store.getMission('m_old')?.budget, null);
      // New writes work on the migrated schema.
      const t2 = store.createTask({
        missionId: 'm_old',
        key: 'task-2',
        title: 'New task',
        contract: 'c',
        acceptance: 'acceptance text',
        dependsOn: ['task-1'],
        estimate: 5,
      });
      assert.deepEqual(t2.dependsOn, ['task-1']);
      assert.equal(store.getTask(t2.id)?.estimate, 5);
    } finally {
      store.close();
    }
    // Reopening is a no-op (already v2).
    const again = new Store(dbPath);
    try {
      assert.equal(again.getTask('t_old')?.title, 'Old task');
    } finally {
      again.close();
    }
  });

  it('replan proposals round-trip', () => {
    const store = new Store(tempDbPath());
    try {
      const m = store.createMission({ goal: 'g', repo: '/tmp/r', source: 'codex' });
      const t = store.createTask({ missionId: m.id, key: 'k', title: 't', contract: 'c' });
      store.createReplanProposal({ missionId: m.id, taskId: t.id, reason: 'revise and reroute both failed' });
      const list = store.listReplanProposals(m.id);
      assert.equal(list.length, 1);
      assert.equal(list[0].reason, 'revise and reroute both failed');
    } finally {
      store.close();
    }
  });
});

// Schema v4 -> v5 migration: executor_config.models goes from string[] to
// [{id, reasoning, context}]; the old top-level reasoning column is folded
// into each model and then dropped.
const V4_EXECUTOR_CONFIG_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE executor_config (
  agent TEXT PRIMARY KEY,
  models TEXT NOT NULL DEFAULT '[]',
  default_model TEXT,
  reasoning TEXT,
  updated_at TEXT NOT NULL
);
`;

function makeV4Db(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(V4_EXECUTOR_CONFIG_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO executor_config (agent, models, default_model, reasoning, updated_at) VALUES ('codebuddy', ?, 'hy3', 'low', ?)",
  ).run(JSON.stringify(['hy3', 'deepseek-v4-pro']), now);
  // Default not in the list: migration falls back to the first model.
  db.prepare(
    "INSERT INTO executor_config (agent, models, default_model, reasoning, updated_at) VALUES ('qoder', ?, 'gone', 'medium', ?)",
  ).run(JSON.stringify(['auto']), now);
  db.close();
}

describe('store migration v4 -> v5', () => {
  it('migrates executor_config models to per-model objects and drops reasoning', () => {
    const dbPath = tempDbPath();
    makeV4Db(dbPath);
    const store = new Store(dbPath);
    try {
      const cb = store.getExecutorConfig('codebuddy');
      assert.deepEqual(cb?.models, [
        { id: 'hy3', reasoning: 'low', context: '128K' },
        { id: 'deepseek-v4-pro', reasoning: 'low', context: '128K' },
      ]);
      assert.equal(cb?.defaultModel, 'hy3');
      const q = store.getExecutorConfig('qoder');
      assert.deepEqual(q?.models, [{ id: 'auto', reasoning: 'medium', context: '128K' }]);
      assert.equal(q?.defaultModel, 'auto');
      // The reasoning column is gone; the schema version bumped.
      const probe = new DatabaseSync(dbPath);
      try {
        const cols = (
          probe.prepare('PRAGMA table_info(executor_config)').all() as Array<{ name: string }>
        ).map((c) => c.name);
        assert.ok(!cols.includes('reasoning'));
      } finally {
        probe.close();
      }
      // New writes work on the migrated schema.
      const next = store.upsertExecutorConfig('codebuddy', {
        models: [{ id: 'hy3', reasoning: 'high', context: '64K' }],
        defaultModel: 'hy3',
      });
      assert.deepEqual(next.models, [{ id: 'hy3', reasoning: 'high', context: '64K' }]);
      assert.equal(store.getExecutorConfig('codebuddy')?.models[0]?.context, '64K');
    } finally {
      store.close();
    }
  });
});
