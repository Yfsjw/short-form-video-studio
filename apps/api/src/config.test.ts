import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

test('configuration resolves persistence paths and defaults', () => {
  const config = loadConfig({ CORS_ORIGIN: 'http://localhost:5173' });
  assert.equal(config.PORT, 3001);
  assert.ok(config.DATABASE_PATH.endsWith('/data/studio.db'));
});

test('configuration rejects inverted highlight duration bounds', () => {
  assert.throws(() => loadConfig({ CORS_ORIGIN: 'http://localhost:5173', HIGHLIGHT_MIN_DURATION_SECONDS: '61', HIGHLIGHT_MAX_DURATION_SECONDS: '60' }));
});
