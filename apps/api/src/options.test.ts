import assert from 'node:assert/strict';
import test from 'node:test';
import { aspectChoices, captionStyles, defaultJobOptions, framingChoices } from './domain.js';
import { aspectRatios, highlightOptionsFor, MAX_CLIP_COUNT, outputSizeFor, parseJobOptions, readStoredOptions, shapeSize } from './options.js';

const base = { minDurationSeconds: 20, maxDurationSeconds: 60, maxCandidates: 5, overlapThreshold: 0.65, weights: { density: 1 } };

test('no options at all, or an untouched form, mean the defaults', () => {
  assert.deepEqual(parseJobOptions({}), { ok: true, options: defaultJobOptions });
  assert.deepEqual(parseJobOptions(undefined), { ok: true, options: defaultJobOptions });
  assert.deepEqual(parseJobOptions({ clipCount: '', clipLength: '', quality: '', captionStyle: '', framing: '', aspect: '' }), { ok: true, options: defaultJobOptions });
});

test('reads what the upload form sends (everything arrives as text)', () => {
  assert.deepEqual(parseJobOptions({ clipCount: '2', clipLength: 'short', quality: 'standard', captionStyle: 'none' }), { ok: true, options: { clipCount: 2, clipLength: 'short', quality: 'standard', captionStyle: 'none', framing: 'center', aspect: 'vertical' } });
  assert.deepEqual(parseJobOptions({ clipCount: '3', clipLength: 'long', quality: 'hd', captionStyle: 'pop', framing: 'face', aspect: 'square' }), { ok: true, options: { clipCount: 3, clipLength: 'long', quality: 'hd', captionStyle: 'pop', framing: 'face', aspect: 'square' } });
});

test('framing: the middle of the picture unless something else is asked for, and each choice survives being stored and read back', () => {
  assert.deepEqual([...framingChoices], ['center', 'face', 'fit']);
  assert.equal(defaultJobOptions.framing, 'center', 'following a face is opt-in, never the default');
  for (const framing of framingChoices) {
    const parsed = parseJobOptions({ framing });
    assert.deepEqual(parsed, { ok: true, options: { ...defaultJobOptions, framing } });
    assert.equal(readStoredOptions(JSON.stringify((parsed as { options: unknown }).options)).framing, framing);
  }
  const face = parseJobOptions({ framing: 'face' });
  assert.ok(face.ok && face.options.clipCount === defaultJobOptions.clipCount && face.options.captionStyle === defaultJobOptions.captionStyle, 'choosing a face leaves the other choices alone');
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
  for (const bad of [{ clipCount: '0' }, { clipCount: String(MAX_CLIP_COUNT + 1) }, { clipCount: '2.5' }, { clipCount: 'many' }, { clipLength: 'huge' }, { quality: '4k' }, { captionStyle: 'rainbow' }, { framing: 'sideways' }, { framing: 'FACE' }, { aspect: '4:5' }, { aspect: 'wide' }, { aspect: 'SQUARE' }]) {
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
  assert.deepEqual(readStoredOptions(JSON.stringify({ clipCount: 4, clipLength: 'gone', quality: 'standard', captionStyle: 'none' })), { clipCount: 4, clipLength: 'auto', quality: 'standard', captionStyle: 'none', framing: 'center', aspect: 'vertical' });
  assert.deepEqual(readStoredOptions(JSON.stringify({ clipCount: 99 })), defaultJobOptions);
});

test('jobs stored before face framing existed, or with a framing that is no longer offered, are read as the middle of the picture', () => {
  const before = JSON.stringify({ clipCount: 2, clipLength: 'short', quality: 'hd', captionStyle: 'highlight' });
  assert.deepEqual(readStoredOptions(before), { clipCount: 2, clipLength: 'short', quality: 'hd', captionStyle: 'highlight', framing: 'center', aspect: 'vertical' });
  assert.equal(readStoredOptions(JSON.stringify({ framing: 'gone' })).framing, 'center');
  assert.equal(readStoredOptions(JSON.stringify({ framing: 7 })).framing, 'center');
  assert.equal(readStoredOptions(JSON.stringify({ framing: 'face', clipCount: 99 })).framing, 'face', 'one value that is no longer allowed must not undo the others');
});

test('shape: vertical unless something else is asked for; jobs stored before shapes existed, or with a shape that is no longer offered, are vertical', () => {
  assert.deepEqual([...aspectChoices], ['vertical', 'portrait', 'square', 'landscape']);
  assert.equal(defaultJobOptions.aspect, 'vertical', 'every clip made so far was vertical, so that stays the default');
  for (const aspect of aspectChoices) {
    const parsed = parseJobOptions({ aspect });
    assert.deepEqual(parsed, { ok: true, options: { ...defaultJobOptions, aspect } });
    assert.equal(readStoredOptions(JSON.stringify((parsed as { options: unknown }).options)).aspect, aspect);
  }
  assert.equal(readStoredOptions(JSON.stringify({ clipCount: 2 })).aspect, 'vertical', 'a job stored before shapes existed');
  assert.equal(readStoredOptions(JSON.stringify({ aspect: 'gone' })).aspect, 'vertical');
  assert.equal(readStoredOptions(JSON.stringify({ aspect: 3 })).aspect, 'vertical');
  assert.equal(readStoredOptions(JSON.stringify({ aspect: 'square', clipCount: 99 })).aspect, 'square', 'one value that is no longer allowed must not undo the others');
  const square = parseJobOptions({ aspect: 'square' });
  assert.ok(square.ok && square.options.framing === defaultJobOptions.framing && square.options.quality === defaultJobOptions.quality, 'choosing a shape leaves the other choices alone');
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

test('every shape has exactly its own proportions, at both qualities, with even sides and never larger than configured', () => {
  const configured = { width: 1080, height: 1920 };
  assert.deepEqual(aspectRatios, { vertical: 9 / 16, portrait: 4 / 5, square: 1, landscape: 16 / 9 });
  const expected = {
    vertical: { hd: { width: 1080, height: 1920 }, standard: { width: 720, height: 1280 } },
    portrait: { hd: { width: 1080, height: 1350 }, standard: { width: 720, height: 900 } },
    square: { hd: { width: 1080, height: 1080 }, standard: { width: 720, height: 720 } },
    landscape: { hd: { width: 1920, height: 1080 }, standard: { width: 1280, height: 720 } },
  } as const;
  for (const aspect of aspectChoices) {
    for (const quality of ['hd', 'standard'] as const) {
      const size = outputSizeFor(configured, quality, aspect);
      assert.deepEqual(size, expected[aspect][quality], `${aspect} ${quality}`);
      assert.ok(size.width % 2 === 0 && size.height % 2 === 0, `${aspect} ${quality}: even sides (H.264 needs them)`);
      assert.equal(size.width / size.height, aspectRatios[aspect], `${aspect} ${quality}: exactly the shape asked for`);
    }
    assert.deepEqual(outputSizeFor(configured, 'hd', aspect), shapeSize(configured, aspect));
  }
  assert.deepEqual(outputSizeFor(configured, 'standard'), outputSizeFor(configured, 'standard', 'vertical'), 'the shape defaults to vertical');
  // A server configured at 720x1280 already makes the fast size, whatever the shape; a larger one scales every shape alike.
  assert.deepEqual(outputSizeFor({ width: 720, height: 1280 }, 'standard', 'landscape'), { width: 1280, height: 720 });
  assert.deepEqual(outputSizeFor({ width: 720, height: 1280 }, 'standard', 'portrait'), { width: 720, height: 900 });
  assert.deepEqual(outputSizeFor({ width: 2160, height: 3840 }, 'standard', 'landscape'), { width: 2560, height: 1440 });
  assert.deepEqual(outputSizeFor({ width: 2160, height: 3840 }, 'hd', 'square'), { width: 2160, height: 2160 });
});
