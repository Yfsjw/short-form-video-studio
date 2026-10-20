import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestTitle } from './titles.js';

test('the title is the sentence that reads most like a headline: a question, a hook, a number, strong wording', () => {
  assert.equal(suggestTitle(['We started the project last spring. Why do most channels stop growing after a year? Nobody really knows.']), 'Why do most channels stop growing after a year?');
  assert.equal(suggestTitle(['Let me start slowly with the weather. Here is why 3 simple habits beat any talent you were born with.']), 'Here is why 3 simple habits beat any talent you were born with');
});

test('spoken lead-ins are dropped, the first letter is a capital, and the closing full stop goes', () => {
  assert.equal(suggestTitle(['So, um, the whole thing was a mistake.']), 'The whole thing was a mistake');
  assert.equal(suggestTitle(['and then we built it all again.']), 'We built it all again');
});

test('a long sentence is cut at a word and marked, never in the middle of a word', () => {
  const title = suggestTitle(['Nobody tells you this about growing a channel from nothing, but consistency beats talent every single time you try.'])!;
  assert.ok(title.endsWith('…'));
  assert.ok(title.length <= 71);
  assert.ok(!/\s…$/.test(title));
  assert.equal(title, 'Nobody tells you this about growing a channel from nothing, but…');
});

test('with nothing worth a title there is none, and nothing is ever invented', () => {
  assert.equal(suggestTitle([]), null);
  assert.equal(suggestTitle(['Yes.', 'Okay.']), null);
  const words = new Set('Why do most channels stop growing after a year The answer is consistency'.toLowerCase().split(' '));
  for (const word of suggestTitle(['Why do most channels stop growing after a year? The answer is consistency.'])!.toLowerCase().replace(/[?.]/g, '').split(' ')) assert.ok(words.has(word), `"${word}" was not said`);
});
