// worktree-mgr tests — INV-2: one attempt, one worktree; main never written to.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitWorktree,
  createWorktree,
  diffSummary,
  ensureIntegrationBranch,
  mergeCommitToIntegration,
  removeWorktree,
  resolveDispatchBase,
  resolveHeadCommit,
} from '../src/worktree.js';
import { makeTempGitRepo, git } from './helpers.js';

describe('worktree-mgr', () => {
  it('creates a detached worktree at HEAD and main stays clean', async () => {
    const repo = await makeTempGitRepo();
    const head = await resolveHeadCommit(repo);
    const wtPath = join(repo, '..', `orch-test-wt-${Date.now()}`);
    const info = await createWorktree(repo, wtPath);
    try {
      assert.equal(info.baseCommit, head);
      assert.ok(existsSync(join(wtPath, 'README.md')));
      // Main repo untouched.
      assert.equal(await git(repo, ['status', '--porcelain']), '');
      // No diff yet.
      const empty = await diffSummary(wtPath);
      assert.equal(empty.filesChanged, 0);
      // Edit inside the worktree only.
      writeFileSync(join(wtPath, 'hello.ts'), 'export const hello = () => "hi";\n');
      const diff = await diffSummary(wtPath);
      assert.equal(diff.filesChanged, 1);
      assert.deepEqual(diff.files, ['hello.ts']);
      assert.equal(diff.insertions, 0); // untracked file: no tracked insertions
      // Main repo still untouched (INV-2).
      assert.equal(await git(repo, ['status', '--porcelain']), '');
    } finally {
      await removeWorktree(repo, wtPath);
    }
  });

  it('diff counts tracked modifications with insertions/deletions', async () => {
    const repo = await makeTempGitRepo();
    const wtPath = join(repo, '..', `orch-test-wt2-${Date.now()}`);
    await createWorktree(repo, wtPath);
    try {
      writeFileSync(join(wtPath, 'README.md'), '# test repo\nline two\nline three\n');
      const diff = await diffSummary(wtPath);
      assert.equal(diff.filesChanged, 1);
      assert.equal(diff.insertions, 2);
      assert.equal(diff.deletions, 0);
    } finally {
      await removeWorktree(repo, wtPath);
    }
  });

  it('resolveHeadCommit throws on a non-git directory', async () => {
    await assert.rejects(() => resolveHeadCommit('/tmp'), /fatal|not a git repository/);
  });

  it('resolveDispatchBase prefers the integration head once it exists', async () => {
    const repo = await makeTempGitRepo();
    const head = await resolveHeadCommit(repo);
    // No integration branch yet: base is the repo HEAD.
    assert.equal(await resolveDispatchBase(repo), head);
    // Create the integration branch at a different commit: base follows it.
    const wtPath = join(repo, '..', `orch-test-wt3-${Date.now()}`);
    const info = await createWorktree(repo, wtPath);
    try {
      writeFileSync(join(wtPath, 'hello.ts'), 'export const hello = () => "hi";\n');
      const sha = await commitWorktree(wtPath, 'attempt: add hello.ts');
      await ensureIntegrationBranch(repo, info.baseCommit);
      await mergeCommitToIntegration(repo, sha, 'merge attempt: add hello.ts');
      const integrationHead = await git(repo, ['rev-parse', 'orchestrator/integration']);
      assert.notEqual(integrationHead, head);
      assert.equal(await resolveDispatchBase(repo), integrationHead);
    } finally {
      await removeWorktree(repo, wtPath);
    }
  });
});
