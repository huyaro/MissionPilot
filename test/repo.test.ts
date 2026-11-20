// Repo read tools tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoMap, readRepoFile, searchCode, resolveInsideRepo } from '../src/repo.js';
import { makeTempGitRepo } from './helpers.js';

describe('repo tools', () => {
  it('repoMap lists the tree and skips .git', async () => {
    const repo = await makeTempGitRepo();
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const tree = await repoMap(repo);
    assert.match(tree, /README\.md/);
    assert.match(tree, /src\//);
    assert.match(tree, /a\.ts/);
    assert.doesNotMatch(tree, /\.git/);
  });

  it('readRepoFile reads inside the repo and rejects traversal', async () => {
    const repo = await makeTempGitRepo();
    assert.equal(await readRepoFile(repo, 'README.md'), '# test repo\n');
    await assert.rejects(readRepoFile(repo, '../outside.txt'), /escapes the repo/);
    await assert.rejects(readRepoFile(repo, '/etc/passwd'), /escapes the repo/);
    await assert.rejects(readRepoFile(repo, 'missing.txt'), /not found/);
    await assert.rejects(readRepoFile(repo, '.'), /not a file/);
  });

  it('searchCode finds matches with file/line and caps output', async () => {
    const repo = await makeTempGitRepo();
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const hello = 1;\nconst bye = 2;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const hello = 3;\n');
    const matches = await searchCode(repo, 'hello');
    assert.equal(matches.length, 2);
    assert.equal(matches[0].file, join('src', 'a.ts'));
    assert.equal(matches[0].line, 1);
    assert.equal(matches[1].line, 1);
    assert.deepEqual(await searchCode(repo, 'nothing-here'), []);
    await assert.rejects(searchCode(repo, ''), /must not be empty/);
  });

  it('resolveInsideRepo keeps paths inside the root', () => {
    assert.equal(resolveInsideRepo('/tmp/r', 'a/b.ts'), '/tmp/r/a/b.ts');
    assert.throws(() => resolveInsideRepo('/tmp/r', '..'), /escapes the repo/);
    assert.throws(() => resolveInsideRepo('/tmp/r', 'a/../../etc'), /escapes the repo/);
  });
});
