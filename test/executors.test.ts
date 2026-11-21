// Executor detection + model listing tests — Qoder --list-models parsing,
// CodeBuddy models.json parsing, detection/added flags, failure modes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import {
  listExecutorModels,
  listExecutors,
  parseCodebuddyModelsFile,
  parseQoderModels,
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
    const prev = process.env.ORCHESTRATOR_QODER_BIN;
    process.env.ORCHESTRATOR_QODER_BIN = '/nonexistent/qoder';
    try {
      await assert.rejects(() => listExecutorModels('qoder'), /无法获取 Qoder 模型列表/);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
      else process.env.ORCHESTRATOR_QODER_BIN = prev;
    }
  });

  it('lists codebuddy models from models.json', async () => {
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
    const result = await listExecutorModels('codebuddy', { codebuddyModelsPath: path });
    assert.deepEqual(result.models, ['deepseek-v4-pro']);
    assert.equal(result.source, '~/.codebuddy/models.json');
  });

  it('fails clearly when the codebuddy models file is missing', async () => {
    await assert.rejects(
      () => listExecutorModels('codebuddy', { codebuddyModelsPath: '/nonexistent/models.json' }),
      /未找到 CodeBuddy 模型配置文件/,
    );
  });

  it('rejects executors without a model-list mechanism', async () => {
    await assert.rejects(() => listExecutorModels('gemini'), /不支持获取模型列表/);
    await assert.rejects(() => listExecutorModels('nope'), /unknown executor/);
  });
});

describe('listExecutors', () => {
  it('marks detection and added state from binary presence and saved config', async () => {
    const prevCb = process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    const prevQ = process.env.ORCHESTRATOR_QODER_BIN;
    process.env.ORCHESTRATOR_CODEBUDDY_BIN = '/nonexistent/codebuddy';
    process.env.ORCHESTRATOR_QODER_BIN = '/nonexistent/qoder';
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'orch-exec-'));
      const store = new Store(join(dataDir, 'db.sqlite'));
      try {
        let list = await listExecutors(store);
        const byId = new Map(list.map((e) => [e.id, e]));
        assert.equal(byId.get('codebuddy')?.detected, false);
        assert.equal(byId.get('codebuddy')?.state, 'missing');
        assert.equal(byId.get('codebuddy')?.added, false);
        assert.equal(byId.get('workbuddy')?.state, 'pending');
        assert.equal(byId.get('gemini')?.state, 'not-connected');
        store.upsertExecutorConfig('codebuddy', { models: ['hy3'], defaultModel: 'hy3' });
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
    }
  });
});
