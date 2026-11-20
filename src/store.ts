// mission-store: SQLite persistence for missions / tasks / attempts / events / worktrees.
// INV-8: every state transition lands in SQLite; a backend restart must not lose
// attempt records. Uses Node's built-in node:sqlite (DatabaseSync), no extra driver.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 3;

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

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Data dir: $ORCHESTRATOR_DATA_DIR, else ~/.agent-orchestrator. */
export function resolveDataDir(): string {
  return process.env.ORCHESTRATOR_DATA_DIR ?? join(homedir(), '.agent-orchestrator');
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
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON events(attempt_id, seq);
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
