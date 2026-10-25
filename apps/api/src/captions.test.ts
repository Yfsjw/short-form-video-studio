import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accentColours, buildCaptionChunks, captionCanvas, captionLookFor, captionLooks, chunkRules, chunkRulesFor, chunkWords, clipWords, defaultCaptionChoices, formatAssTime, formatSrtTime, renderAss, sizeScales, wordSpans, writeAssCaptions, writeSrtCaptions, type CaptionChoices, type CaptionSegmentInput, type CaptionWord } from './captions.js';
import { captionAccents, captionPositions, captionSizes } from './domain.js';

/** Words one after the other, each lasting `length` seconds, from `start` (so tests can say what is spoken and not worry about every time). */
function spoken(text: string, start = 0, length = 0.4): CaptionWord[] {
  return text.split(' ').map((word, index) => ({ text: word, startSeconds: start + index * length, endSeconds: start + (index + 1) * length }));
}
const phrases = (chunks: Array<{ words: CaptionWord[] }>) => chunks.map((chunk) => chunk.words.map((word) => word.text).join(' '));

test('formats SRT and ASS timestamps', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(61.234), '00:01:01,234');
  assert.equal(formatSrtTime(3661.999), '01:01:01,999');
  assert.equal(formatAssTime(0), '0:00:00.00');
  assert.equal(formatAssTime(61.234), '0:01:01.23');
  assert.equal(formatAssTime(3661.999), '1:01:02.00');
  assert.equal(formatAssTime(-1), '0:00:00.00');
});

test('only the words spoken inside the clip are captioned, with times counted from the start of the clip', () => {
  const segments: CaptionSegmentInput[] = [
    { startSeconds: 8, endSeconds: 12, text: 'Before the clip. Then it starts.', words: [
      { text: 'Before', startSeconds: 8, endSeconds: 8.5 }, { text: 'the', startSeconds: 8.5, endSeconds: 8.8 }, { text: 'clip.', startSeconds: 8.8, endSeconds: 9.4 },
      { text: 'Then', startSeconds: 10.2, endSeconds: 10.5 }, { text: 'it', startSeconds: 10.5, endSeconds: 10.7 }, { text: 'starts.', startSeconds: 10.7, endSeconds: 11.4 }] },
    { startSeconds: 19, endSeconds: 22, text: 'And then it ends', words: [
      { text: 'And', startSeconds: 19, endSeconds: 19.2 }, { text: 'then', startSeconds: 19.2, endSeconds: 19.5 }, { text: 'it', startSeconds: 19.5, endSeconds: 19.8 }, { text: 'ends', startSeconds: 19.8, endSeconds: 20.4 }] },
  ];
  const words = clipWords(segments, 10, 20);
  assert.deepEqual(words.map((word) => word.text), ['Then', 'it', 'starts.', 'And', 'then', 'it'], '"ends" is mostly after the clip, so it is left out');
  assert.ok(Math.abs(words[0].startSeconds - 0.2) < 1e-9 && Math.abs(words[0].endSeconds - 0.5) < 1e-9, 'counted from the start of the clip');
  assert.ok(words.every((word) => word.startSeconds >= 0 && word.endSeconds <= 10), 'nothing before the start or after the end of the clip');
  assert.equal(clipWords(segments, 30, 40).length, 0);
});

test('a word that is cut by the start of the clip is kept when most of it is inside, and dropped when only a sliver is', () => {
  const segment = (word: { text: string; startSeconds: number; endSeconds: number }): CaptionSegmentInput[] => [{ startSeconds: 9, endSeconds: 12, text: word.text, words: [word] }];
  const kept = clipWords(segment({ text: 'mostly', startSeconds: 9.8, endSeconds: 10.6 }), 10, 20);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].startSeconds === 0 && Math.abs(kept[0].endSeconds - 0.6) < 1e-9, 'cut at the start of the clip');
  assert.equal(clipWords(segment({ text: 'sliver', startSeconds: 9.5, endSeconds: 10.1 }), 10, 20).length, 0);
});

test('a segment without word timing still gets captions: its words are spread over its time', () => {
  const words = clipWords([{ startSeconds: 0, endSeconds: 4, text: 'no timing at all' }], 0, 10);
  assert.deepEqual(words.map((word) => word.text), ['no', 'timing', 'at', 'all']);
  assert.equal(words[0].startSeconds, 0);
  assert.ok(Math.abs(words[3].endSeconds - 4) < 1e-9);
});

test('words are grouped at the end of a sentence, after a comma once the group has some length, at a pause, and when they would not fit', () => {
  const classic = chunkRules.classic;
  assert.deepEqual(phrases(chunkWords(spoken('I came. I saw. I won.'), classic)), ['I came.', 'I saw.', 'I won.'], 'a sentence end always ends the group');
  assert.deepEqual(phrases(chunkWords(spoken('When the music stops, everyone must sit down'), classic)), ['When the music stops,', 'everyone must sit down'], 'a comma ends a group that is already long enough');
  assert.deepEqual(phrases(chunkWords(spoken('So, we go'), classic)), ['So, we go'], 'but not one that is still short');
  const withPause = [...spoken('hello there', 0), ...spoken('my friend', 3)];
  assert.deepEqual(phrases(chunkWords(withPause, classic)), ['hello there', 'my friend'], 'a pause of more than the allowed gap ends the group');
  const long = chunkWords(spoken('one two three four five six seven eight nine ten'), classic);
  assert.ok(long.every((chunk) => chunk.words.length <= classic.maxWords && chunk.words.map((word) => word.text).join(' ').length <= classic.maxChars), 'no group is longer than the rules allow');
  assert.deepEqual(long.flatMap((chunk) => chunk.words.map((word) => word.text)), 'one two three four five six seven eight nine ten'.split(' '), 'no word is lost or repeated');
  assert.deepEqual(phrases(chunkWords(spoken('supercalifragilisticexpialidocious'), classic)), ['supercalifragilisticexpialidocious'], 'a word that is longer than a group still gets a group of its own');
});

test('a group does not end on a word that belongs with the next one, and a sentence does not end with a group of one word when it can be avoided', () => {
  assert.deepEqual(phrases(chunkWords(spoken('tell them about the big plan'), chunkRules.highlight)), ['tell them about', 'the big plan'], '"the" starts the next group instead of ending a full one');
  assert.deepEqual(phrases(chunkWords(spoken('I told them everything honestly.'), chunkRules.classic)), ['I told them', 'everything honestly.'], 'a lone last word takes the word before it along');
  assert.deepEqual(phrases(chunkWords(spoken('I came. Yes.'), chunkRules.classic)), ['I came.', 'Yes.'], 'but a short sentence of its own stays alone');
});

test('what is on screen stays up a moment after its last word, never into the next group, and never past the end of the clip', () => {
  const segment: CaptionSegmentInput = { startSeconds: 0, endSeconds: 9, text: 'x', words: [...spoken('first part.', 1, 0.5), ...spoken('second part.', 3.2, 0.5), ...spoken('last words.', 8.6, 0.3)] };
  const chunks = buildCaptionChunks([segment], 0, 9.2, 'classic');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].endSeconds, 2 + chunkRules.classic.holdSeconds, 'a short moment after the last word (which ends at 2 s)');
  assert.equal(chunks[1].startSeconds, 3.2);
  assert.equal(chunks[1].endSeconds, 4.2 + chunkRules.classic.holdSeconds);
  const crowded = buildCaptionChunks([{ ...segment, words: [...spoken('first part.', 1, 0.5), ...spoken('second part.', 2.2, 0.5)] }], 0, 9.2, 'classic');
  assert.equal(crowded[0].endSeconds, 2.2, 'it goes when the next group comes, not later');
  assert.ok(chunks[1].endSeconds <= chunks[2].startSeconds, 'groups do not overlap');
  assert.equal(chunks[2].endSeconds, 9.2, 'the last group stops when the clip does');
  const quick = buildCaptionChunks([{ startSeconds: 0, endSeconds: 5, text: 'x', words: [{ text: 'Hi.', startSeconds: 1, endSeconds: 1.05 }] }], 0, 5, 'classic');
  assert.ok(quick[0].endSeconds - quick[0].startSeconds >= 0.3, 'even a very short word is on screen long enough to read');
});

test('writes an SRT of short phrases with clip-relative times', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-captions-')); const path = join(root, 'clip.srt');
  try {
    const count = await writeSrtCaptions(path, [
      { startSeconds: 12, endSeconds: 14, text: 'Second part here.', words: [{ text: 'Second', startSeconds: 12, endSeconds: 12.6 }, { text: 'part', startSeconds: 12.6, endSeconds: 13 }, { text: 'here.', startSeconds: 13, endSeconds: 13.6 }] },
      { startSeconds: 8, endSeconds: 12, text: 'Before the clip. Then it starts.', words: [{ text: 'Before', startSeconds: 8, endSeconds: 8.5 }, { text: 'the', startSeconds: 8.5, endSeconds: 8.8 }, { text: 'clip.', startSeconds: 8.8, endSeconds: 9.4 }, { text: 'Then', startSeconds: 10.2, endSeconds: 10.5 }, { text: 'it', startSeconds: 10.5, endSeconds: 10.7 }, { text: 'starts.', startSeconds: 10.7, endSeconds: 11.4 }] },
    ], 10, 20);
    assert.equal(count, 2);
    assert.equal(await readFile(path, 'utf8'), '1\n00:00:00,200 --> 00:00:01,650\nThen it starts.\n\n2\n00:00:02,000 --> 00:00:03,850\nSecond part here.\n');
    assert.equal(await writeSrtCaptions(path, [], 0, 10), 0, 'nothing was said: no captions');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const SAMPLE: CaptionSegmentInput[] = [{ startSeconds: 0, endSeconds: 6, text: 'x', words: [...spoken('Nobody tells you this', 0.5, 0.5)] }];
const dialogues = (ass: string) => ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
/** The text of a caption line without our own formatting tags. */
const plain = (line: string) => line.split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '');

test('the caption file is written for a 9:16 picture and names the font that ships with the program', () => {
  const ass = renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'classic'), 'classic');
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /ScaledBorderAndShadow: yes/);
  assert.match(ass, /\nStyle: Caption,Inter ExtraBold,/);
});

test('classic captions: one line per group, white, no formatting inside', () => {
  const lines = dialogues(renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'classic'), 'classic'));
  assert.equal(lines.length, 1);
  assert.equal(plain(lines[0]), 'Nobody tells you this');
  assert.ok(!lines[0].includes('{'), 'no formatting tags at all');
  assert.match(lines[0], /^Dialogue: 0,0:00:00\.50,0:00:02\.75,Caption,/);
});

test('highlighted captions: the word being spoken is lit, one at a time, and the lines follow each other without gaps or overlaps', () => {
  const chunks = buildCaptionChunks(SAMPLE, 0, 6, 'highlight');
  const lines = dialogues(renderAss(chunks, 'highlight'));
  assert.equal(lines.length, 4, 'one line per word');
  lines.forEach((line, index) => {
    assert.equal(plain(line), 'Nobody tells you this', 'the whole group stays on screen');
    const lit = [...line.matchAll(/\{\\1c&H0000D7FF&\}([^{]+)\{\\1c&H00FFFFFF&\}/g)].map((match) => match[1]);
    assert.deepEqual(lit, [['Nobody', 'tells', 'you', 'this'][index]], 'exactly the word being spoken is lit');
  });
  const times = lines.map((line) => /^Dialogue: 0,([^,]+),([^,]+),/.exec(line)!.slice(1, 3));
  for (let index = 1; index < times.length; index += 1) assert.equal(times[index][0], times[index - 1][1], 'each line starts when the one before it ends');
  assert.equal(times[0][0], '0:00:00.50');
});

test('during a pause nobody is lit: the group stays up with no word highlighted', () => {
  const chunk = { startSeconds: 0, endSeconds: 3, words: [{ text: 'well', startSeconds: 0, endSeconds: 0.5 }, { text: 'okay', startSeconds: 2, endSeconds: 2.5 }] };
  const spans = wordSpans(chunk);
  assert.deepEqual(spans.map((span) => span.index), [0, null, 1]);
  assert.deepEqual(spans.map((span) => [span.startSeconds, span.endSeconds]), [[0, 0.5], [0.5, 2], [2, 3]]);
});

test('pop captions: upper case, centred, and the group pops in once when it appears (not again for each word)', () => {
  const lines = dialogues(renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'pop'), 'pop'));
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((line) => /\{\\an5\\pos\(540,1180\)/.test(line)), 'every line is centred on the same spot');
  assert.match(lines[0], /\\t\(0,110,\\fscx100\\fscy100\)/);
  assert.ok(lines.slice(1).every((line, index) => !/\\t\(/.test(line) || plain(line) !== plain(lines[index])), 'later lines of the same group do not animate again');
  assert.equal(plain(lines[0]), plain(lines[0]).toUpperCase());
  assert.equal(captionLooks.pop.uppercase, true);
});

test('what a person says cannot turn into formatting', () => {
  const nasty: CaptionSegmentInput[] = [{ startSeconds: 0, endSeconds: 3, text: 'x', words: [{ text: '{\\an9\\pos(0,0)}', startSeconds: 0, endSeconds: 1 }, { text: 'back\\Nslash', startSeconds: 1, endSeconds: 2 }, { text: '}{', startSeconds: 2, endSeconds: 3 }] }];
  for (const style of ['classic', 'highlight', 'pop'] as const) {
    for (const line of dialogues(renderAss(buildCaptionChunks(nasty, 0, 3, style), style))) {
      const text = plain(line);
      assert.ok(!/[{}\\]/.test(text), `${style}: formatting characters survived in "${text}"`);
    }
  }
});

test('a word wider than the picture is set smaller instead of running off its edge', () => {
  const long: CaptionSegmentInput[] = [{ startSeconds: 0, endSeconds: 3, text: 'x', words: [{ text: 'Telecommunications', startSeconds: 0, endSeconds: 1 }] }];
  for (const style of ['classic', 'highlight', 'pop'] as const) {
    const line = dialogues(renderAss(buildCaptionChunks(long, 0, 3, style), style))[0];
    const size = Number(/\\fs(\d+)/.exec(line)?.[1]);
    assert.ok(size > 0 && size < captionLooks[style].fontSize, `${style}: expected a smaller size, got ${size}`);
    assert.ok(size >= 36, 'but never unreadably small');
  }
  const short = dialogues(renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'highlight'), 'highlight'))[0];
  assert.ok(!/\\fs\d/.test(short), 'ordinary words keep the normal size');
});

test('a caption file is written only when something was said inside the clip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-captions-')); const path = join(root, 'clip.ass');
  try {
    assert.equal(await writeAssCaptions(path, SAMPLE, 20, 30, 'highlight'), 0);
    await assert.rejects(readFile(path), /ENOENT/);
    assert.equal(await writeAssCaptions(path, SAMPLE, 0, 6, 'highlight'), 1);
    assert.match(await readFile(path, 'utf8'), /\[Events\]\nFormat: Layer/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The fields of the one style line of a caption file, by name.
const styleOf = (ass: string) => {
  const fields = /^Style: (.*)$/m.exec(ass)![1].split(',');
  return { fontSize: Number(fields[2]), outline: Number(fields[16]), alignment: Number(fields[18]), marginV: Number(fields[21]) };
};

test('the caption file is written for the shape of the clip, and a vertical clip gets exactly the file it always got', () => {
  for (const style of ['classic', 'highlight', 'pop'] as const) {
    const chunks = buildCaptionChunks(SAMPLE, 0, 6, style);
    assert.equal(renderAss(chunks, style, 'vertical'), renderAss(chunks, style), `${style}: vertical is the default`);
    for (const aspect of ['vertical', 'portrait', 'square', 'landscape'] as const) {
      const ass = renderAss(chunks, style, aspect);
      const canvas = captionCanvas[aspect];
      assert.ok(ass.includes(`PlayResX: ${canvas.width}\nPlayResY: ${canvas.height}\n`), `${style} ${aspect}: the file describes the picture it is drawn on`);
      const look = captionLookFor(style, aspect);
      assert.deepEqual(styleOf(ass), { fontSize: look.fontSize, outline: look.outline, alignment: look.alignment, marginV: look.marginV }, `${style} ${aspect}`);
    }
  }
  assert.deepEqual(captionCanvas, { vertical: { width: 1080, height: 1920 }, portrait: { width: 1080, height: 1350 }, square: { width: 1080, height: 1080 }, landscape: { width: 1920, height: 1080 } });
  assert.deepEqual(captionLookFor('classic', 'vertical'), captionLooks.classic, 'the vertical look is the one that was always used');
});

test('captions keep clear of the bottom edge in every shape, a little higher where apps draw over the picture', () => {
  // Where the bottom of the text is, as a share of the picture's height: the margin below the text is MarginV.
  const bottomShare = (aspect: 'vertical' | 'portrait' | 'square' | 'landscape') => 1 - captionLookFor('classic', aspect).marginV / captionCanvas[aspect].height;
  assert.ok(bottomShare('vertical') > 0.69 && bottomShare('vertical') < 0.72, 'vertical: about 70% of the way down, as before');
  for (const aspect of ['portrait', 'square', 'landscape'] as const) {
    assert.ok(bottomShare(aspect) > bottomShare('vertical'), `${aspect}: lower than in a vertical clip, nothing is drawn over it`);
    assert.ok(bottomShare(aspect) < 0.92, `${aspect}: but not at the very edge`);
  }
  // The text is as large as it was on 1080 pixels in every shape that is 1080 wide, and a fifth smaller in the wider landscape one.
  for (const style of ['classic', 'highlight', 'pop'] as const) {
    for (const aspect of ['portrait', 'square'] as const) assert.equal(captionLookFor(style, aspect).fontSize, captionLooks[style].fontSize, `${style} ${aspect}`);
    assert.equal(captionLookFor(style, 'landscape').fontSize, Math.round(captionLooks[style].fontSize * 0.8), `${style} landscape`);
  }
});

test('pop captions are centred on the middle of the picture of each shape, a little below its centre', () => {
  for (const aspect of ['vertical', 'portrait', 'square', 'landscape'] as const) {
    const canvas = captionCanvas[aspect];
    const lines = dialogues(renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'pop'), 'pop', aspect));
    const [, x, y] = /\{\\an5\\pos\((\d+),(\d+)\)/.exec(lines[0])!.map(Number);
    assert.equal(x, canvas.width / 2, `${aspect}: horizontally in the middle`);
    assert.ok(y > canvas.height * 0.5 && y < canvas.height * 0.7, `${aspect}: ${y} is below the middle and above the bottom third`);
    assert.ok(lines.every((line) => line.includes(`\\pos(${x},${y})`)), `${aspect}: every line on the same spot`);
  }
});

test('how much of a word fits depends on how wide the picture is: a long word is set smaller in a narrow shape and keeps its size in a wide one', () => {
  const long: CaptionSegmentInput[] = [{ startSeconds: 0, endSeconds: 3, text: 'x', words: [{ text: 'Telecommunications', startSeconds: 0, endSeconds: 1 }] }];
  const sizeIn = (aspect: 'vertical' | 'portrait' | 'square' | 'landscape') => /\\fs(\d+)/.exec(dialogues(renderAss(buildCaptionChunks(long, 0, 3, 'classic'), 'classic', aspect))[0])?.[1];
  assert.ok(Number(sizeIn('vertical')) < captionLooks.classic.fontSize);
  assert.equal(sizeIn('square'), sizeIn('vertical'), 'the same width, the same room');
  assert.equal(sizeIn('landscape'), undefined, 'a landscape picture has room for it at the normal size');
});

test('a caption file for another shape is written the same way and holds the same groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-captions-shape-')); const path = join(root, 'clip.ass');
  try {
    assert.equal(await writeAssCaptions(path, SAMPLE, 0, 6, 'highlight', 'square'), 1);
    const ass = await readFile(path, 'utf8');
    assert.match(ass, /PlayResX: 1080\nPlayResY: 1080/);
    assert.equal(dialogues(ass).length, dialogues(renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'highlight'), 'highlight')).length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------------------
// What a person can choose about the look: the colour of the spoken word, where the captions go and how large they are.

const LONG: CaptionSegmentInput[] = [{ startSeconds: 0, endSeconds: 40, text: 'x', words: [
  ...spoken('When the music stops, everyone must sit down quickly because nobody wants to lose.', 0.4, 0.3),
  ...spoken('International businesses understand responsibility differently than individuals do.', 12, 0.35),
  ...spoken('Is this the best part of all? Yes it is, and here is the reason why it matters.', 24, 0.3)] }];
const choose = (choices: Partial<CaptionChoices>): CaptionChoices => ({ ...defaultCaptionChoices, ...choices });

test('with nothing chosen the captions look exactly as they always did: gold, lower, the usual size', () => {
  assert.deepEqual(defaultCaptionChoices, { accent: 'gold', position: 'lower', size: 'medium' });
  assert.equal(accentColours.gold, '&H0000D7FF&', 'the colour of a lit word has not changed');
  assert.equal(sizeScales.medium, 1);
  for (const style of ['classic', 'highlight', 'pop'] as const) {
    assert.equal(chunkRulesFor(style), chunkRules[style], `${style}: the usual size groups words by the usual rules`);
    assert.equal(chunkRulesFor(style, 'medium'), chunkRules[style]);
    const chunks = buildCaptionChunks(LONG, 0, 40, style);
    assert.deepEqual(buildCaptionChunks(LONG, 0, 40, style, 'medium'), chunks, `${style}: the same groups`);
    for (const aspect of ['vertical', 'portrait', 'square', 'landscape'] as const) {
      assert.equal(renderAss(chunks, style, aspect), renderAss(chunks, style, aspect, defaultCaptionChoices), `${style} ${aspect}`);
      assert.equal(renderAss(chunks, style, aspect), renderAss(chunks, style, aspect, choose({})), `${style} ${aspect}`);
    }
  }
  // The style lines of the vertical files, written out: these are the numbers the live service has been using.
  const styleLine = (style: 'classic' | 'highlight' | 'pop') => /^Style: .*$/m.exec(renderAss(buildCaptionChunks(SAMPLE, 0, 6, style), style))![0];
  assert.equal(styleLine('classic'), 'Style: Caption,Inter ExtraBold,92,&H00FFFFFF&,&H000000FF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,8,0,2,80,80,560,1');
  assert.equal(styleLine('highlight'), 'Style: Caption,Inter ExtraBold,96,&H00FFFFFF&,&H000000FF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,8,0,2,80,80,560,1');
  assert.equal(styleLine('pop'), 'Style: Caption,Inter ExtraBold,124,&H00FFFFFF&,&H000000FF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,10,0,5,80,80,0,1');
});

test('the colour of the spoken word is the one chosen, in the styles that light a word, and nothing else changes', () => {
  assert.deepEqual([...captionAccents], ['gold', 'green', 'cyan', 'pink', 'red']);
  const colours = captionAccents.map((accent) => accentColours[accent]);
  for (const colour of colours) assert.match(colour, /^&H00[0-9A-F]{6}&$/, `${colour} is not a colour a caption file can hold`);
  assert.equal(new Set(colours).size, captionAccents.length, 'every accent is a different colour');
  for (const style of ['highlight', 'pop'] as const) {
    for (const accent of captionAccents) {
      const chunks = buildCaptionChunks(SAMPLE, 0, 6, style);
      const ass = renderAss(chunks, style, 'vertical', choose({ accent }));
      const lit = [...ass.matchAll(/\{\\1c(&H[0-9A-F]{8}&|&H[0-9A-F]{6}&)\}[^{]+\{\\1c&H00FFFFFF&\}/g)].map((match) => match[1]);
      assert.ok(lit.length >= 3, `${style} ${accent}: the spoken words are lit`);
      assert.ok(lit.every((colour) => colour === accentColours[accent]), `${style} ${accent}: lit in ${[...new Set(lit)].join(', ')}`);
      // Only the colour differs from the default file.
      assert.equal(ass.split(accentColours[accent]).join(accentColours.gold), renderAss(chunks, style, 'vertical'), `${style} ${accent}: nothing but the colour changed`);
    }
  }
  // Plain phrases have no lit word, so there is nothing for a colour to apply to.
  const classic = buildCaptionChunks(SAMPLE, 0, 6, 'classic');
  assert.equal(renderAss(classic, 'classic', 'vertical', choose({ accent: 'pink' })), renderAss(classic, 'classic'));
});

test('the captions go where they were asked to, in every shape: the lower part, the middle, or the top', () => {
  const styleOfFile = (style: 'classic' | 'highlight', aspect: 'vertical' | 'portrait' | 'square' | 'landscape', position: 'lower' | 'middle' | 'top') =>
    styleOf(renderAss(buildCaptionChunks(SAMPLE, 0, 6, style), style, aspect, choose({ position })));
  for (const style of ['classic', 'highlight'] as const) {
    for (const aspect of ['vertical', 'portrait', 'square', 'landscape'] as const) {
      const height = captionCanvas[aspect].height;
      const lower = styleOfFile(style, aspect, 'lower'); const middle = styleOfFile(style, aspect, 'middle'); const top = styleOfFile(style, aspect, 'top');
      assert.equal(lower.alignment, 2, `${style} ${aspect}: the lower part is set from the bottom edge`);
      assert.equal(middle.alignment, 5, `${style} ${aspect}: the middle is centred on the picture`);
      assert.equal(top.alignment, 8, `${style} ${aspect}: the top is set from the top edge`);
      assert.equal(lower.marginV, captionLookFor(style, aspect).marginV, `${style} ${aspect}: the lower part is where it always was`);
      assert.ok(top.marginV > 0.07 * height && top.marginV < 0.2 * height, `${style} ${aspect}: the top margin is ${top.marginV} of ${height}`);
      // Where the text starts (top) or ends (lower), as a share of the height: the top is clearly above the lower part.
      assert.ok(top.marginV / height < 1 - lower.marginV / height - 0.4, `${style} ${aspect}: top and lower are far apart`);
    }
  }
  // A vertical clip keeps the top of the picture free of what the apps draw there; the other shapes are not drawn over.
  const topMargin = (aspect: 'vertical' | 'portrait' | 'square' | 'landscape') => captionLookFor('classic', aspect, choose({ position: 'top' })).marginV / captionCanvas[aspect].height;
  assert.ok(topMargin('vertical') >= 0.14, 'vertical: clear of the top of the apps');
  for (const aspect of ['portrait', 'square', 'landscape'] as const) assert.ok(topMargin(aspect) < topMargin('vertical'), `${aspect}: nothing is drawn over the top, so the text can be closer to the edge`);
  // The big pop-in words are placed by the middle of the block.
  for (const aspect of ['vertical', 'portrait', 'square', 'landscape'] as const) {
    const height = captionCanvas[aspect].height;
    const centreY = (position: 'lower' | 'middle' | 'top') => captionLookFor('pop', aspect, choose({ position })).centre!.y;
    assert.equal(centreY('lower'), captionLookFor('pop', aspect).centre!.y, `pop ${aspect}: the lower part is where it always was`);
    assert.equal(centreY('middle'), height / 2, `pop ${aspect}: the middle is the middle`);
    assert.ok(centreY('top') < centreY('middle') && centreY('middle') < centreY('lower'), `pop ${aspect}: top above middle above lower`);
    assert.ok(centreY('top') > 0.1 * height && centreY('top') < 0.3 * height, `pop ${aspect}: the top is in the upper part (${centreY('top')} of ${height})`);
    const lines = dialogues(renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'pop'), 'pop', aspect, choose({ position: 'top' })));
    assert.ok(lines.every((line) => line.includes(`\\an5\\pos(${captionCanvas[aspect].width / 2},${centreY('top')})`)), `pop ${aspect}: every line is on the chosen spot`);
  }
  assert.deepEqual([...captionPositions], ['lower', 'middle', 'top']);
});

test('the size of the captions is the size chosen, in every shape, and the lines stay about two lines long', () => {
  assert.deepEqual([...captionSizes], ['small', 'medium', 'large']);
  assert.ok(sizeScales.small < sizeScales.medium && sizeScales.medium < sizeScales.large);
  for (const style of ['classic', 'highlight', 'pop'] as const) {
    for (const aspect of ['vertical', 'portrait', 'square', 'landscape'] as const) {
      const small = captionLookFor(style, aspect, choose({ size: 'small' })); const medium = captionLookFor(style, aspect); const large = captionLookFor(style, aspect, choose({ size: 'large' }));
      assert.ok(small.fontSize < medium.fontSize && medium.fontSize < large.fontSize, `${style} ${aspect}: ${small.fontSize} < ${medium.fontSize} < ${large.fontSize}`);
      assert.ok(small.outline <= medium.outline && medium.outline < large.outline, `${style} ${aspect}: the outline grows with the letters`);
      assert.ok(Math.abs(large.fontSize / medium.fontSize - sizeScales.large) < 0.02, `${style} ${aspect}: large is ${sizeScales.large} times the usual size`);
      assert.ok(Math.abs(small.fontSize / medium.fontSize - sizeScales.small) < 0.02, `${style} ${aspect}: small is ${sizeScales.small} times the usual size`);
      assert.equal(styleOf(renderAss(buildCaptionChunks(SAMPLE, 0, 6, style, 'large'), style, aspect, choose({ size: 'large' }))).fontSize, large.fontSize, `${style} ${aspect}: the file says so`);
    }
  }
  // Letters that are larger fit fewer words on a line, so fewer are shown at once; smaller ones fit more. About two lines either way.
  for (const style of ['classic', 'highlight', 'pop'] as const) {
    assert.ok(chunkRulesFor(style, 'large').maxChars < chunkRules[style].maxChars && chunkRules[style].maxChars < chunkRulesFor(style, 'small').maxChars, `${style}: the longer the letters, the shorter the group`);
    assert.equal(chunkRulesFor(style, 'large').maxWords, chunkRules[style].maxWords, `${style}: only the length changes, not how many words`);
    const groups = (size: 'small' | 'medium' | 'large') => buildCaptionChunks(LONG, 0, 40, style, size).length;
    assert.ok(groups('large') >= groups('medium') && groups('medium') >= groups('small'), `${style}: larger letters mean more, shorter groups (${groups('small')}, ${groups('medium')}, ${groups('large')})`);
    for (const size of captionSizes) {
      const rules = chunkRulesFor(style, size);
      const chunks = buildCaptionChunks(LONG, 0, 40, style, size);
      const spokenWords = chunks.flatMap((chunk) => chunk.words.map((word) => word.text));
      assert.deepEqual(spokenWords, clipWords(LONG, 0, 40).map((word) => word.text), `${style} ${size}: no word is lost or repeated`);
      for (const chunk of chunks) {
        const chars = chunk.words.map((word) => word.text).join(' ').length;
        assert.ok(chunk.words.length === 1 || chars <= rules.maxChars, `${style} ${size}: "${chunk.words.map((word) => word.text).join(' ')}" is longer than the rules allow`);
      }
      // A group is shown on at most two lines: its width in letters of this size, over the width of the picture, is at most two.
      const look = captionLookFor(style, 'vertical', choose({ size }));
      for (const chunk of chunks) {
        if (chunk.words.length === 1) continue;
        const text = chunk.words.map((word) => (look.uppercase ? word.text.toUpperCase() : word.text)).join(' ');
        const em = [...text].reduce((total, letter) => total + (/[\p{Lu}0-9]/u.test(letter) ? 0.72 : letter === ' ' ? 0.3 : 0.58), 0);
        assert.ok(em * look.fontSize <= 2 * (1080 - 2 * 80), `${style} ${size}: "${text}" would need more than two lines`);
      }
    }
  }
  // A word wider than the picture is still set smaller than the chosen size, and an ordinary word keeps the chosen size.
  const long: CaptionSegmentInput[] = [{ startSeconds: 0, endSeconds: 3, text: 'x', words: [{ text: 'Telecommunications', startSeconds: 0, endSeconds: 1 }] }];
  for (const size of captionSizes) {
    const line = dialogues(renderAss(buildCaptionChunks(long, 0, 3, 'classic', size), 'classic', 'vertical', choose({ size })))[0];
    const chosen = captionLookFor('classic', 'vertical', choose({ size })).fontSize;
    const fitted = /\\fs(\d+)/.exec(line)?.[1];
    // The word is 18 letters, about 10.6 times as wide as the letters are tall, and the picture leaves 900 pixels for a line.
    if (10.58 * chosen > 900) assert.ok(Number(fitted) >= 36 && Number(fitted) < chosen, `${size}: too wide at ${chosen}, set at ${fitted}`);
    else assert.equal(fitted, undefined, `${size}: the word fits at ${chosen}, so it keeps that size`);
    assert.ok(!/\\fs\d/.test(dialogues(renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'highlight', size), 'highlight', 'vertical', choose({ size })))[0]), `${size}: an ordinary word keeps the chosen size`);
  }
});

test('a caption file is written with the look that was chosen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-captions-look-')); const path = join(root, 'clip.ass');
  try {
    // Larger letters fit fewer words on a line, so the four words are shown in more than one group.
    assert.equal(await writeAssCaptions(path, SAMPLE, 0, 6, 'highlight', 'vertical', { accent: 'green', position: 'top', size: 'large' }), buildCaptionChunks(SAMPLE, 0, 6, 'highlight', 'large').length);
    const ass = await readFile(path, 'utf8');
    assert.deepEqual(styleOf(ass), { fontSize: 120, outline: 10, alignment: 8, marginV: 300 });
    assert.equal([...ass.matchAll(/\\1c&H0050F032&/g)].length, 4, 'one lit word per spoken word, in green');
    assert.equal(await writeAssCaptions(path, SAMPLE, 0, 6, 'highlight'), 1);
    assert.equal(await readFile(path, 'utf8'), renderAss(buildCaptionChunks(SAMPLE, 0, 6, 'highlight'), 'highlight'), 'without a look the file is the one it always was');
  } finally { await rm(root, { recursive: true, force: true }); }
});
