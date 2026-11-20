// Ledger: append-only hash chain — verify passes, tampering is detected.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { appendLedger, verifyLedger } from '../src/ledger.js';

describe('ledger', () => {
  it('chains entries and verifies', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-ledger-')), 'db.sqlite'));
    try {
      const e1 = appendLedger(store, 'mission_created', 'm_1', 'm_1', 'mission started');
      const e2 = appendLedger(store, 'attempt_finished', 'att_1', 'm_1', 'codebuddy done');
      assert.equal(e1.seq, 1);
      assert.equal(e2.seq, 2);
      assert.equal(e2.prevHash, e1.hash);
      assert.deepEqual(verifyLedger(store), { ok: true });
      assert.equal(store.listLedgerEntries('m_1').length, 2);
      assert.equal(store.listLedgerEntries('m_other').length, 0);
    } finally {
      store.close();
    }
  });

  it('detects a tampered row', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'orch-ledger-')), 'db.sqlite');
    const store = new Store(dbPath);
    try {
      appendLedger(store, 'mission_created', 'm_1', 'm_1', 'original');
      appendLedger(store, 'attempt_finished', 'att_1', 'm_1', 'done');
      // Rewrite a detail in place, bypassing the ledger API.
      (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
        "UPDATE ledger SET detail = 'forged' WHERE seq = 1",
      );
      const result = verifyLedger(store);
      assert.equal(result.ok, false);
      assert.equal(result.badSeq, 1);
    } finally {
      store.close();
    }
  });
});
