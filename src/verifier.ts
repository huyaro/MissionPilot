// verifier (P1): hard checks + cross-vendor rubric review.
// INV-3: the verifier judges the diff, never exit 0 alone.
// INV-6: reviewer and maker are never the same vendor.
// Fail-closed: an unparseable review, a missing second vendor, or a
// reviewer that modifies the worktree all fail verification.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import type { Attempt, Task } from './store.js';
import { diffSummary } from './worktree.js';
import type { ExecutorAdapter } from './adapters/types.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface VerifyResult {
  passed: boolean;
  checks: CheckResult[];
  review: { reviewer: string; verdict: 'pass' | 'fail'; notes: string } | null;
}

const REPO_CHECK_SCRIPTS = ['test', 'typecheck', 'lint', 'build'] as const;

export function otherAgent(agent: string): string {
  return agent === 'codebuddy' ? 'qoder' : 'codebuddy';
}

export class Verifier {
  private store: Store;
  private adapters: Map<string, ExecutorAdapter>;
  private checkTimeoutMs: number;

  constructor(store: Store, adapters: Map<string, ExecutorAdapter>, checkTimeoutMs = 120_000) {
    this.store = store;
    this.adapters = adapters;
    this.checkTimeoutMs = checkTimeoutMs;
  }

  async verify(attempt: Attempt, task: Task): Promise<VerifyResult> {
    const checks: CheckResult[] = [];
    const diff = attempt.diffSummary ? (JSON.parse(attempt.diffSummary) as { filesChanged?: number; files?: string[] }) : null;
    const filesChanged = diff?.filesChanged ?? 0;
    const files: string[] = diff?.files ?? [];

    // 1. Non-empty diff (INV-3).
    checks.push(
      filesChanged === 0
        ? { name: 'diff_nonempty', status: 'fail', detail: 'empty diff: exit 0 alone proves nothing (INV-3)' }
        : { name: 'diff_nonempty', status: 'pass', detail: `${filesChanged} file(s) changed` },
    );

    // 2. Diff scope: every path stays inside the worktree.
    const bad = files.filter((f) => f.startsWith('/') || f.includes('..') || f.startsWith('.git/'));
    checks.push(
      bad.length > 0
        ? { name: 'diff_scope', status: 'fail', detail: `out-of-scope paths: ${bad.join(', ')}` }
        : { name: 'diff_scope', status: 'pass', detail: 'all paths inside the worktree' },
    );

    // 3. Repo checks (detected from package.json scripts; skipped when absent).
    if (attempt.worktreePath) {
      checks.push(...(await this.runRepoChecks(attempt.worktreePath)));
    }

    // 4. Cross-vendor review (INV-6). Skipped when the diff is empty —
    // the hard checks already fail, and there is nothing to review.
    let review: VerifyResult['review'] = null;
    if (attempt.worktreePath && filesChanged > 0) {
      review = await this.review(attempt, task);
    }

    const passed =
      checks.every((c) => c.status !== 'fail') && (review === null || review.verdict === 'pass');
    const result: VerifyResult = { passed, checks, review };
    this.store.updateAttempt(attempt.id, { evidence: JSON.stringify(result) });
    log('info', 'attempt verified', { attemptId: attempt.id, passed });
    return result;
  }

  private async runRepoChecks(worktreePath: string): Promise<CheckResult[]> {
    const pkgPath = join(worktreePath, 'package.json');
    if (!existsSync(pkgPath)) {
      return [{ name: 'repo_checks', status: 'skip', detail: 'no package.json in worktree' }];
    }
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      return [{ name: 'repo_checks', status: 'fail', detail: 'package.json is not valid JSON' }];
    }
    const present = REPO_CHECK_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
    if (present.length === 0) {
      return [{ name: 'repo_checks', status: 'skip', detail: 'no test/typecheck/lint/build script found' }];
    }
    const results: CheckResult[] = [];
    for (const name of present) {
      try {
        await execFileAsync('npm', ['run', name, '--silent'], {
          cwd: worktreePath,
          timeout: this.checkTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });
        results.push({ name: `repo:${name}`, status: 'pass', detail: `npm run ${name} exited 0` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name: `repo:${name}`, status: 'fail', detail: `npm run ${name} failed: ${message.slice(0, 500)}` });
      }
    }
    return results;
  }

  private async review(attempt: Attempt, task: Task): Promise<NonNullable<VerifyResult['review']>> {
    const reviewerAgent = otherAgent(attempt.agent);
    const reviewer = this.adapters.get(reviewerAgent);
    if (!reviewer) {
      return {
        reviewer: reviewerAgent,
        verdict: 'fail',
        notes: `no second-vendor reviewer available (maker is ${attempt.agent})`,
      };
    }
    const worktreePath = attempt.worktreePath as string;
    const diffBefore = await diffSummary(worktreePath).catch(() => null);
    const diff = attempt.diffSummary ? JSON.parse(attempt.diffSummary) : { files: [] };
    const prompt = [
      'You are a code reviewer. Review the change below against the task contract.',
      'Do NOT modify any file. Reply with exactly one JSON object: {"verdict":"pass"|"fail","notes":"..."}',
      '',
      `Task: ${task.title}`,
      `Contract: ${task.contract}`,
      `Acceptance: ${task.acceptance}`,
      `Changed files: ${(diff.files as string[]).join(', ')}`,
    ].join('\n');

    const texts: string[] = [];
    await reviewer.run({
      prompt,
      cwd: worktreePath,
      onEvent: (e) => {
        if (e.type === 'message') {
          const p = e.payload as { content?: unknown; text?: unknown };
          const t = typeof p.content === 'string' ? p.content : typeof p.text === 'string' ? p.text : '';
          if (t) texts.push(t);
        }
      },
    });

    // The reviewer must not have touched the worktree.
    const diffAfter = await diffSummary(worktreePath).catch(() => null);
    if (
      diffBefore &&
      diffAfter &&
      (diffBefore.filesChanged !== diffAfter.filesChanged ||
        JSON.stringify(diffBefore.files) !== JSON.stringify(diffAfter.files))
    ) {
      return { reviewer: reviewerAgent, verdict: 'fail', notes: 'reviewer modified the worktree; review rejected' };
    }

    const verdict = parseVerdict(texts.join('\n'));
    if (!verdict) {
      return { reviewer: reviewerAgent, verdict: 'fail', notes: 'reviewer returned no parseable verdict' };
    }
    return { reviewer: reviewerAgent, verdict: verdict.verdict, notes: verdict.notes };
  }
}

/** Find the last {"verdict":"pass"|"fail",...} object in reviewer output. */
export function parseVerdict(text: string): { verdict: 'pass' | 'fail'; notes: string } | null {
  const re = /\{[^{}]*"verdict"\s*:\s*"(pass|fail)"[^{}]*\}/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  try {
    const obj = JSON.parse(last[0]) as { verdict?: unknown; notes?: unknown };
    if (obj.verdict !== 'pass' && obj.verdict !== 'fail') return null;
    return { verdict: obj.verdict, notes: typeof obj.notes === 'string' ? obj.notes : '' };
  } catch {
    return null;
  }
}
