// Approvals: decision rules, reject-requires-reason, push execution.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import {
  createPushApproval,
  createReplanApproval,
  decideApproval,
  executeApprovedPush,
} from '../src/approvals.js';
import { verifyLedger } from '../src/ledger.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(cwd: string, name: string, content: string): void {
  writeFileSync(join(cwd, name), content);
}

describe('approvals', () => {
  it('reject requires a reason; decisions land in the ledger', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-appr-')), 'db.sqlite'));
    try {
      const m = store.createMission({ goal: 'g', repo: '/tmp/repo', source: 'codex' });
      const t = store.createTask({ missionId: m.id, key: 't1', title: 'one', contract: 'c' });
      const ap = createReplanApproval(store, m.id, t.id, 'both agents failed');
      assert.equal(ap.status, 'pending');
      assert.throws(() => decideApproval(store, ap.id, 'rejected', null), /reason/);
      const { approval } = decideApproval(store, ap.id, 'rejected', 'plan is fine, retry instead');
      assert.equal(approval.status, 'rejected');
      assert.equal(approval.reason, 'plan is fine, retry instead');
      assert.throws(() => decideApproval(store, ap.id, 'approved', null), /already rejected/);
      assert.deepEqual(verifyLedger(store), { ok: true });
      assert.ok(store.listLedgerEntries().some((e) => e.type === 'approval_decided'));
    } finally {
      store.close();
    }
  });

  it('approved push with no remote is honestly deferred', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-appr-')), 'db.sqlite'));
    try {
      const repo = mkdtempSync(join(tmpdir(), 'orch-repo-'));
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 't@t');
      git(repo, 'config', 'user.name', 't');
      writeFile(repo, 'f.txt', 'x');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init');
      const m = store.createMission({ goal: 'g', repo, source: 'codex' });
      const ap = createPushApproval(store, m.id, repo);
      decideApproval(store, ap.id, 'approved', null);
      const outcome = await executeApprovedPush(store, ap.id);
      assert.equal(outcome.pushed, false);
      assert.match(outcome.note, /no remote/);
    } finally {
      store.close();
    }
  });

  it('approved push with a local bare remote really pushes', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-appr-')), 'db.sqlite'));
    try {
      const repo = mkdtempSync(join(tmpdir(), 'orch-repo-'));
      const bare = mkdtempSync(join(tmpdir(), 'orch-bare-'));
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 't@t');
      git(repo, 'config', 'user.name', 't');
      writeFile(repo, 'f.txt', 'x');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init');
      git(bare, 'init', '-q', '--bare');
      git(repo, 'remote', 'add', 'origin', bare);
      git(repo, 'checkout', '-qb', 'orchestrator/integration');
      const m = store.createMission({ goal: 'g', repo, source: 'codex' });
      const ap = createPushApproval(store, m.id, repo);
      decideApproval(store, ap.id, 'approved', null);
      const outcome = await executeApprovedPush(store, ap.id);
      assert.equal(outcome.pushed, true);
      assert.match(outcome.note, /pushed/);
      const branches = git(bare, 'branch', '--format=%(refname:short)');
      assert.match(branches, /orchestrator\/integration/);
    } finally {
      store.close();
    }
  });
});
