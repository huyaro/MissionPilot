// Executor detection + model listing (Settings UI).
//
// Detection is Magpie-style: an agent counts as installed when ANY signal
// matches — a CLI binary on PATH (command -v) OR a config directory under
// the user's home (see research_notes/local-agent-detection-methods-
// 20261121-1306/report.md). There is no single standard across the
// ecosystem, so the two signals are combined and the UI shows which one
// matched. "Added" is a Settings concept only: the executor has a saved
// config row in executor_config — saving writes the row, removing deletes
// it.
//
// Only three agents are in scope (user decision 2026-11-21): codebuddy,
// qoder, pi. Dsh, WorkBuddy, Muse and Gemini are out — not detected, not
// configured, no dispatch. Do not re-add them here.
//
// Model lists come from each agent's own mechanism — never a hardcoded
// catalogue (the catalogues are account/region dependent and go stale):
// - qoder: `<bin> --list-models` (official docs, docs.qoder.com/cli/model:
//   "List available models and exit"). The output format is not
//   documented, so the parser is deliberately tolerant.
// - codebuddy: no documented --list-models exists, and `-p "/model list"`
//   was verified NOT to work on the user's Mac (2026-11-21): /model list
//   is a built-in interactive command and the agent refuses to run it on
//   behalf of a caller. --acp mode has no model-listing method either
//   (checked: cli-reference.md's "Prompt and model" table documents only
//   --model; no ACP material in the research notes). Instead the list is
//   read statically from the product config — a TypeScript port of the
//   user's list-codebuddy-models.mjs (the script itself is NOT in this
//   repo): ACC_PRODUCT_CONFIG_PATH, else the newest
//   ~/.codebuddy/local_storage/*.info cache ([0].data.models), else the
//   bundled <package>/product.json next to the resolved binary. Built-in
//   models are filtered to the agents[name=cli].models whitelist (what
//   /model and --model enumerate); ~/.codebuddy/models.json (user) and
//   <project>/.codebuddy/models.json (project) layers SmartMerge on top —
//   same id fully replaces, new id appends; project availableModels fully
//   overrides user-level. The project layer is omitted in production:
//   the backend has no project workspace (its cwd is not a CodeBuddy
//   project). Never hardcode the Token Plan catalogue (auto / glm-5.2 /
//   deepseek-v4 / ...) — it is account/plan dependent.
// - pi: `pi --list-models` first; it is not confirmed to exist, so on
//   failure fall back to ~/.pi/agent/models.json
//   (providers.<provider>.models[] with id/name/...).
//
// Config paths are a weaker signal than binaries (e.g. ~/.qoder is shared
// by the Qoder IDE and its CLI), so the matched signal is always surfaced
// next to the detection badge — the UI never claims more than the evidence.
//
// macOS PATH: the backend is launched by Tauri, whose PATH may not include
// the user's ~/.zshrc Homebrew entries. On darwin, binaries are probed
// through a login shell (`zsh -l -c 'command -v <bin>'`) first, falling
// back to plain `which`; spawns always use the resolved absolute path, so
// they never depend on the backend's own PATH.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConfigModel, ExecutorConfig, Store } from './store.js';

const execFileAsync = promisify(execFile);

export interface ExecutorDef {
  id: string;
  label: string;
  /** CLI binaries probed on PATH, in order. [] = the agent has no CLI. */
  bins: string[];
  /** Config path under the home dir whose existence also counts as installed. */
  configPath: string | null;
  /** Whether a CLI dispatch adapter exists for this agent (see server.ts). */
  dispatchable: boolean;
  /** Env var that overrides the bin list with a single binary. */
  binEnv?: string;
}

// Detection list. Bins are the CLI names the agent is shipped under; the
// first one found on PATH wins. Config paths are the well-known per-user
// config locations (Magpie/CAAMP convention: show only installed/configured
// agents, keyed on config existence).
export function getExecutorDefs(): ExecutorDef[] {
  return [
    {
      id: 'codebuddy',
      label: 'CodeBuddy',
      bins: ['codebuddy', 'codebuddy-code', 'cbc'],
      configPath: '.codebuddy',
      dispatchable: true,
      binEnv: 'ORCHESTRATOR_CODEBUDDY_BIN',
    },
    {
      id: 'qoder',
      label: 'Qoder',
      // Official install page verifies `qoder --version` after install;
      // qodercli is the npm package name / old install's binary, kept as
      // a fallback. Never probe qodercli alone.
      bins: ['qoder', 'qodercli', 'qodercn'],
      configPath: '.qoder',
      dispatchable: true,
      binEnv: 'ORCHESTRATOR_QODER_BIN',
    },
    {
      id: 'pi',
      label: 'Pi',
      bins: ['pi'],
      configPath: '.pi/agent',
      dispatchable: false,
      binEnv: 'ORCHESTRATOR_PI_BIN',
    },
  ];
}

export function isKnownExecutor(id: string): boolean {
  return getExecutorDefs().some((e) => e.id === id);
}

export type ExecutorState = 'connected' | 'pending' | 'not-connected' | 'missing';

export interface DetectedExecutor {
  id: string;
  label: string;
  detected: boolean;
  /** What proved the install: the binary path, or the config path. */
  signal: { kind: 'binary' | 'config'; value: string } | null;
  /** Why not detected — names the bins and paths that were checked. */
  reason: string;
  /** Version from `<bin> --version`, when a binary was found and answered. */
  version: string | null;
  /** Whether dispatch is wired for this agent (has a CLI adapter). */
  dispatchable: boolean;
  state: ExecutorState;
  /** A config row exists in executor_config (i.e. the user configured it). */
  added: boolean;
  config: ExecutorConfig | null;
}

// ---------------------------------------------------------------------------
// Per-model dispatch settings (stored in executor_config, see store.ts).
// The models array IS the enabled set: a model not in the array is never
// used for dispatch. defaultModel must be one of the array entries; when
// the default is deleted it falls back to the first model in the array.
// ---------------------------------------------------------------------------

export const CONTEXT_OPTIONS = ['32K', '64K', '128K', '200K', '400K', '1M'] as const;

/** Map a context label to the token count qoder's --context-window expects. */
export function contextLabelToTokens(label: string): number | null {
  switch (label) {
    case '32K':
      return 32768;
    case '64K':
      return 65536;
    case '128K':
      return 131072;
    case '200K':
      return 200000;
    case '400K':
      return 400000;
    case '1M':
      return 1000000;
    default:
      return null;
  }
}

/** The model a dispatch to `agent` must use, or null when it has none configured. */
export function resolveDispatchModel(store: Store, agent: string): ConfigModel | null {
  const config = store.getExecutorConfig(agent);
  if (!config || config.models.length === 0) return null;
  if (config.defaultModel) {
    const found = config.models.find((m) => m.id === config.defaultModel);
    if (found) return found;
  }
  return config.models[0] ?? null;
}

// ---------------------------------------------------------------------------
// Binary probing (60s cache — detection runs on the 2s connections poll).
// ---------------------------------------------------------------------------

interface BinProbe {
  at: number;
  /** Resolved path, or null when not found. */
  path: string | null;
  /** First line of `<bin> --version`, or null when it did not answer. */
  version: string | null;
}

const binCache = new Map<string, BinProbe>();
const BIN_CACHE_TTL_MS = 60_000;

/** `which` in the backend's own PATH. */
async function plainWhich(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin], { timeout: 10_000 });
    return stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve `bin` through a login shell, which on macOS picks up the
 * ~/.zshrc PATH entries (e.g. Homebrew) that the Tauri-launched backend
 * does not see. Returns null when zsh is missing or the bin is not found.
 */
export async function whichViaLoginShell(bin: string): Promise<string | null> {
  const escaped = bin.replace(/'/g, `'\\''`);
  try {
    const { stdout } = await execFileAsync('zsh', ['-l', '-c', `command -v '${escaped}'`], {
      timeout: 10_000,
    });
    return stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

async function probeBin(bin: string): Promise<BinProbe> {
  const cached = binCache.get(bin);
  if (cached && Date.now() - cached.at < BIN_CACHE_TTL_MS) return cached;
  const probe: BinProbe = { at: Date.now(), path: null, version: null };
  // On macOS the login shell sees the user's full PATH; elsewhere (and
  // as a fallback) plain `which` is enough.
  if (process.platform === 'darwin') {
    probe.path = await whichViaLoginShell(bin);
  }
  if (!probe.path) {
    probe.path = await plainWhich(bin);
  }
  if (probe.path) {
    // Spawn by resolved path — never depends on the backend's own PATH.
    try {
      const { stdout } = await execFileAsync(probe.path, ['--version'], { timeout: 10_000 });
      const line = stdout.trim().split('\n')[0]?.trim() ?? '';
      probe.version = line ? line.slice(0, 80) : null;
    } catch {
      probe.version = null;
    }
  }
  binCache.set(bin, probe);
  return probe;
}

export function clearDetectionCache(): void {
  binCache.clear();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Binaries to probe for a def: the env override (single binary) wins. */
function binsToProbe(def: ExecutorDef): string[] {
  if (def.binEnv) {
    const override = process.env[def.binEnv];
    if (override) return [override];
  }
  return def.bins;
}

/**
 * The binary to spawn for `id`: the resolved absolute path of the first
 * bin detection found, or null. Spawning by path (not bare name) keeps
 * model listing working under Tauri's limited PATH on macOS.
 */
export async function resolveExecutorBin(id: string): Promise<string | null> {
  const def = getExecutorDefs().find((d) => d.id === id);
  if (!def) return null;
  for (const bin of binsToProbe(def)) {
    const probe = await probeBin(bin);
    if (probe.path) return probe.path;
  }
  return null;
}

export interface ListExecutorsOptions {
  /** Re-probe instead of using the 60s cache (the UI's 重新检测 button). */
  refresh?: boolean;
  /** Home dir override for tests (defaults to os.homedir()). */
  homeDir?: string;
}

/** Detection + saved config for every known executor (detected first). */
export async function listExecutors(
  store: Store,
  opts: ListExecutorsOptions = {},
): Promise<DetectedExecutor[]> {
  if (opts.refresh) clearDetectionCache();
  const homeDir = opts.homeDir ?? homedir();
  const defs = getExecutorDefs();
  const configs = new Map(store.listExecutorConfigs().map((c) => [c.agent, c]));
  const out: DetectedExecutor[] = [];
  for (const def of defs) {
    const bins = binsToProbe(def);
    let signal: DetectedExecutor['signal'] = null;
    let version: string | null = null;
    for (const bin of bins) {
      const probe = await probeBin(bin);
      if (probe.path) {
        signal = { kind: 'binary', value: probe.path };
        version = probe.version;
        break;
      }
    }
    if (!signal && def.configPath && existsSync(join(homeDir, def.configPath))) {
      signal = { kind: 'config', value: `~/${def.configPath}` };
    }
    const detected = signal !== null;
    let reason = '';
    if (!detected) {
      const checked: string[] = [];
      if (bins.length > 0) checked.push(`PATH 中没有 ${bins.join('、')}`);
      if (def.configPath) checked.push(`没有 ~/${def.configPath} 配置目录`);
      reason = `未检测到：${checked.join('，也')}`;
    }
    const config = configs.get(def.id) ?? null;
    out.push({
      id: def.id,
      label: def.label,
      detected,
      signal,
      reason,
      version,
      dispatchable: def.dispatchable,
      state: detected ? 'connected' : 'missing',
      added: config !== null,
      config,
    });
  }
  return out.sort((a, b) => Number(b.detected) - Number(a.detected));
}

// -- model listing ------------------------------------------------------------

/** CodeBuddy's user-level model config file (official docs location). */
export function codebuddyModelsPath(): string {
  return process.env.ORCHESTRATOR_CODEBUDDY_MODELS_JSON ?? join(homedir(), '.codebuddy', 'models.json');
}

/** Pi's user-level model config file (custom providers/models). */
export function piModelsPath(): string {
  return process.env.ORCHESTRATOR_PI_MODELS_JSON ?? join(homedir(), '.pi', 'agent', 'models.json');
}

const HEADER_TOKENS = new Set(['model', 'name', 'available', 'models', 'id']);

/**
 * Parse `--list-models` output. Tolerant by design: the format is not
 * documented, so skip blank lines, table borders, and header rows, and
 * take the first whitespace-separated token of every other line
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

/** The same tolerant line parser, shared by qoder/pi. */
export const parseTolerantModelList = parseQoderModels;

/** Extract model ids from a models array (strings or {id} objects). */
function idsFromModelsArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const ids: string[] = [];
  for (const m of arr) {
    const id =
      typeof m === 'string'
        ? m
        : typeof m === 'object' && m !== null
          ? (m as Record<string, unknown>).id
          : undefined;
    if (typeof id === 'string' && id.trim() !== '') ids.push(id);
  }
  return ids;
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
    const ids = idsFromModelsArray(available);
    if (ids.length > 0) return ids;
  }
  const models = record.models;
  if (Array.isArray(models)) {
    return idsFromModelsArray(models);
  }
  return [];
}

// -- CodeBuddy product-config model listing ----------------------------------
// TypeScript port of the user's list-codebuddy-models.mjs (the script
// itself is NOT in this repo): built-in models come from the product
// config, custom models from the two models.json layers, merged with
// SmartMerge (same id fully replaces, new id appends).

/** One CodeBuddy model definition, with the metadata the product config carries. */
export interface CodebuddyModelRecord {
  id: string;
  name?: string;
  vendor?: string;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  maxInputTokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract model records from a `models` array (objects, or plain id strings). */
export function codebuddyModelRecords(value: unknown): CodebuddyModelRecord[] {
  if (!Array.isArray(value)) return [];
  const records: CodebuddyModelRecord[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') records.push({ id: entry });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const id = record.id;
    if (typeof id !== 'string' || id.trim() === '') continue;
    const out: CodebuddyModelRecord = { id };
    if (typeof record.name === 'string') out.name = record.name;
    if (typeof record.vendor === 'string') out.vendor = record.vendor;
    if (typeof record.supportsReasoning === 'boolean') out.supportsReasoning = record.supportsReasoning;
    if (typeof record.supportsToolCall === 'boolean') out.supportsToolCall = record.supportsToolCall;
    if (typeof record.maxInputTokens === 'number') out.maxInputTokens = record.maxInputTokens;
    records.push(out);
  }
  return records;
}

export interface CodebuddyModelLayer {
  name: 'builtin' | 'user' | 'project';
  data: Record<string, unknown> | null;
}

/**
 * SmartMerge the builtin (product config) + user + project layers, then
 * apply the cli-agent whitelist and the availableModels filter — the
 * reference script's algorithm, with one fix: the script can emit a
 * duplicate id when a custom model overrides a whitelisted builtin id
 * (it appears in both the whitelist and the custom set); the port
 * dedupes, whitelist position wins.
 */
export function mergeCodebuddyModelLayers(layers: CodebuddyModelLayer[]): CodebuddyModelRecord[] {
  let merged: CodebuddyModelRecord[] = [];
  let available: unknown = null;
  const customIds = new Set<string>();
  for (const layer of layers) {
    if (!layer.data) continue;
    for (const model of codebuddyModelRecords(layer.data.models)) {
      if (layer.name !== 'builtin') customIds.add(model.id);
      const i = merged.findIndex((x) => x.id === model.id);
      if (i >= 0) merged[i] = model;
      else merged.push(model);
    }
    if (layer.name !== 'builtin' && 'availableModels' in layer.data) {
      available = layer.data.availableModels;
    }
  }
  // Built-in models are visible only through the cli agent whitelist;
  // custom models (user/project layers) are always visible.
  const builtin = layers.find((l) => l.name === 'builtin')?.data ?? null;
  const agents = builtin?.agents;
  const cliAgent = Array.isArray(agents)
    ? agents.find((a) => asRecord(a)?.name === 'cli')
    : undefined;
  const visible = idsFromModelsArray(asRecord(cliAgent)?.models);
  let shown = merged;
  if (visible.length > 0) {
    const byId = new Map(shown.map((m) => [m.id, m]));
    const seen = new Set<string>();
    shown = [];
    for (const id of [...visible, ...customIds]) {
      const model = byId.get(id);
      if (model && !seen.has(id)) {
        seen.add(id);
        shown.push(model);
      }
    }
  }
  if (Array.isArray(available) && available.length > 0) {
    const allowed = new Set(idsFromModelsArray(available));
    shown = shown.filter((m) => allowed.has(m.id));
  }
  return shown;
}

/** Read and parse a JSON file; null when missing or invalid. */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export interface CodebuddyProductConfig {
  file: string;
  data: Record<string, unknown>;
}

/**
 * Resolve the CodeBuddy product config, in priority order: the
 * ACC_PRODUCT_CONFIG_PATH spill file (must parse and have `.models`),
 * the newest ~/.codebuddy/local_storage/*.info cache whose
 * [0].data.models is non-empty, the bundled product.json next to the
 * resolved binary. Returns null when none yields a config.
 */
export function resolveCodebuddyProductConfig(opts: {
  binPath: string | null;
  productConfigPath?: string;
  homeDir?: string;
}): CodebuddyProductConfig | null {
  const home = opts.homeDir ?? homedir();
  // (a) Host-injected spill file.
  const spill = opts.productConfigPath ?? process.env.ACC_PRODUCT_CONFIG_PATH;
  if (spill) {
    const data = asRecord(readJsonFile(spill));
    if (data && Array.isArray(data.models)) return { file: spill, data };
  }
  // (b) Newest local_storage *.info cache.
  const dir = join(home, '.codebuddy', 'local_storage');
  try {
    let best: { file: string; data: Record<string, unknown>; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.info')) continue;
      const file = join(dir, name);
      const parsed = readJsonFile(file);
      const record = asRecord(Array.isArray(parsed) ? asRecord(parsed[0])?.data : undefined);
      if (!record || !Array.isArray(record.models) || record.models.length === 0) continue;
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { file, data: record, mtime };
    }
    if (best) return { file: best.file, data: best.data };
  } catch {
    // No local_storage dir — fall through to the bundled config.
  }
  // (c) Bundled product.json next to the resolved binary.
  if (opts.binPath) {
    try {
      const pkg = dirname(dirname(realpathSync(opts.binPath)));
      const file = join(pkg, 'product.json');
      const data = asRecord(readJsonFile(file));
      if (data) return { file, data };
    } catch {
      // No bundled config.
    }
  }
  return null;
}

export interface ListCodebuddyModelsOptions {
  /** Resolved codebuddy binary path; undefined = auto-resolve, null = skip bundled lookup. */
  binPath?: string | null;
  /** Override for ACC_PRODUCT_CONFIG_PATH. */
  productConfigPath?: string;
  /** Home dir override (local_storage cache + default user models.json). */
  homeDir?: string;
  /** User-layer models.json override. */
  codebuddyModelsPath?: string;
  /** Project workspace root; null/undefined = omit the project layer. */
  projectDir?: string | null;
}

export interface CodebuddyModelsResult {
  models: CodebuddyModelRecord[];
  /** Where the list came from, shown in the UI. */
  source: string;
}

/** Shorten an absolute path under home to ~/... for display. */
function displayPath(file: string, home: string): string {
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

/**
 * List CodeBuddy models from the product config + models.json layers
 * (see the module comment). The project layer is omitted unless a
 * projectDir is given — in production the backend has no project
 * workspace, so only the builtin + user layers apply. Throws a
 * user-facing error when nothing yields a model list.
 */
export async function listCodebuddyModels(
  opts: ListCodebuddyModelsOptions = {},
): Promise<CodebuddyModelsResult> {
  const home = opts.homeDir ?? homedir();
  const bin = opts.binPath === undefined ? await resolveExecutorBin('codebuddy') : opts.binPath;
  const product = resolveCodebuddyProductConfig({
    binPath: bin,
    productConfigPath: opts.productConfigPath,
    homeDir: home,
  });
  const userPath =
    opts.codebuddyModelsPath ??
    (opts.homeDir ? join(home, '.codebuddy', 'models.json') : codebuddyModelsPath());
  const userData = asRecord(readJsonFile(userPath));
  const projectData = opts.projectDir
    ? asRecord(readJsonFile(join(opts.projectDir, '.codebuddy', 'models.json')))
    : null;
  const models = mergeCodebuddyModelLayers([
    { name: 'builtin', data: product?.data ?? null },
    { name: 'user', data: userData },
    { name: 'project', data: projectData },
  ]);
  if (models.length === 0) {
    throw new Error(
      'CodeBuddy 模型列表获取失败：未找到产品配置（ACC_PRODUCT_CONFIG_PATH、local_storage 缓存或包内 product.json），也没有 ~/.codebuddy/models.json 自定义模型。内置模型请在 CodeBuddy 交互会话里用 /model 查看。',
    );
  }
  const source = product ? displayPath(product.file, home) : '~/.codebuddy/models.json';
  return { models, source };
}

/**
 * Parse a Pi models.json file. Custom providers/models are keyed by
 * provider: providers.<provider>.models[] with id/name/.... Top-level
 * availableModels / models[] are accepted too. Throws on invalid JSON
 * or a wrong shape.
 */
export function parsePiModelsFile(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Pi 模型配置文件不是有效的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Pi 模型配置文件格式不正确');
  }
  const record = parsed as Record<string, unknown>;
  let ids = idsFromModelsArray(record.availableModels);
  if (ids.length === 0) ids = idsFromModelsArray(record.models);
  if (ids.length === 0 && typeof record.providers === 'object' && record.providers !== null) {
    for (const provider of Object.values(record.providers as Record<string, unknown>)) {
      if (typeof provider === 'object' && provider !== null) {
        ids.push(...idsFromModelsArray((provider as Record<string, unknown>).models));
      }
    }
  }
  if (ids.length === 0) {
    // Top-level provider keys: { "<provider>": { models: [...] } }.
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) {
        ids.push(...idsFromModelsArray((value as Record<string, unknown>).models));
      }
    }
  }
  return [...new Set(ids)];
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
 * The binary used is the one detection found (not the hardcoded default
 * name). Throws an Error with a user-facing message when the list cannot
 * be fetched. Never returns a hardcoded catalogue.
 */
export async function listExecutorModels(
  id: string,
  opts: {
    codebuddyModelsPath?: string;
    piModelsPath?: string;
    /** Home dir override for the CodeBuddy product-config lookup. */
    codebuddyHomeDir?: string;
    /** Override for ACC_PRODUCT_CONFIG_PATH. */
    codebuddyProductConfigPath?: string;
    /** Resolved CodeBuddy binary override (null = skip bundled lookup). */
    codebuddyBinPath?: string | null;
    /** Project workspace root for the project models.json layer. */
    codebuddyProjectDir?: string | null;
  } = {},
): Promise<ExecutorModels> {
  if (!isKnownExecutor(id)) throw new Error(`unknown executor: ${id}`);

  if (id === 'codebuddy') {
    // Product config first, models.json layers merged on top (see the
    // module comment). No hardcoded catalogue; when nothing yields a
    // list the error points at /model.
    const { models, source } = await listCodebuddyModels({
      binPath: opts.codebuddyBinPath,
      productConfigPath: opts.codebuddyProductConfigPath,
      homeDir: opts.codebuddyHomeDir,
      codebuddyModelsPath: opts.codebuddyModelsPath,
      projectDir: opts.codebuddyProjectDir ?? null,
    });
    return { models: models.map((m) => m.id), source };
  }

  if (id === 'pi') {
    const bin = await resolveExecutorBin('pi');
    if (!bin) {
      throw new Error('未检测到 Pi：PATH 中没有 pi，也没有 ~/.pi/agent 配置目录。');
    }
    // `pi --list-models` is not confirmed to exist — try it, and fall
    // back to ~/.pi/agent/models.json when it fails or returns nothing.
    try {
      const out = await runListModels(bin);
      const models = parseQoderModels(out.stdout).filter((m) => !m.startsWith('-'));
      if (models.length > 0) {
        return { models, source: `${bin} --list-models` };
      }
    } catch {
      // Fall through to the models.json file.
    }
    const path = opts.piModelsPath ?? piModelsPath();
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      throw new Error(
        'Pi 模型列表获取失败：`pi --list-models` 未返回模型，且未找到 ~/.pi/agent/models.json。',
      );
    }
    const models = parsePiModelsFile(text);
    if (models.length === 0) {
      throw new Error('Pi 模型列表获取失败：~/.pi/agent/models.json 中没有可用模型。');
    }
    return { models, source: '~/.pi/agent/models.json' };
  }

  if (id === 'qoder') {
    const bin = await resolveExecutorBin('qoder');
    if (!bin) {
      throw new Error('未检测到 Qoder：PATH 中没有 qoder、qodercli、qodercn，也没有 ~/.qoder 配置目录。');
    }
    let out: { stdout: string; stderr: string };
    try {
      out = await runListModels(bin);
    } catch (err) {
      throw new Error(
        `无法获取 Qoder 模型列表（${bin} --list-models 失败）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const models = parseQoderModels(out.stdout);
    if (models.length === 0) {
      throw new Error('Qoder 未返回任何模型（请检查登录状态）');
    }
    return { models, source: `${bin} --list-models` };
  }

  // Defensive: every known executor has a branch above.
  const def = getExecutorDefs().find((d) => d.id === id);
  throw new Error(`该 agent 暂不支持获取模型列表（${def?.label ?? id} 没有已知的模型列表获取方式）。`);
}
