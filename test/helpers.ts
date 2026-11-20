// Shared test helpers: temp git repos and temp DB paths.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args]);
  return stdout.trim();
}

export async function makeTempGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-repo-'));
  await execFileAsync('git', ['init', '-b', 'main', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@local']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await execFileAsync('git', ['-C', dir, 'add', '.']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'orch-test-db-')), 'test.db');
}
