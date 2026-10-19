import assert from 'node:assert/strict';
import test from 'node:test';
import { captionStyles, defaultJobOptions } from './domain.js';
import { highlightOptionsFor, MAX_CLIP_COUNT, outputSizeFor, parseJobOptions, readStoredOptions } from './options.js';

const base = { minDurationSeconds: 20, maxDurationSeconds: 60, maxCandidates: 5, overlapThreshold: 0.65, weights: { density: 1 } };

test('no options at all, or an untouched form, mean the defaults', () => {
  assert.deepEqual(parseJobOptions({}), { ok: true, options: defaultJobOptions });
  assert.deepEqual(parseJobOptions(undefined), { ok: true, options: defaultJobOptions });
  assert.deepEqual(parseJobOptions({ clipCount: '', clipLength: '', quality: '', captionStyle: '' }), { ok: true, options: defaultJobOptions });
});

test('reads what the upload form sends (everything arrives as text)', () => {
  assert.deepEqual(parseJobOptions({ clipCount: '2', clipLength: 'short', quality: 'standard', captionStyle: 'none' }), { ok: true, options: { clipCount: 2, clipLength: 'short', quality: 'standard', captionStyle: 'none' } });
});

test('every caption style on offer is accepted, and each one survives being stored and read back', () => {
  for (const captionStyle of captionStyles) {
    const parsed = parseJobOptions({ captionStyle });
    assert.deepEqual(parsed, { ok: true, options: { ...defaultJobOptions, captionStyle } });
    assert.equal(readStoredOptions(JSON.stringify((parsed as { options: unknown }).options)).captionStyle, captionStyle);
  }
  assert.deepEqual([...captionStyles], ['classic', 'highlight', 'pop', 'none']);
});

test('ignores fields it does not know, and refuses values that are not allowed with a plain message', () => {
  assert.deepEqual(parseJobOptions({ video: 'x', somethingElse: 1 }), { ok: true, options: defaultJobOptions });
  for (const bad of [{ clipCount: '0' }, { clipCount: String(MAX_CLIP_COUNT + 1) }, { clipCount: '2.5' }, { clipCount: 'many' }, { clipLength: 'huge' }, { quality: '4k' }, { captionStyle: 'rainbow' }]) {
    const result = parseJobOptions(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (!result.ok) assert.match(result.message, /is not valid/);
  }
  const count = parseJobOptions({ clipCount: '9' });
  assert.ok(!count.ok && count.message.includes(`1 to ${MAX_CLIP_COUNT}`), 'the message must say what is allowed');
});

test('options read back from the database: a value that is no longer allowed falls back, the others stay', () => {
  assert.deepEqual(readStoredOptions(null), defaultJobOptions);
  assert.deepEqual(readStoredOptions('not json'), defaultJobOptions);
  assert.deepEqual(readStoredOptions('[1,2]'), defaultJobOptions);
  assert.deepEqual(readStoredOptions(JSON.stringify({ clipCount: 4, clipLength: 'gone', quality: 'standard', captionStyle: 'none' })), { clipCount: 4, clipLength: 'auto', quality: 'standard', captionStyle: 'none' });
  assert.deepEqual(readStoredOptions(JSON.stringify({ clipCount: 99 })), defaultJobOptions);
});

test('the chosen clip length replaces the server defaults, and enough candidates are asked for', () => {
  assert.deepEqual(highlightOptionsFor(base, defaultJobOptions), base);
  const short = highlightOptionsFor(base, { ...defaultJobOptions, clipLength: 'short' });
  assert.equal(short.minDurationSeconds, 15); assert.equal(short.maxDurationSeconds, 30);
  const long = highlightOptionsFor(base, { ...defaultJobOptions, clipLength: 'long' });
  assert.equal(long.minDurationSeconds, 60); assert.equal(long.maxDurationSeconds, 90);
  assert.equal(highlightOptionsFor({ ...base, maxCandidates: 2 }, { ...defaultJobOptions, clipCount: 5 }).maxCandidates, 5);
  assert.equal(highlightOptionsFor(base, { ...defaultJobOptions, clipCount: 1 }).maxCandidates, 5, 'never fewer than the server asks for');
});

test('the fast quality is two thirds of the configured size, always 9:16 and even, and never larger', () => {
  assert.deepEqual(outputSizeFor({ width: 1080, height: 1920 }, 'hd'), { width: 1080, height: 1920 });
  assert.deepEqual(outputSizeFor({ width: 1080, height: 1920 }, 'standard'), { width: 720, height: 1280 });
  assert.deepEqual(outputSizeFor({ width: 540, height: 960 }, 'standard'), { width: 540, height: 960 }, 'a configuration already at 720 or below is left alone');
  assert.deepEqual(outputSizeFor({ width: 2160, height: 3840 }, 'standard'), { width: 1440, height: 2560 });
});
