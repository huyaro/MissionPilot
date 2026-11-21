// Executor detection + model listing (Settings UI).
//
// Detection: a CLI executor is "detected" when its binary is on PATH
// (the same signal as the board's state pill). "Added" is a Settings
// concept only: the executor has a saved config row in executor_config —
// adding writes the row, removing deletes it. Dispatch is untouched
// (the dispatcher resolves adapters from its own map; the board config
// is display/config only, as before).
//
// Model lists come from each agent's own mechanism — never a hardcoded
// catalogue (the catalogues are account/region dependent and go stale):
// - qoder: `qoder --list-models` (official docs, docs.qoder.com/cli/model:
//   "List available models and exit"). The output format is not
//   documented, so the parser is deliberately tolerant: one model per
//   line, headers and separators skipped, first token wins.
// - codebuddy: no non-interactive list command exists (`/model list` is
//   TUI-only). The documented machine-readable source is the user's
//   ~/.codebuddy/models.json, which "customizes the model list and
//   controls the model dropdown display" — availableModels wins, else
//   models[].id. A missing or empty file means no list can be fetched;
//   that is reported as an error, never silently replaced by a guess.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorConfig, Store } from './store.js';

export interface ExecutorDef {
  id: string;
  label: string;
  /** CLI binary; null = no CLI (not addable from local detection). */
  bin: string | null;
  /** Offered in the Settings "add" list when detected. */
  addable: boolean;
}

// Executor connection states, grounded in the 2026-11-19/20 decisions:
// codebuddy + qoder are the P0/P1 executors (binary presence = reachable);
// workbuddy has no CLI and stays 'pending' (pi route is out of scope);
// gemini is 'not-connected' (consumer plan cannot be wrapped, per ToS).
// Read at request time (not module load) so tests can point the probe at
// controlled paths; binary presence is still the reachability signal.
export function getExecutorDefs(): ExecutorDef[] {
  return [
    {
      id: 'codebuddy',
      label: 'CodeBuddy',
      bin: process.env.ORCHESTRATOR_CODEBUDDY_BIN ?? 'codebuddy',
      addable: true,
    },
    {
      id: 'qoder',
      label: 'Qoder',
      bin: process.env.ORCHESTRATOR_QODER_BIN ?? 'qoder',
      addable: true,
    },
    { id: 'workbuddy', label: 'WorkBuddy', bin: null, addable: false },
    { id: 'gemini', label: 'Gemini', bin: null, addable: false },
  ];
}

export function isKnownExecutor(id: string): boolean {
  return getExecutorDefs().some((e) => e.id === id);
}

export type ExecutorState = 'connected' | 'pending' | 'not-connected' | 'missing';

export interface DetectedExecutor {
  id: string;
  label: string;
  /** Binary found on PATH (CLI executors); false for workbuddy/gemini. */
  detected: boolean;
  state: ExecutorState;
  /** A config row exists in executor_config (i.e. the user added it). */
  added: boolean;
  config: ExecutorConfig | null;
}

const whichCache = new Map<string, { at: number; found: boolean }>();

function whichBin(bin: string): Promise<boolean> {
  const cached = whichCache.get(bin);
  if (cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.found);
  return new Promise((resolve) => {
    execFile('which', [bin], { timeout: 5_000 }, (err) => {
      const found = !err;
      whichCache.set(bin, { at: Date.now(), found });
      resolve(found);
    });
  });
}

function stateFor(def: ExecutorDef, detected: boolean): ExecutorState {
  if (def.id === 'workbuddy') return 'pending';
  if (def.id === 'gemini') return 'not-connected';
  return detected ? 'connected' : 'missing';
}

/** Detection + saved config for every known executor. */
export async function listExecutors(store: Store): Promise<DetectedExecutor[]> {
  return Promise.all(
    getExecutorDefs().map(async (def) => {
      const detected = def.bin !== null ? await whichBin(def.bin) : false;
      const config = store.getExecutorConfig(def.id);
      return {
        id: def.id,
        label: def.label,
        detected,
        state: stateFor(def, detected),
        added: config !== null,
        config,
      };
    }),
  );
}

// -- model listing ------------------------------------------------------------

/** CodeBuddy's user-level model config file (official docs location). */
export function codebuddyModelsPath(): string {
  return process.env.ORCHESTRATOR_CODEBUDDY_MODELS_JSON ?? join(homedir(), '.codebuddy', 'models.json');
}

const HEADER_TOKENS = new Set(['model', 'name', 'available', 'models', 'id']);

/**
 * Parse `qoder --list-models` output. Tolerant by design: the format is
 * not documented, so skip blank lines, table borders, and header rows,
 * and take the first whitespace-separated token of every other line
 * (e.g. "Qwen3.8-Max  0.5x" -> "Qwen3.8-Max"). Duplicates are removed.
 */
export function parseQoderModels(output: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  const push = (token: string): void => {
    const id = token.trim();
    if (id === '' || HEADER_TOKENS.has(id.toLowerCase())) return;
    if (!seen.has(id)) {
      seen.add(id);
      models.push(id);
    }
  };
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    // Border / separator rows: only -, =, |, +, spaces.
    if (/^[-=|+ ]+$/.test(line)) continue;
    if (line.startsWith('|')) {
      // Markdown-style table row: the first cell is the model name.
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c !== '');
      if (cells.length > 0) push((cells[0] as string).split(/\s+/)[0] ?? '');
      continue;
    }
    push(line.split(/\s+/)[0] ?? '');
  }
  return models;
}

/**
 * Parse a CodeBuddy models.json file. availableModels (the dropdown
 * allowlist) wins when present and non-empty; otherwise models[].id.
 * Throws on invalid JSON or a wrong shape.
 */
export function parseCodebuddyModelsFile(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('CodeBuddy 模型配置文件不是有效的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('CodeBuddy 模型配置文件格式不正确');
  }
  const record = parsed as Record<string, unknown>;
  const available = record.availableModels;
  if (Array.isArray(available)) {
    const ids = available.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (ids.length > 0) return ids;
  }
  const models = record.models;
  if (Array.isArray(models)) {
    const ids = models
      .map((m) => (typeof m === 'object' && m !== null ? (m as Record<string, unknown>).id : undefined))
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return ids;
  }
  return [];
}

function runListModels(bin: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--list-models'], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim() || err.message;
        reject(new Error(detail));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export interface ExecutorModels {
  models: string[];
  /** Where the list came from, shown in the UI. */
  source: string;
}

/**
 * Fetch the model list for one executor, from that agent's own mechanism.
 * Throws an Error with a user-facing message when the list cannot be
 * fetched (binary missing, CLI failed, no config file, ...). Never
 * returns a hardcoded catalogue.
 */
export async function listExecutorModels(
  id: string,
  opts: { codebuddyModelsPath?: string } = {},
): Promise<ExecutorModels> {
  if (!isKnownExecutor(id)) throw new Error(`unknown executor: ${id}`);
  if (id === 'workbuddy' || id === 'gemini') {
    throw new Error('该执行者不支持获取模型列表');
  }
  if (id === 'qoder') {
    const bin = process.env.ORCHESTRATOR_QODER_BIN ?? 'qoder';
    let out: { stdout: string; stderr: string };
    try {
      out = await runListModels(bin);
    } catch (err) {
      throw new Error(`无法获取 Qoder 模型列表（${bin} --list-models 失败）：${err instanceof Error ? err.message : String(err)}`);
    }
    const models = parseQoderModels(out.stdout);
    if (models.length === 0) {
      throw new Error('Qoder 未返回任何模型（请检查登录状态）');
    }
    return { models, source: `${bin} --list-models` };
  }
  // codebuddy: read the user's models.json (see module comment).
  const path = opts.codebuddyModelsPath ?? codebuddyModelsPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      '未找到 CodeBuddy 模型配置文件 ~/.codebuddy/models.json（CodeBuddy 没有提供非交互式列模型命令；已配置的模型以该文件为准）',
    );
  }
  const models = parseCodebuddyModelsFile(text);
  if (models.length === 0) {
    throw new Error('CodeBuddy 模型配置文件中没有可用模型');
  }
  return { models, source: '~/.codebuddy/models.json' };
}
