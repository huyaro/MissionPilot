// Persisted tunnel config tests — save/load round-trip, missing and
// corrupt files, owner-only permissions, overwrite.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTunnelConfig,
  saveTunnelConfig,
  tunnelConfigPath,
} from '../src/tunnel-config.js';

describe('tunnel config file', () => {
  it('round-trips the tunnel id and key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-tunnel-cfg-'));
    saveTunnelConfig(dir, { tunnelId: 'tunnel_x', apiKey: 'secret-key-123' });
    assert.deepEqual(loadTunnelConfig(dir), { tunnelId: 'tunnel_x', apiKey: 'secret-key-123' });
  });

  it('returns null when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-tunnel-cfg-'));
    assert.equal(loadTunnelConfig(dir), null);
  });

  it('returns null for a corrupt or incomplete file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-tunnel-cfg-'));
    writeFileSync(join(dir, 'tunnel-config.json'), '{not json', 'utf8');
    assert.equal(loadTunnelConfig(dir), null);
    writeFileSync(join(dir, 'tunnel-config.json'), '{"tunnelId":"tunnel_x"}', 'utf8');
    assert.equal(loadTunnelConfig(dir), null);
    writeFileSync(join(dir, 'tunnel-config.json'), '{"tunnelId":"","apiKey":"k"}', 'utf8');
    assert.equal(loadTunnelConfig(dir), null);
  });

  it('creates the file owner-only and overwrites on save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-tunnel-cfg-'));
    saveTunnelConfig(dir, { tunnelId: 'tunnel_x', apiKey: 'k1' });
    const mode = statSync(tunnelConfigPath(dir)).mode & 0o777;
    assert.equal(mode, 0o600);
    saveTunnelConfig(dir, { tunnelId: 'tunnel_y', apiKey: 'k2' });
    assert.deepEqual(loadTunnelConfig(dir), { tunnelId: 'tunnel_y', apiKey: 'k2' });
    assert.equal(readFileSync(tunnelConfigPath(dir), 'utf8').includes('k2'), true);
  });
});
