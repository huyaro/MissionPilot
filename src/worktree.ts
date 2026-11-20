// worktree-mgr (P0: create + isolate only; merge-back is P1).
// INV-2: one attempt, one worktree; --yolo/bypass only inside the worktree;
// main is never written to directly. Every worktree is a detached checkout
// at an exact base commit, registered in SQLite before work starts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface WorktreeInfo {
  path: string;
  baseCommit: string;
}

/** Branch that accumulates verified attempts, in DAG order (INV-7). */
export const INTEGRATION_BRANCH = 'orchestrator/integration';

async function git(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', repoPath, ...args], { maxBuffer: 10 * 1024 * 1024 });
}

/** Resolve a repo path to its HEAD commit. Throws if not a git repo. */
export async function resolveHeadCommit(repoPath: string): Promise<string> {
  const { stdout } = await git(repoPath, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

/**
 * Resolve the base commit a new worktree should start from.
 * DAG semantics (MILESTONES §9): a later task builds on the integration
 * branch head — the accumulated result of all previously merged tasks —
 * not on main's HEAD. Falls back to the repo HEAD when the integration
 * branch does not exist yet (first task of the first mission).
 */
export async function resolveDispatchBase(repoPath: string): Promise<string> {
  try {
    const { stdout } = await git(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${INTEGRATION_BRANCH}`,
    ]);
    const sha = stdout.trim();
    if (sha) return sha;
  } catch {
    // No integration branch yet — fall through to HEAD.
  }
  return resolveHeadCommit(repoPath);
}

/**
 * Create a detached worktree at `baseCommit` (default HEAD) under `worktreePath`.
 * The caller must register it in the store before the attempt starts.
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  baseCommit?: string,
): Promise<WorktreeInfo> {
  const base = baseCommit ?? (await resolveHeadCommit(repoPath));
  await git(repoPath, ['worktree', 'add', '--detach', worktreePath, base]);
  return { path: worktreePath, baseCommit: base };
}

/** Remove a worktree registration and its directory. Best-effort on missing paths. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
}

/** Commit everything in the worktree; returns the new commit SHA. */
export async function commitWorktree(worktreePath: string, message: string): Promise<string> {
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, [
    '-c',
    'user.name=MissionPilot',
    '-c',
    'user.email=missionpilot@local',
    'commit',
    '-m',
    message,
  ]);
  const { stdout } = await git(worktreePath, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/** Create the integration branch from the base commit if it does not exist yet. */
export async function ensureIntegrationBranch(repoPath: string, baseCommit: string): Promise<void> {
  if (!(await refExists(repoPath, `refs/heads/${INTEGRATION_BRANCH}`))) {
    await git(repoPath, ['branch', INTEGRATION_BRANCH, baseCommit]);
  }
}

/**
 * Merge a verified attempt commit into the integration branch (INV-7).
 * On conflict the merge is aborted and the error propagates — the caller
 * records it and does not leave a half-merged tree behind.
 */
export async function mergeCommitToIntegration(
  repoPath: string,
  commitSha: string,
  message: string,
): Promise<void> {
  await git(repoPath, ['checkout', INTEGRATION_BRANCH]);
  try {
    await git(repoPath, ['merge', '--no-ff', '-m', message, commitSha]);
  } catch (err) {
    await git(repoPath, ['merge', '--abort']).catch(() => undefined);
    throw err;
  }
}

/**
 * Diff of the worktree against its base commit. INV-3: the verifier (P1) judges
 * the diff, never exit 0 alone — an agent can exit 0 with an empty diff.
 */
export async function diffSummary(worktreePath: string): Promise<DiffSummary> {
  const { stdout: statusOut } = await git(worktreePath, ['status', '--porcelain']);
  const files = statusOut
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(3).trim());
  const { stdout: statOut } = await git(worktreePath, ['diff', '--shortstat', 'HEAD']);
  // e.g. " 2 files changed, 10 insertions(+), 3 deletions(-)"
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
    statOut,
  );
  // Untracked files don't show in `git diff`; status --porcelain lists them,
  // so files.length (from status) is the authoritative changed-file count.
  const trackedChanged = m ? Number(m[1]) : 0;
  return {
    filesChanged: Math.max(trackedChanged, files.length),
    insertions: m?.[2] ? Number(m[2]) : 0,
    deletions: m?.[3] ? Number(m[3]) : 0,
    files,
  };
}
