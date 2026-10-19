import assert from 'node:assert/strict';
import test from 'node:test';
import { distributeWords, parseStoredWords, wordsFromTokens, type RawToken } from './words.js';

const token = (text: string, startSeconds?: number, endSeconds?: number): RawToken => ({ text, startSeconds, endSeconds });

test('pieces of words are joined into words, punctuation stays with its word, and special tokens are not speech', () => {
  const words = wordsFromTokens([
    token('[_BEG_]', 0, 0),
    token(' Hello', 0.1, 0.5),
    token(' don', 0.6, 0.8), token("'t", 0.8, 0.9),
    token(' stop', 1.0, 1.4), token('.', 1.4, 1.45),
    token('[_TT_150]', 1.5, 1.5),
  ], 0, 1.5);
  assert.deepEqual(words?.map((word) => word.text), ['Hello', "don't", 'stop.']);
  assert.deepEqual(words?.map((word) => [word.startSeconds, word.endSeconds]), [[0.1, 0.5], [0.6, 0.9], [1.0, 1.45]]);
});

test('a lone space piece ends the word before it, and the text of a word never carries spaces', () => {
  const words = wordsFromTokens([token(' New', 0, 0.3), token(' '), token('York', 0.4, 0.8)], 0, 1);
  assert.deepEqual(words?.map((word) => word.text), ['New', 'York']);
});

test('times that go backwards, overlap, lie outside the segment or are missing are tidied: nothing is ever out of order', () => {
  const words = wordsFromTokens([
    token(' one', 1.0, 1.6), // overlaps the next word
    token(' two', 1.4, 1.8), // starts before the previous word ended
    token(' three'), // no times at all
    token(' four', 1.7, 1.9), // starts before the previous one (which inherited a later time)
    token(' five', 1.9, 9), // ends far outside the segment
  ], 1, 2.5);
  assert.ok(words);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    assert.ok(word.endSeconds > word.startSeconds, `${word.text} lasts no time`);
    assert.ok(word.startSeconds >= 1 && word.endSeconds <= 2.5 + 0.2, `${word.text} lies outside the segment`);
    if (index) assert.ok(word.startSeconds >= words[index - 1].startSeconds, `${word.text} starts before the word before it`);
    if (index) assert.ok(words[index - 1].endSeconds <= word.startSeconds + 1e-9, `${words[index - 1].text} is still going when ${word.text} starts`);
  }
});

test('times that cannot be trusted give no words at all, so the caller falls back to spreading the text', () => {
  assert.equal(wordsFromTokens([token(' a'), token(' b')], 0, 2), undefined, 'no times were reported');
  assert.equal(wordsFromTokens([], 0, 2), undefined);
  assert.equal(wordsFromTokens([token('[_BEG_]', 0, 0), token('[_TT_50]', 0.5, 0.5)], 0, 2), undefined, 'only special tokens');
  const collapsed = ['one', 'two', 'three', 'four', 'five', 'six'].map((text) => token(` ${text}`, 0.5, 0.5));
  assert.equal(wordsFromTokens(collapsed, 0, 6), undefined, 'every word at the same instant is a failed alignment');
  const squeezed = ['one', 'two', 'three', 'four'].map((text, index) => token(` ${text}`, index * 0.1, index * 0.1 + 0.1));
  assert.equal(wordsFromTokens(squeezed, 0, 10), undefined, 'all the words squeezed into the first 0.4 s of a 10 s segment');
  assert.ok(wordsFromTokens(squeezed, 0, 0.5), 'the same times are fine for a segment that is short');
});

test('text with no timing is spread over the segment in proportion to the length of its words, covering it exactly', () => {
  const words = distributeWords('a longer word', 10, 14);
  assert.deepEqual(words.map((word) => word.text), ['a', 'longer', 'word']);
  assert.equal(words[0].startSeconds, 10);
  assert.equal(words[2].endSeconds, 14);
  for (let index = 1; index < words.length; index += 1) assert.equal(words[index].startSeconds, words[index - 1].endSeconds);
  assert.ok(words[1].endSeconds - words[1].startSeconds > words[0].endSeconds - words[0].startSeconds, 'a longer word gets more time');
  assert.deepEqual(distributeWords('   ', 0, 1), []);
  assert.equal(distributeWords('instant', 5, 5)[0].endSeconds, 5, 'a segment with no length does not produce backwards times');
});

test('words read back from the database must be a proper list; anything else counts as "no words stored"', () => {
  assert.deepEqual(parseStoredWords(JSON.stringify([{ text: 'hi', startSeconds: 1, endSeconds: 2 }])), [{ text: 'hi', startSeconds: 1, endSeconds: 2 }]);
  for (const bad of [null, undefined, '', 'not json', '{}', '[]', '[1]', '[{"text":"x"}]', '[{"text":"","startSeconds":1,"endSeconds":2}]', '[{"text":"x","startSeconds":"1","endSeconds":2}]']) {
    assert.equal(parseStoredWords(bad), undefined, `accepted ${String(bad)}`);
  }
  assert.equal(parseStoredWords(JSON.stringify([{ text: 'x', startSeconds: 3, endSeconds: 1 }]))?.[0].endSeconds, 3, 'an end before the start is raised to the start');
});
