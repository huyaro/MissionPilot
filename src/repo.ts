// Repo read tools (P2): read-only code access so the brain can look at a
// repo before planning. No writes, no shell. Every path must stay inside
// the given repo (traversal rejected). The tools take the repo as an
// argument; they run behind the MCP server's auth (bearer token on HTTP,
// local stdio for Codex) — there is no separate repo allowlist in P2.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
  'vendor',
  '.venv',
  '__pycache__',
]);
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_FILES = 2000;
const MAX_MATCHES = 50;

export function resolveInsideRepo(repo: string, path: string): string {
  const root = resolve(repo);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`path escapes the repo: ${path}`);
  }
  return full;
}

async function walkFiles(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_SEARCH_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_SEARCH_FILES) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || depth <= 0) continue;
      await walkFiles(root, join(dir, entry.name), depth - 1, out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
}

/** Directory tree of the repo (text). Skips VCS/build/dependency dirs. */
export async function repoMap(repo: string, maxDepth = 4): Promise<string> {
  const root = resolve(repo);
  const lines: string[] = [];
  async function walk(dir: string, depth: number, prefix: string): Promise<void> {
    if (lines.length >= MAX_ENTRIES) return;
    const entries = (await readdir(dir, { withFileTypes: true })).filter(
      (e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)),
    );
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (let i = 0; i < entries.length; i++) {
      if (lines.length >= MAX_ENTRIES) return;
      const entry = entries[i];
      const last = i === entries.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory() && depth > 0) {
        await walk(join(dir, entry.name), depth - 1, `${prefix}${last ? '    ' : '│   '}`);
      }
    }
  }
  lines.push(`${root}/`);
  await walk(root, maxDepth, '');
  if (lines.length >= MAX_ENTRIES) lines.push(`... (truncated at ${MAX_ENTRIES} entries)`);
  return lines.join('\n');
}

/** Read one file inside the repo (capped at 64 KiB). */
export async function readRepoFile(repo: string, path: string): Promise<string> {
  const full = resolveInsideRepo(repo, path);
  const st = await stat(full).catch(() => {
    throw new Error(`not found: ${path}`);
  });
  if (!st.isFile()) throw new Error(`not a file: ${path}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${path} (${st.size} bytes, max ${MAX_FILE_BYTES})`);
  }
  return readFile(full, 'utf8');
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

/** Substring search over text files in the repo (capped at 50 matches). */
export async function searchCode(repo: string, query: string): Promise<SearchMatch[]> {
  if (query === '') throw new Error('search_code: query must not be empty');
  const root = resolve(repo);
  const files: string[] = [];
  await walkFiles(root, root, 4, files);
  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile() || st.size > 256 * 1024) continue;
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue; // binary
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES) break;
      if (lines[i].includes(query)) {
        matches.push({ file: relative(root, file), line: i + 1, text: lines[i].slice(0, 200) });
      }
    }
  }
  return matches;
}
