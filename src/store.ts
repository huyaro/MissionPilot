// mission-store: SQLite persistence for missions / tasks / attempts / events / worktrees.
// INV-8: every state transition lands in SQLite; a backend restart must not lose
// attempt records. Uses Node's built-in node:sqlite (DatabaseSync), no extra driver.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 5;

export type MissionStatus =
  | 'created'
  | 'planned'
  | 'executing'
  | 'done'
  | 'failed'
  | 'cancelled';
export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'leased'
  | 'running'
  | 'verifying'
  | 'done'
  | 'failed';
export type AttemptStatus = 'pending' | 'running' | 'done' | 'failed';
export type EventType = 'message' | 'tool_call' | 'file_edit' | 'cost';
export type BrainSource = 'codex' | 'chatgpt';

export interface Mission {
  id: string;
  goal: string;
  constraints: string | null;
  repo: string;
  /** Max total estimated cost in abstract units (planner budget); null = no budget. */
  budget: number | null;
  status: MissionStatus;
  source: BrainSource;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  missionId: string;
  key: string;
  title: string;
  /** Instructions for the executor (kept so revise/reroute can reuse them). */
  prompt: string;
  contract: string;
  /** Acceptance criteria; every task must have one (planner-intake enforces). */
  acceptance: string;
  /** Keys of tasks this one depends on (DAG edges). */
  dependsOn: string[];
  /** Estimated cost in abstract units (planner-supplied); null = unestimated. */
  estimate: number | null;
  mode: string | null;
  type: string | null;
  /** How many revise attempts have been spent on this task (P1 reviser, max 2). */
  revisionsUsed: number;
  /** Whether the task has already been rerouted to another agent. */
  rerouted: boolean;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  taskId: string;
  agent: string;
  worktreePath: string | null;
  status: AttemptStatus;
  exitCode: number | null;
  stderr: string | null;
  diffSummary: string | null;
  /** Verifier evidence (JSON) attached by P1 verification; null until verified. */
  evidence: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptEvent {
  id: string;
  attemptId: string;
  seq: number;
  type: EventType;
  payload: string;
  ts: string;
}

export interface Worktree {
  id: string;
  attemptId: string;
  repo: string;
  baseCommit: string;
  path: string;
  status: string;
  /** Commit the worktree was merged as (P1 merge-back); null until merged. */
  mergedCommit: string | null;
}

export interface ReplanProposal {
  id: string;
  missionId: string;
  taskId: string;
  reason: string;
  createdAt: string;
}

/** P3 ledger entry (hash-chained audit row; see ledger.ts). */
export interface LedgerRow {
  seq: number;
  ts: string;
  type: string;
  refId: string | null;
  missionId: string | null;
  detail: string;
  prevHash: string;
  hash: string;
}

export type ApprovalKind = 'replan' | 'push';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  missionId: string;
  taskId: string | null;
  summary: string;
  status: ApprovalStatus;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type ReasoningLevel = 'low' | 'medium' | 'high';

/** One configured model with its per-model dispatch settings. */
export interface ConfigModel {
  id: string;
  reasoning: ReasoningLevel;
  /** Context size label from CONTEXT_OPTIONS in executors.ts (e.g. '128K'). */
  context: string;
}

/**
 * P3 executor config, set from the board. The models array IS the enabled
 * set: a model not in the array is never used for dispatch. defaultModel
 * must be one of the array entries; when the default is deleted it falls
 * back to the first model in the array.
 */
export interface ExecutorConfig {
  agent: string;
  models: ConfigModel[];
  defaultModel: string | null;
  updatedAt: string;
}

/** Normalize a stored models value into ConfigModel[] (v4 rows stored string[]). */
export function migrateExecutorModels(raw: unknown, fallbackReasoning: string): ConfigModel[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const reasoning: ReasoningLevel =
    fallbackReasoning === 'low' || fallbackReasoning === 'medium' || fallbackReasoning === 'high'
      ? fallbackReasoning
      : 'high';
  const out: ConfigModel[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') out.push({ id: entry, reasoning, context: '128K' });
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id : '';
      if (id.trim() === '') continue;
      const r = rec.reasoning;
      out.push({
        id,
        reasoning: r === 'low' || r === 'medium' || r === 'high' ? r : 'high',
        context: typeof rec.context === 'string' && rec.context !== '' ? rec.context : '128K',
      });
    }
  }
  return out;
}

/** defaultModel must be in the list; otherwise the first model, else null. */
export function normalizeDefaultModel(models: ConfigModel[], defaultModel: string | null): string | null {
  if (defaultModel !== null && models.some((m) => m.id === defaultModel)) return defaultModel;
  return models[0]?.id ?? null;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Data dir: $ORCHESTRATOR_DATA_DIR, else ~/.mission-pilot. */
export function resolveDataDir(): string {
  return process.env.ORCHESTRATOR_DATA_DIR ?? join(homedir(), '.mission-pilot');
}

export function resolveDbPath(dataDir: string = resolveDataDir()): string {
  return join(dataDir, 'orchestrator.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  constraints TEXT,
  repo TEXT NOT NULL,
  budget INTEGER,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  contract TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]',
  estimate INTEGER,
  mode TEXT,
  type TEXT,
  revisions_used INTEGER NOT NULL DEFAULT 0,
  rerouted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent TEXT NOT NULL,
  worktree_path TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stderr TEXT,
  diff_summary TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  repo TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  merged_commit TEXT
);
CREATE TABLE IF NOT EXISTS replan_proposals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  ref_id TEXT,
  mission_id TEXT,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS executor_config (
  agent TEXT PRIMARY KEY,
  models TEXT NOT NULL DEFAULT '[]',
  default_model TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON events(attempt_id, seq);
CREATE INDEX IF NOT EXISTS idx_ledger_mission ON ledger(mission_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
    this.migrate();
  }

  /** Bring an older database up to the current schema (additive only). */
  private migrate(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    const version = row ? Number(row.value) : 1;
    const addCol = (table: string, col: string, def: string): void => {
      const cols = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!cols.has(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    if (version < 2) {
      addCol('tasks', 'acceptance', "TEXT NOT NULL DEFAULT ''");
      addCol('tasks', 'depends_on', "TEXT NOT NULL DEFAULT '[]'");
      addCol('tasks', 'estimate', 'INTEGER');
      addCol('tasks', 'mode', 'TEXT');
      addCol('tasks', 'type', 'TEXT');
      addCol('tasks', 'revisions_used', 'INTEGER NOT NULL DEFAULT 0');
      addCol('tasks', 'rerouted', 'INTEGER NOT NULL DEFAULT 0');
      addCol('worktrees', 'merged_commit', 'TEXT');
    }
    if (version < 3) {
      addCol('missions', 'budget', 'INTEGER');
      addCol('attempts', 'evidence', 'TEXT');
      addCol('tasks', 'prompt', "TEXT NOT NULL DEFAULT ''");
    }
    if (version < 4) {
      // CREATE TABLE IF NOT EXISTS in SCHEMA covers fresh DBs; older DBs
      // need the P3 tables too (SCHEMA already ran, so create here).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ledger (
          seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL,
          ref_id TEXT, mission_id TEXT, detail TEXT NOT NULL,
          prev_hash TEXT NOT NULL, hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL,
          mission_id TEXT NOT NULL REFERENCES missions(id), task_id TEXT,
          summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT, created_at TEXT NOT NULL, decided_at TEXT
        );
        CREATE TABLE IF NOT EXISTS executor_config (
          agent TEXT PRIMARY KEY, models TEXT NOT NULL DEFAULT '[]',
          default_model TEXT, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_mission ON ledger(mission_id);
        CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      `);
    }
    if (version < 5) {
      // Per-model config: executor_config.models goes from string[] to
      // [{id, reasoning, context}]; the old top-level reasoning column is
      // folded into each model and then dropped.
      const cols = new Set(
        (this.db.prepare('PRAGMA table_info(executor_config)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (cols.has('agent')) {
        const selectCols = ['agent', 'models', 'default_model'];
        if (cols.has('reasoning')) selectCols.push('reasoning');
        const rows = this.db
          .prepare(`SELECT ${selectCols.join(', ')} FROM executor_config`)
          .all() as Record<string, unknown>[];
        for (const row of rows) {
          const reasoning =
            typeof row.reasoning === 'string' ? row.reasoning : 'high';
          const models = migrateExecutorModels(row.models, reasoning);
          const defaultModel = normalizeDefaultModel(
            models,
            row.default_model === null ? null : String(row.default_model),
          );
          this.db
            .prepare('UPDATE executor_config SET models = ?, default_model = ? WHERE agent = ?')
            .run(JSON.stringify(models), defaultModel, String(row.agent));
        }
      }
      if (cols.has('reasoning')) {
        this.db.exec('ALTER TABLE executor_config DROP COLUMN reasoning');
      }
    }
    if (version < SCHEMA_VERSION) {
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
        .run(String(SCHEMA_VERSION));
    }
  }

  close(): void {
    this.db.close();
  }

  // node:sqlite has no transaction() helper (unlike better-sqlite3);
  // use explicit BEGIN/COMMIT. Single process, synchronous API.
  runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // -- missions -------------------------------------------------------------
  createMission(input: {
    goal: string;
    constraints?: string | null;
    repo: string;
    budget?: number | null;
    source: BrainSource;
  }): Mission {
    const now = nowIso();
    const m: Mission = {
      id: newId('m'),
      goal: input.goal,
      constraints: input.constraints ?? null,
      repo: input.repo,
      budget: input.budget ?? null,
      status: 'created',
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO missions (id, goal, constraints, repo, budget, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(m.id, m.goal, m.constraints, m.repo, m.budget, m.status, m.source, m.createdAt, m.updatedAt);
    return m;
  }

  getMission(id: string): Mission | null {
    const row = this.db
      .prepare('SELECT * FROM missions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToMission(row) : null;
  }

  /** Missions with work in flight (planned or executing). */
  listActiveMissions(): Mission[] {
    const rows = this.db
      .prepare("SELECT * FROM missions WHERE status IN ('planned', 'executing') ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToMission);
  }

  updateMissionStatus(id: string, status: MissionStatus): void {
    this.db
      .prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  // -- tasks ----------------------------------------------------------------
  createTask(input: {
    missionId: string;
    key: string;
    title: string;
    prompt?: string;
    contract: string;
    acceptance?: string;
    dependsOn?: string[];
    estimate?: number | null;
    mode?: string | null;
    type?: string | null;
  }): Task {
    const now = nowIso();
    const t: Task = {
      id: newId('t'),
      missionId: input.missionId,
      key: input.key,
      title: input.title,
      prompt: input.prompt ?? '',
      contract: input.contract,
      acceptance: input.acceptance ?? '',
      dependsOn: input.dependsOn ?? [],
      estimate: input.estimate ?? null,
      mode: input.mode ?? null,
      type: input.type ?? null,
      revisionsUsed: 0,
      rerouted: false,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO tasks (id, mission_id, key, title, prompt, contract, acceptance, depends_on, estimate, mode, type, revisions_used, rerouted, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        t.id,
        t.missionId,
        t.key,
        t.title,
        t.prompt,
        t.contract,
        t.acceptance,
        JSON.stringify(t.dependsOn),
        t.estimate,
        t.mode,
        t.type,
        t.revisionsUsed ? 1 : 0,
        t.rerouted ? 1 : 0,
        t.status,
        t.createdAt,
        t.updatedAt,
      );
    return t;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasksByMission(missionId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  updateTaskFields(
    id: string,
    patch: Partial<Pick<Task, 'revisionsUsed' | 'rerouted' | 'status'>>,
  ): void {
    const cur = this.getTask(id);
    if (!cur) throw new Error(`task not found: ${id}`);
    const next: Task = { ...cur, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        'UPDATE tasks SET revisions_used = ?, rerouted = ?, status = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.revisionsUsed, next.rerouted ? 1 : 0, next.status, next.updatedAt, id);
  }

  // -- replan proposals -------------------------------------------------------
  createReplanProposal(input: { missionId: string; taskId: string; reason: string }): ReplanProposal {
    const p: ReplanProposal = {
      id: newId('rp'),
      missionId: input.missionId,
      taskId: input.taskId,
      reason: input.reason,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        'INSERT INTO replan_proposals (id, mission_id, task_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(p.id, p.missionId, p.taskId, p.reason, p.createdAt);
    return p;
  }

  listReplanProposals(missionId: string): ReplanProposal[] {
    const rows = this.db
      .prepare('SELECT * FROM replan_proposals WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      missionId: String(r.mission_id),
      taskId: String(r.task_id),
      reason: String(r.reason),
      createdAt: String(r.created_at),
    }));
  }

  // -- attempts -------------------------------------------------------------
  createAttempt(input: { taskId: string; agent: string }): Attempt {
    const now = nowIso();
    const a: Attempt = {
      id: newId('att'),
      taskId: input.taskId,
      agent: input.agent,
      worktreePath: null,
      status: 'pending',
      exitCode: null,
      stderr: null,
      diffSummary: null,
      evidence: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO attempts (id, task_id, agent, worktree_path, status, exit_code, stderr, diff_summary, evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        a.id,
        a.taskId,
        a.agent,
        a.worktreePath,
        a.status,
        a.exitCode,
        a.stderr,
        a.diffSummary,
        a.evidence,
        a.createdAt,
        a.updatedAt,
      );
    return a;
  }

  getAttempt(id: string): Attempt | null {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAttempt(row) : null;
  }

  updateAttempt(
    id: string,
    patch: Partial<
      Pick<Attempt, 'worktreePath' | 'status' | 'exitCode' | 'stderr' | 'diffSummary' | 'evidence'>
    >,
  ): void {
    const cur = this.getAttempt(id);
    if (!cur) throw new Error(`attempt not found: ${id}`);
    const next: Attempt = { ...cur, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        'UPDATE attempts SET worktree_path = ?, status = ?, exit_code = ?, stderr = ?, diff_summary = ?, evidence = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.worktreePath,
        next.status,
        next.exitCode,
        next.stderr,
        next.diffSummary,
        next.evidence,
        next.updatedAt,
        id,
      );
  }

  listAttemptsByTask(taskId: string): Attempt[] {
    const rows = this.db
      .prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToAttempt);
  }

  /** Attempts stuck in 'running' (e.g. backend restarted mid-run). */
  listRunningAttempts(): Attempt[] {
    const rows = this.db.prepare("SELECT * FROM attempts WHERE status = 'running'").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToAttempt);
  }

  // -- events ---------------------------------------------------------------
  addEvent(attemptId: string, type: EventType, payload: unknown): AttemptEvent {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE attempt_id = ?')
      .get(attemptId) as { max_seq: number };
    const ev: AttemptEvent = {
      id: newId('evt'),
      attemptId,
      seq: row.max_seq + 1,
      type,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      ts: nowIso(),
    };
    this.db
      .prepare('INSERT INTO events (id, attempt_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ev.id, ev.attemptId, ev.seq, ev.type, ev.payload, ev.ts);
    return ev;
  }

  listEvents(attemptId: string): AttemptEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE attempt_id = ? ORDER BY seq ASC')
      .all(attemptId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      attemptId: String(r.attempt_id),
      seq: Number(r.seq),
      type: String(r.type) as EventType,
      payload: String(r.payload),
      ts: String(r.ts),
    }));
  }

  // -- ledger (P3) ------------------------------------------------------------
  insertLedgerEntry(entry: LedgerRow): void {
    this.db
      .prepare(
        'INSERT INTO ledger (seq, ts, type, ref_id, mission_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.seq,
        entry.ts,
        entry.type,
        entry.refId,
        entry.missionId,
        entry.detail,
        entry.prevHash,
        entry.hash,
      );
  }

  getLastLedgerEntry(): LedgerRow | null {
    const row = this.db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    return row ? rowToLedger(row) : null;
  }

  listLedgerEntries(missionId?: string): LedgerRow[] {
    const rows = (
      missionId
        ? this.db
            .prepare('SELECT * FROM ledger WHERE mission_id = ? ORDER BY seq ASC')
            .all(missionId)
        : this.db.prepare('SELECT * FROM ledger ORDER BY seq ASC').all()
    ) as Record<string, unknown>[];
    return rows.map(rowToLedger);
  }

  // -- approvals (P3) ---------------------------------------------------------
  createApproval(input: {
    kind: ApprovalKind;
    missionId: string;
    taskId?: string | null;
    summary: string;
  }): Approval {
    const a: Approval = {
      id: newId('ap'),
      kind: input.kind,
      missionId: input.missionId,
      taskId: input.taskId ?? null,
      summary: input.summary,
      status: 'pending',
      reason: null,
      createdAt: nowIso(),
      decidedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO approvals (id, kind, mission_id, task_id, summary, status, reason, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(a.id, a.kind, a.missionId, a.taskId, a.summary, a.status, a.reason, a.createdAt, a.decidedAt);
    return a;
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToApproval(row) : null;
  }

  listApprovals(status?: ApprovalStatus): Approval[] {
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT * FROM approvals WHERE status = ? ORDER BY created_at ASC",
            )
            .all(status)
        : this.db.prepare('SELECT * FROM approvals ORDER BY created_at ASC').all()
    ) as Record<string, unknown>[];
    return rows.map(rowToApproval);
  }

  decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    reason: string | null,
  ): Approval {
    const cur = this.getApproval(id);
    if (!cur) throw new Error(`approval not found: ${id}`);
    if (cur.status !== 'pending') {
      throw new Error(`approval ${id} is already ${cur.status}`);
    }
    this.db
      .prepare('UPDATE approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ?')
      .run(decision, reason, nowIso(), id);
    const next = this.getApproval(id);
    if (!next) throw new Error(`approval vanished after decide: ${id}`);
    return next;
  }

  // -- executor config (P3) ---------------------------------------------------
  upsertExecutorConfig(
    agent: string,
    patch: { models?: ConfigModel[]; defaultModel?: string | null },
  ): ExecutorConfig {
    const cur = this.getExecutorConfig(agent);
    const models = patch.models ?? cur?.models ?? [];
    let defaultModel =
      patch.defaultModel !== undefined ? patch.defaultModel : (cur?.defaultModel ?? null);
    // The default must be in the list; if it was deleted, fall back to the
    // first model (or null when the list is empty).
    defaultModel = normalizeDefaultModel(models, defaultModel);
    const next: ExecutorConfig = { agent, models, defaultModel, updatedAt: nowIso() };
    this.db
      .prepare(
        'INSERT INTO executor_config (agent, models, default_model, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent) DO UPDATE SET models = excluded.models, default_model = excluded.default_model, updated_at = excluded.updated_at',
      )
      .run(agent, JSON.stringify(next.models), next.defaultModel, next.updatedAt);
    return next;
  }

  /** Remove an executor's saved config row (Settings "remove"). */
  deleteExecutorConfig(agent: string): boolean {
    const info = this.db.prepare('DELETE FROM executor_config WHERE agent = ?').run(agent);
    return info.changes > 0;
  }

  getExecutorConfig(agent: string): ExecutorConfig | null {
    const row = this.db
      .prepare('SELECT * FROM executor_config WHERE agent = ?')
      .get(agent) as Record<string, unknown> | undefined;
    if (!row) return null;
    // Read-time migration for any v4 row the <5 step did not rewrite.
    const models = migrateExecutorModels(row.models, 'high');
    return {
      agent: String(row.agent),
      models,
      defaultModel: normalizeDefaultModel(
        models,
        row.default_model === null ? null : String(row.default_model),
      ),
      updatedAt: String(row.updated_at),
    };
  }

  listExecutorConfigs(): ExecutorConfig[] {
    const rows = this.db.prepare('SELECT * FROM executor_config ORDER BY agent ASC').all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => {
      const cfg = this.getExecutorConfig(String(row.agent));
      if (!cfg) throw new Error(`executor config vanished: ${String(row.agent)}`);
      return cfg;
    });
  }

  // -- board reads ------------------------------------------------------------
  listAllMissions(): Mission[] {
    const rows = this.db
      .prepare('SELECT * FROM missions ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToMission);
  }

  listAllAttempts(): Attempt[] {
    const rows = this.db
      .prepare('SELECT * FROM attempts ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToAttempt);
  }

  // -- worktrees -------------------------------------------------------------
  registerWorktree(input: {
    attemptId: string;
    repo: string;
    baseCommit: string;
    path: string;
  }): Worktree {
    const w: Worktree = {
      id: newId('wt'),
      attemptId: input.attemptId,
      repo: input.repo,
      baseCommit: input.baseCommit,
      path: input.path,
      status: 'active',
      mergedCommit: null,
    };
    this.db
      .prepare(
        'INSERT INTO worktrees (id, attempt_id, repo, base_commit, path, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(w.id, w.attemptId, w.repo, w.baseCommit, w.path, w.status);
    return w;
  }

  getWorktreeByAttempt(attemptId: string): Worktree | null {
    const row = this.db
      .prepare('SELECT * FROM worktrees WHERE attempt_id = ?')
      .get(attemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      attemptId: String(row.attempt_id),
      repo: String(row.repo),
      baseCommit: String(row.base_commit),
      path: String(row.path),
      status: String(row.status),
      mergedCommit: row.merged_commit === null ? null : String(row.merged_commit),
    };
  }

  updateWorktree(id: string, patch: Partial<Pick<Worktree, 'status' | 'mergedCommit'>>): void {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`worktree not found: ${id}`);
    const status = patch.status ?? String(row.status);
    const mergedCommit =
      patch.mergedCommit !== undefined
        ? patch.mergedCommit
        : row.merged_commit === null
          ? null
          : String(row.merged_commit);
    this.db
      .prepare('UPDATE worktrees SET status = ?, merged_commit = ? WHERE id = ?')
      .run(status, mergedCommit, id);
  }
}

function rowToLedger(r: Record<string, unknown>): LedgerRow {
  return {
    seq: Number(r.seq),
    ts: String(r.ts),
    type: String(r.type),
    refId: r.ref_id === null ? null : String(r.ref_id),
    missionId: r.mission_id === null ? null : String(r.mission_id),
    detail: String(r.detail),
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

function rowToApproval(r: Record<string, unknown>): Approval {
  return {
    id: String(r.id),
    kind: String(r.kind) as ApprovalKind,
    missionId: String(r.mission_id),
    taskId: r.task_id === null ? null : String(r.task_id),
    summary: String(r.summary),
    status: String(r.status) as ApprovalStatus,
    reason: r.reason === null ? null : String(r.reason),
    createdAt: String(r.created_at),
    decidedAt: r.decided_at === null ? null : String(r.decided_at),
  };
}

function rowToMission(r: Record<string, unknown>): Mission {
  return {
    id: String(r.id),
    goal: String(r.goal),
    constraints: r.constraints === null ? null : String(r.constraints),
    repo: String(r.repo),
    budget: r.budget === null || r.budget === undefined ? null : Number(r.budget),
    status: String(r.status) as MissionStatus,
    source: String(r.source) as BrainSource,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToTask(r: Record<string, unknown>): Task {
  let dependsOn: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.depends_on ?? '[]'));
    if (Array.isArray(parsed)) dependsOn = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    dependsOn = [];
  }
  return {
    id: String(r.id),
    missionId: String(r.mission_id),
    key: String(r.key),
    title: String(r.title),
    prompt: String(r.prompt ?? ''),
    contract: String(r.contract),
    acceptance: String(r.acceptance ?? ''),
    dependsOn,
    estimate: r.estimate === null || r.estimate === undefined ? null : Number(r.estimate),
    mode: r.mode === null || r.mode === undefined ? null : String(r.mode),
    type: r.type === null || r.type === undefined ? null : String(r.type),
    revisionsUsed: Number(r.revisions_used ?? 0),
    rerouted: Number(r.rerouted ?? 0) === 1,
    status: String(r.status) as TaskStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToAttempt(r: Record<string, unknown>): Attempt {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    agent: String(r.agent),
    worktreePath: r.worktree_path === null ? null : String(r.worktree_path),
    status: String(r.status) as AttemptStatus,
    exitCode: r.exit_code === null ? null : Number(r.exit_code),
    stderr: r.stderr === null ? null : String(r.stderr),
    diffSummary: r.diff_summary === null ? null : String(r.diff_summary),
    evidence: r.evidence === null || r.evidence === undefined ? null : String(r.evidence),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
