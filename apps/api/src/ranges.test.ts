import assert from 'node:assert/strict';
import test from 'node:test';
import { leadInSeconds, paddedRange, tailSeconds } from './ranges.js';

const word = (text: string, startSeconds: number, endSeconds: number) => ({ text, startSeconds, endSeconds });
const talk = [
  { startSeconds: 8, endSeconds: 10, words: [word('Before', 8, 8.6), word('it.', 9.2, 10)] },
  { startSeconds: 20, endSeconds: 30, words: [word('Start', 20, 20.5), word('here', 20.5, 21), word('end.', 29.4, 30)] },
  { startSeconds: 31, endSeconds: 33, words: [word('After', 31, 31.6), word('that.', 31.6, 33)] },
];

test('a clip gets a little room before its first word and after its last', () => {
  const range = paddedRange(20, 30, talk, 100);
  assert.equal(range.startSeconds, 20 - leadInSeconds);
  assert.equal(range.endSeconds, 30 + tailSeconds > 31 - 0.02 ? 31 - 0.02 : 30 + tailSeconds, 'the end is held back where the next word starts');
});

test('it never reaches into the word before or after: no sliver of someone\'s previous word starts a clip', () => {
  const crowded = [
    { startSeconds: 4, endSeconds: 5, words: [word('Prev', 4, 5.9)] },
    { startSeconds: 6, endSeconds: 9, words: [word('Mine', 6, 8.8)] },
    { startSeconds: 9, endSeconds: 10, words: [word('Next', 8.9, 10)] },
  ];
  const range = paddedRange(6, 9, crowded, 60);
  assert.ok(range.startSeconds >= 5.9 + 0.02 - 1e-9 && range.startSeconds <= 6, `starts at ${range.startSeconds}`);
  assert.ok(range.endSeconds >= 8.8 && range.endSeconds <= 8.9 - 0.02 + 1e-9 || range.endSeconds === 8.8, `ends at ${range.endSeconds}`);
});

test('the range stays inside the video', () => {
  const edge = [{ startSeconds: 0, endSeconds: 4, words: [word('Hi', 0, 0.3), word('there', 0.3, 3.8)] }];
  assert.deepEqual(paddedRange(0, 4, edge, 4), { startSeconds: 0, endSeconds: 4 });
  assert.equal(paddedRange(0, 4, edge, 60).endSeconds, 3.8 + tailSeconds);
});

test('a transcript without word timing is padded by its segments instead, with the same care for the neighbours', () => {
  const segments = [{ startSeconds: 0, endSeconds: 9.9 }, { startSeconds: 10, endSeconds: 20 }, { startSeconds: 22, endSeconds: 30 }];
  const range = paddedRange(10, 20, segments, 60);
  assert.equal(range.startSeconds, 9.9 + 0.02, 'held back by the segment before it');
  assert.equal(range.endSeconds, 20 + tailSeconds);
});

test('when nothing in the transcript matches the passage, the passage itself is used', () => {
  assert.deepEqual(paddedRange(5, 15, [], 60), { startSeconds: 5, endSeconds: 15 });
  assert.deepEqual(paddedRange(-3, 90, [], 60), { startSeconds: 0, endSeconds: 60 });
});
