// verifier tests — hard checks + cross-vendor review (INV-3, INV-6).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import type { Attempt, Task } from '../src/store.js';
import { Verifier, parseVerdict } from '../src/verifier.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { qoderAdapter } from '../src/adapters/qoder.js';
import { createWorktree, diffSummary } from '../src/worktree.js';
import { makeTempGitRepo, tempDbPath, git } from './helpers.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');

interface Fixture {
  store: Store;
  task: Task;
  attempt: Attempt;
  worktreePath: string;
}

async function setupFixture(opts: {
  reviewMode: string;
  repoTestScript?: string | null;
  writeFile?: boolean;
  adapters?: 'both' | 'codebuddy-only';
}): Promise<Fixture> {
  chmodSync(fakeBin, 0o755);
  process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
  process.env.ORCHESTRATOR_QODER_BIN = fakeBin;
  process.env.FAKE_MODE = opts.reviewMode;
  const store = new Store(tempDbPath());
  const repo = await makeTempGitRepo();
  if (opts.repoTestScript !== undefined && opts.repoTestScript !== null) {
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: opts.repoTestScript } }),
    );
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add package.json']);
  }
  const mission = store.createMission({ goal: 'g', repo, source: 'codex' });
  const task = store.createTask({
    missionId: mission.id,
    key: 't1',
    title: 'Add hello',
    prompt: 'add hello.ts',
    contract: 'hello.ts exists',
    acceptance: 'hello.ts exports hello',
  });
  const attempt = store.createAttempt({ taskId: task.id, agent: 'codebuddy' });
  const wtPath = join(mkdtempSync(join(tmpdir(), 'orch-verify-')), 'wt');
  await createWorktree(repo, wtPath);
  if (opts.writeFile !== false) {
    writeFileSync(join(wtPath, 'hello.ts'), 'export const hello = () => "hi";\n');
  }
  const diff = await diffSummary(wtPath);
  store.updateAttempt(attempt.id, {
    worktreePath: wtPath,
    status: 'done',
    exitCode: 0,
    diffSummary: JSON.stringify(diff),
  });
  return { store, task, attempt: store.getAttempt(attempt.id) as Attempt, worktreePath: wtPath };
}

function verifierFor(fx: Fixture, adapters: 'both' | 'codebuddy-only' = 'both'): Verifier {
  const map = new Map([['codebuddy', codebuddyAdapter]]);
  if (adapters === 'both') map.set('qoder', qoderAdapter);
  return new Verifier(fx.store, map, 30_000);
}

describe('verifier', () => {
  it('passes: non-empty diff + repo test green + cross-vendor review pass', async () => {
    const fx = await setupFixture({ reviewMode: 'review-pass', repoTestScript: 'node -e "process.exit(0)"' });
    try {
      const result = await verifierFor(fx).verify(fx.attempt, fx.task);
      assert.equal(result.passed, true);
      assert.equal(result.checks.find((c) => c.name === 'diff_nonempty')?.status, 'pass');
      assert.equal(result.checks.find((c) => c.name === 'repo:test')?.status, 'pass');
      assert.equal(result.review?.reviewer, 'qoder'); // INV-6: maker codebuddy -> reviewer qoder
      assert.equal(result.review?.verdict, 'pass');
      // Evidence is stored on the attempt.
      const stored = JSON.parse(fx.store.getAttempt(fx.attempt.id)?.evidence ?? '{}') as { passed?: boolean };
      assert.equal(stored.passed, true);
    } finally {
      fx.store.close();
    }
  });

  it('fails on empty diff (INV-3) and skips review', async () => {
    const fx = await setupFixture({ reviewMode: 'review-pass', writeFile: false });
    try {
      const result = await verifierFor(fx).verify(fx.attempt, fx.task);
      assert.equal(result.passed, false);
      assert.equal(result.checks.find((c) => c.name === 'diff_nonempty')?.status, 'fail');
      assert.equal(result.review, null);
    } finally {
      fx.store.close();
    }
  });

  it('fails when a repo check fails', async () => {
    const fx = await setupFixture({ reviewMode: 'review-pass', repoTestScript: 'node -e "process.exit(1)"' });
    try {
      const result = await verifierFor(fx).verify(fx.attempt, fx.task);
      assert.equal(result.passed, false);
      assert.equal(result.checks.find((c) => c.name === 'repo:test')?.status, 'fail');
    } finally {
      fx.store.close();
    }
  });

  it('fails when the cross-vendor review fails', async () => {
    const fx = await setupFixture({ reviewMode: 'review-fail' });
    try {
      const result = await verifierFor(fx).verify(fx.attempt, fx.task);
      assert.equal(result.passed, false);
      assert.equal(result.review?.verdict, 'fail');
    } finally {
      fx.store.close();
    }
  });

  it('fails when the reviewer modifies the worktree', async () => {
    const fx = await setupFixture({ reviewMode: 'review-modify' });
    try {
      const result = await verifierFor(fx).verify(fx.attempt, fx.task);
      assert.equal(result.passed, false);
      assert.match(result.review?.notes ?? '', /modified the worktree/);
    } finally {
      fx.store.close();
    }
  });

  it('fails closed when no second-vendor reviewer is available', async () => {
    const fx = await setupFixture({ reviewMode: 'review-pass' });
    try {
      const result = await verifierFor(fx, 'codebuddy-only').verify(fx.attempt, fx.task);
      assert.equal(result.passed, false);
      assert.match(result.review?.notes ?? '', /no second-vendor reviewer/);
    } finally {
      fx.store.close();
    }
  });
});

describe('parseVerdict', () => {
  it('takes the last verdict object; returns null when absent', () => {
    assert.deepEqual(
      parseVerdict('thinking...\n{"verdict":"fail","notes":"bad"}\n{"verdict":"pass","notes":"ok"}'),
      { verdict: 'pass', notes: 'ok' },
    );
    assert.equal(parseVerdict('no json here'), null);
    assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  });
});
