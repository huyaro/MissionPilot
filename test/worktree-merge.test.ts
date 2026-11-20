// merge-back tests — commit worktree, merge to integration branch (INV-7).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWorktree,
  commitWorktree,
  ensureIntegrationBranch,
  mergeCommitToIntegration,
  INTEGRATION_BRANCH,
} from '../src/worktree.js';
import { makeTempGitRepo, git } from './helpers.js';

describe('merge-back', () => {
  it('merges a verified attempt commit into the integration branch, not main', async () => {
    const repo = await makeTempGitRepo();
    const base = await git(repo, ['rev-parse', 'HEAD']);
    const wtPath = join(repo, '..', `orch-merge-wt-${Date.now()}`);
    await createWorktree(repo, wtPath, base);
    writeFileSync(join(wtPath, 'hello.ts'), 'export const hello = () => "hi";\n');
    const sha = await commitWorktree(wtPath, 'attempt: add hello');
    await ensureIntegrationBranch(repo, base);
    await mergeCommitToIntegration(repo, sha, 'merge attempt: add hello');
    // Integration branch has the file; main does not.
    assert.equal(await git(repo, ['show', `${INTEGRATION_BRANCH}:hello.ts`]), 'export const hello = () => "hi";');
    await assert.rejects(git(repo, ['show', 'main:hello.ts']));
    // Main still points at the base commit.
    assert.equal(await git(repo, ['rev-parse', 'main']), base);
  });

  it('a conflicting second attempt is aborted and throws, leaving integration clean', async () => {
    const repo = await makeTempGitRepo();
    const base = await git(repo, ['rev-parse', 'HEAD']);
    await ensureIntegrationBranch(repo, base);

    // First attempt changes the README line and merges cleanly.
    const wt1 = join(repo, '..', `orch-merge-wt1-${Date.now()}`);
    await createWorktree(repo, wt1, base);
    writeFileSync(join(wt1, 'README.md'), '# test repo\nattempt one\n');
    const sha1 = await commitWorktree(wt1, 'attempt one');
    await mergeCommitToIntegration(repo, sha1, 'merge attempt one');

    // Second attempt (same base) changes the same line differently.
    const wt2 = join(repo, '..', `orch-merge-wt2-${Date.now()}`);
    await createWorktree(repo, wt2, base);
    writeFileSync(join(wt2, 'README.md'), '# test repo\nattempt two\n');
    const sha2 = await commitWorktree(wt2, 'attempt two');
    await assert.rejects(mergeCommitToIntegration(repo, sha2, 'merge attempt two'));
    // Integration still holds only the first merge; working tree is clean (aborted).
    const log = await git(repo, ['log', '--oneline', INTEGRATION_BRANCH]);
    assert.match(log, /merge attempt one/);
    assert.doesNotMatch(log, /merge attempt two/);
    assert.equal(await git(repo, ['status', '--porcelain']), '');
  });
});
