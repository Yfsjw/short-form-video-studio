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

test('the keep-awake switch is on by default, can be switched off, and rejects typos like the other safety flags', () => {
  assert.equal(loadConfig({}).KEEP_AWAKE_WHILE_PROCESSING, true);
  assert.equal(loadConfig({ KEEP_AWAKE_WHILE_PROCESSING: '' }).KEEP_AWAKE_WHILE_PROCESSING, true);
  for (const off of ['false', 'FALSE', '0', 'no', 'off']) assert.equal(loadConfig({ KEEP_AWAKE_WHILE_PROCESSING: off }).KEEP_AWAKE_WHILE_PROCESSING, false, `"${off}" should switch it off`);
  for (const on of ['true', '1', 'yes', 'on']) assert.equal(loadConfig({ KEEP_AWAKE_WHILE_PROCESSING: on }).KEEP_AWAKE_WHILE_PROCESSING, true);
  assert.throws(() => loadConfig({ KEEP_AWAKE_WHILE_PROCESSING: 'flase' }));
});

test('following a face is on by default (a person still has to ask for it per video), can be switched off, and rejects typos like the other flags', () => {
  assert.equal(loadConfig({}).FACE_FRAMING_ENABLED, true);
  assert.equal(loadConfig({ FACE_FRAMING_ENABLED: '' }).FACE_FRAMING_ENABLED, true);
  for (const off of ['false', 'FALSE', '0', 'no', 'off']) assert.equal(loadConfig({ FACE_FRAMING_ENABLED: off }).FACE_FRAMING_ENABLED, false, `"${off}" should switch it off`);
  for (const on of ['true', '1', 'yes', 'on']) assert.equal(loadConfig({ FACE_FRAMING_ENABLED: on }).FACE_FRAMING_ENABLED, true);
  assert.throws(() => loadConfig({ FACE_FRAMING_ENABLED: 'flase' }));
});

test('the start-up check of the video tools is on by default, can be switched off, and rejects typos like the other flags', () => {
  assert.equal(loadConfig({}).TOOLCHAIN_CHECK_ENABLED, true);
  assert.equal(loadConfig({ TOOLCHAIN_CHECK_ENABLED: '' }).TOOLCHAIN_CHECK_ENABLED, true);
  for (const off of ['false', 'FALSE', '0', 'no', 'off']) assert.equal(loadConfig({ TOOLCHAIN_CHECK_ENABLED: off }).TOOLCHAIN_CHECK_ENABLED, false, `"${off}" should switch it off`);
  for (const on of ['true', '1', 'yes', 'on']) assert.equal(loadConfig({ TOOLCHAIN_CHECK_ENABLED: on }).TOOLCHAIN_CHECK_ENABLED, true);
  assert.throws(() => loadConfig({ TOOLCHAIN_CHECK_ENABLED: 'flase' }));
});

test('the public address Render provides is used when valid, and a bad one never stops the server from starting', () => {
  assert.equal(loadConfig({}).RENDER_EXTERNAL_URL, undefined);
  assert.equal(loadConfig({ RENDER_EXTERNAL_URL: 'https://studio.onrender.com' }).RENDER_EXTERNAL_URL, 'https://studio.onrender.com');
  for (const unusable of ['', ' ', 'not a url', 'studio.onrender.com']) assert.equal(loadConfig({ RENDER_EXTERNAL_URL: unusable }).RENDER_EXTERNAL_URL, undefined, `"${unusable}" must be ignored, not crash the boot`);
});

test('the upload limit can be raised or lowered from the environment', () => {
  assert.equal(loadConfig({ MAX_UPLOAD_BYTES: '104857600' }).MAX_UPLOAD_BYTES, 104_857_600);
  assert.equal(loadConfig({}).MAX_UPLOAD_BYTES, 2_147_483_648);
});

test('speech recognition stays on this machine unless a hosted service is asked for, and a hosted one cannot be half-configured', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.TRANSCRIPTION_ENGINE, 'whisper_cpp');
  assert.equal(defaults.TRANSCRIPTION_API_URL, undefined);
  assert.equal(defaults.TRANSCRIPTION_API_MODEL, 'whisper-1');
  assert.equal(defaults.TRANSCRIPTION_CHUNK_SECONDS, 600);
  assert.equal(defaults.TRANSCRIPTION_API_CONCURRENCY, 3);

  const secret = 'not-a-real-key-for-this-test';
  assert.throws(() => loadConfig({ TRANSCRIPTION_ENGINE: 'openai_compatible' }), /TRANSCRIPTION_API_URL and TRANSCRIPTION_API_KEY/);
  assert.throws(() => loadConfig({ TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example/v1' }), /TRANSCRIPTION_API_KEY/);
  assert.throws(() => loadConfig({ TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_KEY: secret }), (error: Error) => /TRANSCRIPTION_API_URL/.test(error.message) && !error.message.includes(secret));
  assert.throws(() => loadConfig({ TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example/v1', TRANSCRIPTION_API_KEY: '   ' }), /TRANSCRIPTION_API_KEY/);
  const hosted = loadConfig({ TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example/v1', TRANSCRIPTION_API_KEY: secret, TRANSCRIPTION_API_MODEL: 'whisper-large-v3-turbo', TRANSCRIPTION_CHUNK_SECONDS: '300', TRANSCRIPTION_API_CONCURRENCY: '2' });
  assert.deepEqual([hosted.TRANSCRIPTION_ENGINE, hosted.TRANSCRIPTION_API_MODEL, hosted.TRANSCRIPTION_CHUNK_SECONDS, hosted.TRANSCRIPTION_API_CONCURRENCY], ['openai_compatible', 'whisper-large-v3-turbo', 300, 2]);
});

test('hosted speech recognition settings that make no sense are refused at startup', () => {
  assert.throws(() => loadConfig({ TRANSCRIPTION_ENGINE: 'some_other_engine' }));
  assert.throws(() => loadConfig({ TRANSCRIPTION_API_URL: 'not an address' }));
  for (const bad of ['0', '59', '3601']) assert.throws(() => loadConfig({ TRANSCRIPTION_CHUNK_SECONDS: bad }), Error, `${bad} s per piece`);
  for (const bad of ['0', '9']) assert.throws(() => loadConfig({ TRANSCRIPTION_API_CONCURRENCY: bad }), Error, `${bad} requests at once`);
  assert.throws(() => loadConfig({ TRANSCRIPTION_API_TIMEOUT_MS: '1000' }));
});
