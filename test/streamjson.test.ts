// stream-json classifier tests — tolerant parsing, never drops a line.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStreamLine } from '../src/adapters/streamjson.js';

describe('classifyStreamLine', () => {
  it('maps known type fields', () => {
    assert.equal(classifyStreamLine('{"type":"message","content":"hi"}')?.type, 'message');
    assert.equal(classifyStreamLine('{"type":"tool_call","tool":"x"}')?.type, 'tool_call');
    assert.equal(classifyStreamLine('{"type":"tool_use","tool":"x"}')?.type, 'tool_call');
    assert.equal(classifyStreamLine('{"type":"file_edit","path":"a"}')?.type, 'file_edit');
    assert.equal(classifyStreamLine('{"type":"cost","usage":{}}')?.type, 'cost');
    assert.equal(classifyStreamLine('{"event":"assistant","text":"hi"}')?.type, 'message');
  });

  it('unknown type falls back to message with raw payload', () => {
    const ev = classifyStreamLine('{"type":"something_new","data":1}');
    assert.equal(ev?.type, 'message');
    assert.deepEqual((ev?.payload as { data?: number }).data, 1);
  });

  it('non-JSON lines become message events', () => {
    const ev = classifyStreamLine('plain stdout text');
    assert.equal(ev?.type, 'message');
    assert.deepEqual(ev?.payload, { text: 'plain stdout text' });
  });

  it('empty lines are skipped', () => {
    assert.equal(classifyStreamLine('   '), null);
    assert.equal(classifyStreamLine(''), null);
  });

  it('key-based fallback: toolName -> tool_call, usage -> cost', () => {
    assert.equal(classifyStreamLine('{"toolName":"write"}')?.type, 'tool_call');
    assert.equal(classifyStreamLine('{"usage":{"tokens":5}}')?.type, 'cost');
  });
});
