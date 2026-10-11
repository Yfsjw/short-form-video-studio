import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

test('configuration resolves persistence paths and defaults', () => {
  const config = loadConfig({ CORS_ORIGIN: 'http://localhost:5173' });
  assert.equal(config.PORT, 3001);
  assert.ok(config.DATABASE_URL.startsWith('postgresql://'));
});

test('configuration rejects inverted highlight duration bounds', () => {
  assert.throws(() => loadConfig({ CORS_ORIGIN: 'http://localhost:5173', HIGHLIGHT_MIN_DURATION_SECONDS: '61', HIGHLIGHT_MAX_DURATION_SECONDS: '60' }));
});

test('job recovery settings have safe defaults for a 512 MB free instance', () => {
  const config = loadConfig({});
  assert.equal(config.JOB_CONCURRENCY, 1);
  assert.equal(config.JOB_MAX_ATTEMPTS, 3);
  assert.equal(config.JOB_STALE_AFTER_SECONDS, 60);
  assert.equal(config.JOB_HEARTBEAT_SECONDS, 15);
  assert.equal(config.REQUIRE_DURABLE_STORAGE, false);
});

test('REQUIRE_DURABLE_STORAGE accepts clear yes/no values and rejects typos instead of silently turning the protection off', () => {
  for (const on of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) assert.equal(loadConfig({ REQUIRE_DURABLE_STORAGE: on }).REQUIRE_DURABLE_STORAGE, true, `"${on}" should switch it on`);
  for (const off of ['false', 'FALSE', '0', 'no', 'off', '']) assert.equal(loadConfig({ REQUIRE_DURABLE_STORAGE: off }).REQUIRE_DURABLE_STORAGE, false, `"${off}" should switch it off`);
  for (const typo of ['treu', 'ture', 'enabled', '2']) assert.throws(() => loadConfig({ REQUIRE_DURABLE_STORAGE: typo }), Error, `"${typo}" must be rejected`);
});

test('job settings are validated, so a mistake fails at startup rather than during a customer job', () => {
  assert.equal(loadConfig({ JOB_CONCURRENCY: '2', JOB_MAX_ATTEMPTS: '5', JOB_STALE_AFTER_SECONDS: '120', JOB_HEARTBEAT_SECONDS: '30' }).JOB_CONCURRENCY, 2);
  assert.throws(() => loadConfig({ JOB_CONCURRENCY: '0' }));
  assert.throws(() => loadConfig({ JOB_CONCURRENCY: '9' }));
  assert.throws(() => loadConfig({ JOB_MAX_ATTEMPTS: '0' }));
  assert.throws(() => loadConfig({ JOB_STALE_AFTER_SECONDS: '1' }));
  assert.throws(() => loadConfig({ JOB_HEARTBEAT_SECONDS: '0' }));
});

test('the heartbeat must be fast enough that a healthy job is never mistaken for an abandoned one', () => {
  assert.doesNotThrow(() => loadConfig({ JOB_STALE_AFTER_SECONDS: '60', JOB_HEARTBEAT_SECONDS: '30' }));
  assert.throws(() => loadConfig({ JOB_STALE_AFTER_SECONDS: '60', JOB_HEARTBEAT_SECONDS: '31' }), /at most half/);
  assert.throws(() => loadConfig({ JOB_STALE_AFTER_SECONDS: '10' }), /at most half/); // the default 15 s heartbeat no longer fits
});

test('the upload limit can be raised or lowered from the environment', () => {
  assert.equal(loadConfig({ MAX_UPLOAD_BYTES: '104857600' }).MAX_UPLOAD_BYTES, 104_857_600);
  assert.equal(loadConfig({}).MAX_UPLOAD_BYTES, 2_147_483_648);
});
