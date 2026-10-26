import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprintAudio, parseCachedSegments, serializeSegments } from './transcript-cache.js';
import type { TranscriptInput } from './transcription.js';

test('the fingerprint of a sound is the SHA-256 of its bytes: the same bytes give the same one, other bytes another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-fingerprint-'));
  try {
    await writeFile(join(root, 'a.wav'), 'abc'); await writeFile(join(root, 'b.wav'), 'abc'); await writeFile(join(root, 'c.wav'), 'abd');
    assert.equal(await fingerprintAudio(join(root, 'a.wav')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'the published test value of SHA-256("abc")');
    assert.equal(await fingerprintAudio(join(root, 'b.wav')), await fingerprintAudio(join(root, 'a.wav')), 'a copy has the same fingerprint, whatever it is called');
    assert.notEqual(await fingerprintAudio(join(root, 'c.wav')), await fingerprintAudio(join(root, 'a.wav')), 'one byte different');
    // A sound is read in many pieces, and every one of them counts, the last as much as the first.
    const big = Buffer.alloc(5 * 1024 * 1024, 7); await writeFile(join(root, 'big.wav'), big);
    assert.equal(await fingerprintAudio(join(root, 'big.wav')), createHash('sha256').update(big).digest('hex'), 'a file read in many pieces is still hashed whole');
    const later = Buffer.from(big); later[later.length - 1] = 8; await writeFile(join(root, 'big-later.wav'), later);
    assert.notEqual(await fingerprintAudio(join(root, 'big-later.wav')), await fingerprintAudio(join(root, 'big.wav')), 'two sounds that differ only at the very end are two sounds');
    await assert.rejects(fingerprintAudio(join(root, 'missing.wav')), /ENOENT/, 'no file, no fingerprint');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const TRANSCRIPT: TranscriptInput = [
  { segmentIndex: 0, startSeconds: 0.5, endSeconds: 2.25, text: 'Hello there, world.', words: [{ text: 'Hello', startSeconds: 0.5, endSeconds: 1 }, { text: 'there,', startSeconds: 1, endSeconds: 1.5 }, { text: 'world.', startSeconds: 1.5, endSeconds: 2.25 }] },
  { segmentIndex: 1, startSeconds: 3, endSeconds: 4, text: 'A segment without word timing.' },
];

test('a transcript comes back from the cache exactly as it went in, words included, and a segment without words stays without', () => {
  assert.deepEqual(parseCachedSegments(serializeSegments(TRANSCRIPT)), TRANSCRIPT);
  const stored = JSON.parse(serializeSegments([{ ...TRANSCRIPT[1], words: [] }])) as Array<Record<string, unknown>>;
  assert.ok(!('words' in stored[0]), 'an empty list of words is not stored');
  assert.deepEqual(parseCachedSegments(serializeSegments([{ ...TRANSCRIPT[1], words: [] }])), [TRANSCRIPT[1]]);
  const text = 'Ünïcode — “quotes”, emoji 🙂 and Arabic مرحبا بالعالم';
  assert.equal(parseCachedSegments(serializeSegments([{ segmentIndex: 0, startSeconds: 0, endSeconds: 1, text }]))?.[0].text, text, 'what was said, in any script');
});

test('a transcript that is not whole and usable is not trusted, so the speech is recognised again instead', () => {
  const good = () => JSON.parse(serializeSegments(TRANSCRIPT)) as Array<Record<string, any>>;
  const broken = (change: (segments: Array<Record<string, any>>) => void) => { const segments = good(); change(segments); return JSON.stringify(segments); };
  const refused: Array<[string, string | null | undefined]> = [
    ['nothing at all', undefined], ['null', null], ['an empty string', ''], ['not JSON', 'segments, but not as JSON'], ['an object', '{"segmentIndex":0}'], ['no segments', '[]'], ['a number in the list', '[1]'], ['null in the list', '[null]'],
    ['no text', broken((s) => { delete s[0].text; })], ['empty text', broken((s) => { s[0].text = ''; })], ['text of spaces', broken((s) => { s[0].text = '   '; })], ['text that is not text', broken((s) => { s[0].text = 5; })],
    ['a time too large to be a time (JSON allows it, it reads as infinity)', '[{"segmentIndex":0,"startSeconds":0,"endSeconds":1e999,"text":"x"}]'],
    ['no start', broken((s) => { delete s[0].startSeconds; })], ['a negative start', broken((s) => { s[0].startSeconds = -1; })], ['a start that is not a number', broken((s) => { s[0].startSeconds = '0.5'; })], ['an end before the start', broken((s) => { s[0].endSeconds = 0.1; })], ['an end that is null (what NaN becomes)', broken((s) => { s[0].endSeconds = null; })],
    ['a segment number that is not whole', broken((s) => { s[0].segmentIndex = 0.5; })], ['a negative segment number', broken((s) => { s[0].segmentIndex = -1; })], ['a segment number that is missing', broken((s) => { delete s[1].segmentIndex; })], ['the same segment twice', broken((s) => { s[1].segmentIndex = 0; })],
    ['words that are not a list', broken((s) => { s[0].words = 'Hello there'; })], ['words that are an empty list', broken((s) => { s[0].words = []; })], ['a word without text', broken((s) => { s[0].words[1].text = ''; })], ['a word without times', broken((s) => { delete s[0].words[1].endSeconds; })], ['a word that is not an object', broken((s) => { s[0].words[2] = 'world.'; })],
  ];
  for (const [what, json] of refused) assert.equal(parseCachedSegments(json), undefined, what);
});
