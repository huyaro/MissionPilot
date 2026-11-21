// Executor detection + model listing tests — Qoder --list-models parsing,
// CodeBuddy product-config list + models.json merge, Pi list + models.json
// fallback, detection/added flags, failure modes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import {
  clearDetectionCache,
  listCodebuddyModels,
  listExecutorModels,
  listExecutors,
  parseCodebuddyModelsFile,
  parsePiModelsFile,
  parseQoderModels,
  resolveExecutorBin,
  whichViaLoginShell,
} from '../src/executors.js';

const fakeQoderModels = join(process.cwd(), 'scripts', 'fake-qoder-models.mjs');

describe('parseQoderModels', () => {
  it('takes plain one-per-line output', () => {
    assert.deepEqual(parseQoderModels('auto\nultimate\nefficient\n'), ['auto', 'ultimate', 'efficient']);
  });

  it('skips headers, separators and table borders; takes the first token', () => {
    const out = [
      'Model Name        Credit',
      '--------------------------',
      'Qwen3.8-Max       0.5x',
      'DeepSeek-V4-Flash 0.3x',
      'auto',
      '',
    ].join('\n');
    assert.deepEqual(parseQoderModels(out), ['Qwen3.8-Max', 'DeepSeek-V4-Flash', 'auto']);
  });

  it('parses markdown table rows by first cell and dedupes', () => {
    const out = [
      '| Model | Credit |',
      '|---|---|',
      '| Qwen3.8-Max | 0.5x |',
      '| Qwen3.8-Max | 0.5x |',
      '| auto | 1.0x |',
    ].join('\n');
    assert.deepEqual(parseQoderModels(out), ['Qwen3.8-Max', 'auto']);
  });

  it('returns an empty list for empty output', () => {
    assert.deepEqual(parseQoderModels(''), []);
    assert.deepEqual(parseQoderModels('\n\n'), []);
  });
});

describe('parseCodebuddyModelsFile', () => {
  it('prefers availableModels over models[].id', () => {
    const text = JSON.stringify({
      models: [
        { id: 'hy3', name: 'HY3' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
      availableModels: ['hy3'],
    });
    assert.deepEqual(parseCodebuddyModelsFile(text), ['hy3']);
  });

  it('falls back to models[].id when availableModels is absent', () => {
    const text = JSON.stringify({ models: [{ id: 'hy3' }, { id: 'glm-5.2' }, { name: 'no id' }] });
    assert.deepEqual(parseCodebuddyModelsFile(text), ['hy3', 'glm-5.2']);
  });

  it('throws on invalid JSON; a wrong shape yields no models', () => {
    assert.throws(() => parseCodebuddyModelsFile('{not json'), /有效的 JSON/);
    assert.deepEqual(parseCodebuddyModelsFile('[]'), []);
    assert.deepEqual(parseCodebuddyModelsFile('{}'), []);
  });
});

describe('parsePiModelsFile', () => {
  it('reads providers.<provider>.models[]', () => {
    const text = JSON.stringify({
      providers: {
        openai: { models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] },
        anthropic: { models: [{ id: 'claude-opus' }] },
      },
    });
    assert.deepEqual(parsePiModelsFile(text), ['gpt-5', 'gpt-5-mini', 'claude-opus']);
  });

  it('accepts top-level models[] and availableModels', () => {
    assert.deepEqual(
      parsePiModelsFile(JSON.stringify({ models: [{ id: 'a' }, { id: 'b' }] })),
      ['a', 'b'],
    );
    assert.deepEqual(
      parsePiModelsFile(JSON.stringify({ availableModels: ['x'], models: [{ id: 'y' }] })),
      ['x'],
    );
  });

  it('throws on invalid JSON; a wrong shape yields no models', () => {
    assert.throws(() => parsePiModelsFile('{not json'), /有效的 JSON/);
    assert.deepEqual(parsePiModelsFile('[]'), []);
    assert.deepEqual(parsePiModelsFile('{}'), []);
  });
});

describe('whichViaLoginShell', () => {
  it('resolves a real binary through a login shell', async () => {
    const path = await whichViaLoginShell('node');
    assert.ok(path && path.endsWith('node'));
  });

  it('returns null for a nonexistent binary', async () => {
    assert.equal(await whichViaLoginShell('definitely-not-a-real-bin-xyz'), null);
  });
});

describe('listExecutorModels', () => {
  it('lists qoder models from `qoder --list-models`', async () => {
    const prev = process.env.ORCHESTRATOR_QODER_BIN;
    process.env.ORCHESTRATOR_QODER_BIN = fakeQoderModels;
    try {
      const result = await listExecutorModels('qoder');
      assert.deepEqual(result.models, ['Qwen3.8-Max', 'DeepSeek-V4-Flash', 'auto']);
      assert.match(result.source, /--list-models/);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
      else process.env.ORCHESTRATOR_QODER_BIN = prev;
    }
  });

  it('fails clearly when the qoder binary cannot be spawned', async () => {
    // A binary that detection finds (answers --version) but that fails
    // on --list-models.
    const dir = mkdtempSync(join(tmpdir(), 'orch-qoder-fail-'));
    const fakeBin = join(dir, 'qoder');
    writeFileSync(
      fakeBin,
      '#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("qoder 1.0\\n"); process.exit(0); }\nprocess.stderr.write("boom\\n");\nprocess.exit(1);\n',
      'utf8',
    );
    chmodSync(fakeBin, 0o755);
    const prev = process.env.ORCHESTRATOR_QODER_BIN;
    process.env.ORCHESTRATOR_QODER_BIN = fakeBin;
    try {
      clearDetectionCache();
      await assert.rejects(() => listExecutorModels('qoder'), /无法获取 Qoder 模型列表/);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
      else process.env.ORCHESTRATOR_QODER_BIN = prev;
    }
  });

  it('lists codebuddy models from models.json (custom models only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-cb-models-'));
    const path = join(dir, 'models.json');
    writeFileSync(
      path,
      JSON.stringify({
        models: [{ id: 'hy3' }, { id: 'deepseek-v4-pro' }],
        availableModels: ['deepseek-v4-pro'],
      }),
      'utf8',
    );
    const result = await listExecutorModels('codebuddy', {
      codebuddyModelsPath: path,
      codebuddyHomeDir: dir,
      codebuddyBinPath: null,
      codebuddyProductConfigPath: join(dir, 'no-such-spill.json'),
    });
    assert.deepEqual(result.models, ['deepseek-v4-pro']);
    assert.equal(result.source, '~/.codebuddy/models.json');
  });

  it('fails clearly when no product config and no models.json exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    await assert.rejects(
      () =>
        listExecutorModels('codebuddy', {
          codebuddyModelsPath: '/nonexistent/models.json',
          codebuddyHomeDir: dir,
          codebuddyBinPath: null,
          codebuddyProductConfigPath: join(dir, 'no-such-spill.json'),
        }),
      /未找到产品配置.*\/model 查看/,
    );
  });

  it('fails clearly when models.json holds no models and no product config exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-cb-models-'));
    const path = join(dir, 'models.json');
    writeFileSync(path, JSON.stringify({ models: [] }), 'utf8');
    await assert.rejects(
      () =>
        listExecutorModels('codebuddy', {
          codebuddyModelsPath: path,
          codebuddyHomeDir: dir,
          codebuddyBinPath: null,
          codebuddyProductConfigPath: join(dir, 'no-such-spill.json'),
        }),
      /未找到产品配置.*\/model 查看/,
    );
  });

  it('lists pi models from `pi --list-models`, falling back to models.json', async () => {
    // A fake pi that fails --list-models, plus a providers-shaped file.
    const dir = mkdtempSync(join(tmpdir(), 'orch-pi-models-'));
    const fakePi = join(dir, 'pi');
    writeFileSync(
      fakePi,
      '#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("pi 1.0\\n"); process.exit(0); }\nprocess.exit(1);\n',
      'utf8',
    );
    chmodSync(fakePi, 0o755);
    const modelsPath = join(dir, 'models.json');
    writeFileSync(
      modelsPath,
      JSON.stringify({ providers: { openai: { models: [{ id: 'gpt-5' }] } } }),
      'utf8',
    );
    const prevBin = process.env.ORCHESTRATOR_PI_BIN;
    process.env.ORCHESTRATOR_PI_BIN = fakePi;
    try {
      clearDetectionCache();
      const result = await listExecutorModels('pi', { piModelsPath: modelsPath });
      assert.deepEqual(result.models, ['gpt-5']);
      assert.equal(result.source, '~/.pi/agent/models.json');
    } finally {
      if (prevBin === undefined) delete process.env.ORCHESTRATOR_PI_BIN;
      else process.env.ORCHESTRATOR_PI_BIN = prevBin;
    }
  });

  it('lists pi models from `pi --list-models` when it works', async () => {
    const prevBin = process.env.ORCHESTRATOR_PI_BIN;
    process.env.ORCHESTRATOR_PI_BIN = fakeQoderModels;
    try {
      clearDetectionCache();
      const result = await listExecutorModels('pi');
      assert.deepEqual(result.models, ['Qwen3.8-Max', 'DeepSeek-V4-Flash', 'auto']);
      assert.match(result.source, /--list-models/);
    } finally {
      if (prevBin === undefined) delete process.env.ORCHESTRATOR_PI_BIN;
      else process.env.ORCHESTRATOR_PI_BIN = prevBin;
    }
  });

  it('rejects unknown executors', async () => {
    await assert.rejects(() => listExecutorModels('nope'), /unknown executor/);
  });
});

describe('listCodebuddyModels (product config)', () => {
  // Hermetic fixture home: no product config unless the test adds one.
  // baseOpts points the spill at a nonexistent file and skips the
  // bundled lookup (binPath null) unless a test overrides them.
  function baseOpts(home: string): {
    homeDir: string;
    binPath: string | null;
    productConfigPath: string;
  } {
    return {
      homeDir: home,
      binPath: null,
      productConfigPath: join(home, 'no-such-spill.json'),
    };
  }

  function writeJson(path: string, value: unknown): string {
    writeFileSync(path, JSON.stringify(value), 'utf8');
    return path;
  }

  it('prefers ACC_PRODUCT_CONFIG_PATH over the local_storage cache', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    const lsDir = join(home, '.codebuddy', 'local_storage');
    mkdirSync(lsDir, { recursive: true });
    writeJson(join(lsDir, 'a.info'), [{ data: { models: [{ id: 'info-model' }] } }]);
    const spill = writeJson(join(home, 'spill.json'), {
      models: [{ id: 'spill-model' }],
      agents: [{ name: 'cli', models: ['spill-model'] }],
    });
    const result = await listCodebuddyModels({ ...baseOpts(home), productConfigPath: spill });
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['spill-model'],
    );
    assert.equal(result.source, '~/spill.json');
  });

  it('picks the newest local_storage *.info cache and skips invalid entries', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    const lsDir = join(home, '.codebuddy', 'local_storage');
    mkdirSync(lsDir, { recursive: true });
    const oldInfo = writeJson(join(lsDir, 'old.info'), [
      { data: { models: [{ id: 'old-model' }] } },
    ]);
    const newInfo = writeJson(join(lsDir, 'new.info'), [
      { data: { models: [{ id: 'new-model' }] } },
    ]);
    // Invalid entries with NEWER mtimes must not win: not JSON, and an
    // empty models array.
    const badInfo = join(lsDir, 'bad.info');
    writeFileSync(badInfo, '{not json', 'utf8');
    const emptyInfo = writeJson(join(lsDir, 'empty.info'), [{ data: { models: [] } }]);
    utimesSync(oldInfo, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    utimesSync(newInfo, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    utimesSync(emptyInfo, new Date(2_500_000_000_000), new Date(2_500_000_000_000));
    utimesSync(badInfo, new Date(3_000_000_000_000), new Date(3_000_000_000_000));
    const result = await listCodebuddyModels(baseOpts(home));
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['new-model'],
    );
    assert.match(result.source, /local_storage\/new\.info$/);
  });

  it('falls back to the bundled product.json next to the binary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'orch-cb-pkg-'));
    const binDir = join(pkg, 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, 'codebuddy');
    writeFileSync(bin, '#!/usr/bin/env node\n', 'utf8');
    writeJson(join(pkg, 'product.json'), {
      models: [{ id: 'bundled-1' }, { id: 'bundled-2' }],
      agents: [{ name: 'cli', models: ['bundled-1'] }],
    });
    const result = await listCodebuddyModels({ ...baseOpts(home), binPath: bin });
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['bundled-1'],
    );
    assert.equal(result.source, join(pkg, 'product.json'));
  });

  it('filters built-ins to the cli whitelist but always keeps custom models', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    const spill = writeJson(join(home, 'spill.json'), {
      models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      agents: [
        { name: 'cli', models: ['a'] },
        { name: 'other', models: ['b'] },
      ],
    });
    const userPath = writeJson(join(home, 'models.json'), { models: [{ id: 'd' }] });
    const result = await listCodebuddyModels({
      ...baseOpts(home),
      productConfigPath: spill,
      codebuddyModelsPath: userPath,
    });
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['a', 'd'],
    );
  });

  it('SmartMerges: same id fully replaces, new id appends, no duplicates', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    const spill = writeJson(join(home, 'spill.json'), {
      models: [
        { id: 'a', name: 'A-builtin' },
        { id: 'b', name: 'B' },
      ],
      agents: [{ name: 'cli', models: ['a', 'b'] }],
    });
    const userPath = writeJson(join(home, 'models.json'), {
      models: [
        { id: 'a', name: 'A-custom' },
        { id: 'c', name: 'C' },
      ],
    });
    const result = await listCodebuddyModels({
      ...baseOpts(home),
      productConfigPath: spill,
      codebuddyModelsPath: userPath,
    });
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['a', 'b', 'c'],
    );
    assert.equal(
      result.models.find((m) => m.id === 'a')?.name,
      'A-custom',
    );
  });

  it('project availableModels fully overrides user-level', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    const spill = writeJson(join(home, 'spill.json'), {
      models: [{ id: 'a' }, { id: 'b' }],
      agents: [{ name: 'cli', models: ['a', 'b'] }],
    });
    const userPath = writeJson(join(home, 'models.json'), {
      models: [],
      availableModels: ['a', 'b'],
    });
    const proj = mkdtempSync(join(tmpdir(), 'orch-cb-proj-'));
    mkdirSync(join(proj, '.codebuddy'), { recursive: true });
    writeJson(join(proj, '.codebuddy', 'models.json'), {
      models: [],
      availableModels: ['b'],
    });
    const result = await listCodebuddyModels({
      ...baseOpts(home),
      productConfigPath: spill,
      codebuddyModelsPath: userPath,
      projectDir: proj,
    });
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['b'],
    );
  });

  it('an empty availableModels does not filter; no whitelist means no filtering', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    const spill = writeJson(join(home, 'spill.json'), {
      models: [{ id: 'a' }, { id: 'b' }],
    });
    const userPath = writeJson(join(home, 'models.json'), {
      models: [],
      availableModels: [],
    });
    const result = await listCodebuddyModels({
      ...baseOpts(home),
      productConfigPath: spill,
      codebuddyModelsPath: userPath,
    });
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['a', 'b'],
    );
  });

  it('fails clearly when no product config and no models.json exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-cb-home-'));
    await assert.rejects(
      () =>
        listCodebuddyModels({
          ...baseOpts(home),
          codebuddyModelsPath: join(home, 'no-models.json'),
        }),
      /未找到产品配置.*\/model 查看/,
    );
  });
});

describe('listExecutors', () => {
  it('marks detection and added state from binary presence and saved config', async () => {
    const prevCb = process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    const prevQ = process.env.ORCHESTRATOR_QODER_BIN;
    const prevPi = process.env.ORCHESTRATOR_PI_BIN;
    process.env.ORCHESTRATOR_CODEBUDDY_BIN = '/nonexistent/codebuddy';
    process.env.ORCHESTRATOR_QODER_BIN = '/nonexistent/qoder';
    process.env.ORCHESTRATOR_PI_BIN = '/nonexistent/pi';
    try {
      clearDetectionCache();
      const dataDir = mkdtempSync(join(tmpdir(), 'orch-exec-'));
      const store = new Store(join(dataDir, 'db.sqlite'));
      try {
        let list = await listExecutors(store);
        assert.deepEqual(
          list.map((e) => e.id),
          ['codebuddy', 'qoder', 'pi'],
        );
        const byId = new Map(list.map((e) => [e.id, e]));
        assert.equal(byId.get('codebuddy')?.detected, false);
        assert.equal(byId.get('codebuddy')?.state, 'missing');
        assert.equal(byId.get('codebuddy')?.added, false);
        assert.match(byId.get('codebuddy')?.reason ?? '', /PATH 中没有.*codebuddy/);
        assert.equal(byId.get('pi')?.detected, false);
        assert.match(byId.get('pi')?.reason ?? '', /\.pi\/agent/);
        store.upsertExecutorConfig('codebuddy', {
          models: [{ id: 'hy3', reasoning: 'high', context: '128K' }],
          defaultModel: 'hy3',
        });
        list = await listExecutors(store);
        assert.equal(list.find((e) => e.id === 'codebuddy')?.added, true);
        assert.equal(list.find((e) => e.id === 'codebuddy')?.config?.defaultModel, 'hy3');
        assert.equal(store.deleteExecutorConfig('codebuddy'), true);
        assert.equal(store.deleteExecutorConfig('codebuddy'), false);
        list = await listExecutors(store);
        assert.equal(list.find((e) => e.id === 'codebuddy')?.added, false);
      } finally {
        store.close();
      }
    } finally {
      if (prevCb === undefined) delete process.env.ORCHESTRATOR_CODEBUDDY_BIN;
      else process.env.ORCHESTRATOR_CODEBUDDY_BIN = prevCb;
      if (prevQ === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
      else process.env.ORCHESTRATOR_QODER_BIN = prevQ;
      if (prevPi === undefined) delete process.env.ORCHESTRATOR_PI_BIN;
      else process.env.ORCHESTRATOR_PI_BIN = prevPi;
    }
  });

  it('detects pi from its config dir when no binary is on PATH', async () => {
    const prevCb = process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    const prevQ = process.env.ORCHESTRATOR_QODER_BIN;
    const prevPi = process.env.ORCHESTRATOR_PI_BIN;
    process.env.ORCHESTRATOR_CODEBUDDY_BIN = '/nonexistent/codebuddy';
    process.env.ORCHESTRATOR_QODER_BIN = '/nonexistent/qoder';
    process.env.ORCHESTRATOR_PI_BIN = '/nonexistent/pi';
    try {
      clearDetectionCache();
      const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
      const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-exec-')), 'db.sqlite'));
      try {
        const list = await listExecutors(store, { homeDir: home });
        const pi = list.find((e) => e.id === 'pi');
        assert.equal(pi?.detected, true);
        assert.deepEqual(pi?.signal, { kind: 'config', value: '~/.pi/agent' });
        // Detected agents sort first.
        assert.equal(list[0]?.id, 'pi');
      } finally {
        store.close();
      }
    } finally {
      if (prevCb === undefined) delete process.env.ORCHESTRATOR_CODEBUDDY_BIN;
      else process.env.ORCHESTRATOR_CODEBUDDY_BIN = prevCb;
      if (prevQ === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
      else process.env.ORCHESTRATOR_QODER_BIN = prevQ;
      if (prevPi === undefined) delete process.env.ORCHESTRATOR_PI_BIN;
      else process.env.ORCHESTRATOR_PI_BIN = prevPi;
    }
  });

  it('reports the binary path, signal and --version', async () => {
    // A temp script that answers --version (detection probes it).
    const dir = mkdtempSync(join(tmpdir(), 'orch-cb-bin-'));
    const fakeBin = join(dir, 'codebuddy');
    writeFileSync(
      fakeBin,
      '#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("codebuddy 9.9.9\\n"); process.exit(0); }\nprocess.exit(0);\n',
      'utf8',
    );
    chmodSync(fakeBin, 0o755);
    const prevCb = process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    const prevQ = process.env.ORCHESTRATOR_QODER_BIN;
    const prevPi = process.env.ORCHESTRATOR_PI_BIN;
    process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
    process.env.ORCHESTRATOR_QODER_BIN = '/nonexistent/qoder';
    process.env.ORCHESTRATOR_PI_BIN = '/nonexistent/pi';
    try {
      clearDetectionCache();
      const store = new Store(join(mkdtempSync(join(tmpdir(), 'orch-exec-')), 'db.sqlite'));
      try {
        const list = await listExecutors(store);
        const cb = list.find((e) => e.id === 'codebuddy');
        assert.equal(cb?.detected, true);
        assert.equal(cb?.signal?.kind, 'binary');
        assert.equal(cb?.signal?.value, fakeBin);
        assert.equal(cb?.version, 'codebuddy 9.9.9');
      } finally {
        store.close();
      }
    } finally {
      if (prevCb === undefined) delete process.env.ORCHESTRATOR_CODEBUDDY_BIN;
      else process.env.ORCHESTRATOR_CODEBUDDY_BIN = prevCb;
      if (prevQ === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
      else process.env.ORCHESTRATOR_QODER_BIN = prevQ;
      if (prevPi === undefined) delete process.env.ORCHESTRATOR_PI_BIN;
      else process.env.ORCHESTRATOR_PI_BIN = prevPi;
    }
  });

  it('prefers qoder over qodercli, with qodercli as fallback', async () => {
    const prevQ = process.env.ORCHESTRATOR_QODER_BIN;
    const prevPath = process.env.PATH;
    delete process.env.ORCHESTRATOR_QODER_BIN;
    const dir = mkdtempSync(join(tmpdir(), 'orch-qoder-bin-'));
    const qodercli = join(dir, 'qodercli');
    writeFileSync(qodercli, '#!/usr/bin/env node\nprocess.stdout.write("qodercli 1.0\\n");\n', 'utf8');
    chmodSync(qodercli, 0o755);
    try {
      clearDetectionCache();
      process.env.PATH = `${dir}:${prevPath ?? ''}`;
      assert.equal(await resolveExecutorBin('qoder'), qodercli);
      const qoder = join(dir, 'qoder');
      writeFileSync(qoder, '#!/usr/bin/env node\nprocess.stdout.write("qoder 1.0\\n");\n', 'utf8');
      chmodSync(qoder, 0o755);
      clearDetectionCache();
      assert.equal(await resolveExecutorBin('qoder'), qoder);
    } finally {
      if (prevQ === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
      else process.env.ORCHESTRATOR_QODER_BIN = prevQ;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});
