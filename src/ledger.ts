// Ledger: an append-only, hash-chained audit trail of the events that
// matter for the P3 board (attempt outcomes, verifications, merges,
// mission close-outs, approval decisions). Each entry commits to the
// previous entry's hash, so tampering with any row breaks verifyChain().
// The ledger is the audit record — it never drives scheduling.
import { createHash } from 'node:crypto';
import type { Store } from './store.js';

export type LedgerEntryType =
  | 'attempt_started'
  | 'attempt_finished'
  | 'attempt_verified'
  | 'attempt_merged'
  | 'mission_done'
  | 'mission_failed'
  | 'task_failed'
  | 'approval_created'
  | 'approval_decided'
  | 'mission_created';

export interface LedgerEntry {
  seq: number;
  ts: string;
  type: LedgerEntryType;
  refId: string | null;
  missionId: string | null;
  detail: string;
  prevHash: string;
  hash: string;
}

export function ledgerHash(
  prevHash: string,
  seq: number,
  ts: string,
  type: string,
  refId: string | null,
  missionId: string | null,
  detail: string,
): string {
  return createHash('sha256')
    .update(
      [prevHash, String(seq), ts, type, refId ?? '', missionId ?? '', detail].join('|'),
    )
    .digest('hex');
}

/** Append one entry; returns the stored row. Never throws on hash math —
 * callers decide whether a store failure is fatal (it usually is). */
export function appendLedger(
  store: Store,
  type: LedgerEntryType,
  refId: string | null,
  missionId: string | null,
  detail: string,
): LedgerEntry {
  const last = store.getLastLedgerEntry();
  const seq = (last?.seq ?? 0) + 1;
  const ts = new Date().toISOString();
  const prevHash = last?.hash ?? 'genesis';
  const hash = ledgerHash(prevHash, seq, ts, type, refId, missionId, detail);
  const entry: LedgerEntry = { seq, ts, type, refId, missionId, detail, prevHash, hash };
  store.insertLedgerEntry(entry);
  return entry;
}

/** Recompute the chain; returns the first bad seq, or ok. */
export function verifyLedger(store: Store): { ok: boolean; badSeq?: number } {
  const entries = store.listLedgerEntries();
  let prevHash = 'genesis';
  for (const e of entries) {
    const want = ledgerHash(e.prevHash, e.seq, e.ts, e.type, e.refId, e.missionId, e.detail);
    if (e.prevHash !== prevHash || e.hash !== want) return { ok: false, badSeq: e.seq };
    prevHash = e.hash;
  }
  return { ok: true };
}
