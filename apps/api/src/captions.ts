import { writeFile } from 'node:fs/promises';
import type { AspectChoice, CaptionStyle, TranscriptWord } from './domain.js';
import { distributeWords } from './words.js';

export interface CaptionSegmentInput {
  startSeconds: number;
  endSeconds: number;
  text: string;
  /** The words of the segment with their own timing, when known. Without them the words are spread over the segment by length. */
  words?: TranscriptWord[];
}

/** A word as it is shown: times in seconds counted from the start of the clip. */
export interface CaptionWord { text: string; startSeconds: number; endSeconds: number; }
/** The words that are on screen together, and the time they are there. */
export interface CaptionChunk { startSeconds: number; endSeconds: number; words: CaptionWord[]; }
export type VisibleCaptionStyle = Exclude<CaptionStyle, 'none'>;

/**
 * How words are grouped into what is on screen at once. These are plain rules, not a model: a group ends at the end of a sentence,
 * after a comma once it has some length, at a pause, or when it would no longer fit; a group never shows more than `maxWords` words
 * or `maxChars` characters (a 9:16 picture only has room for about two short lines).
 */
interface ChunkRules { maxChars: number; maxWords: number; maxGapSeconds: number; softBreakChars: number; holdSeconds: number; }
export const chunkRules: Record<VisibleCaptionStyle, ChunkRules> = {
  classic: { maxChars: 30, maxWords: 7, maxGapSeconds: 0.8, softBreakChars: 14, holdSeconds: 0.25 },
  highlight: { maxChars: 22, maxWords: 4, maxGapSeconds: 0.6, softBreakChars: 10, holdSeconds: 0.25 },
  pop: { maxChars: 16, maxWords: 3, maxGapSeconds: 0.5, softBreakChars: 8, holdSeconds: 0.12 },
};

/** A group stays up at least this long, however briefly its words were spoken. */
const MIN_CHUNK_SECONDS = 0.3;
const SENTENCE_END = /[.!?…]["')\]”’]*$/;
const SOFT_END = /[,;:—–]["')\]”’]*$/;

/**
 * The words of the segments that fall inside the clip, with times counted from the start of the clip. A word that is cut by the
 * start or end of the clip is kept only when most of it is inside (a sliver of a word would flash by).
 */
export function clipWords(segments: CaptionSegmentInput[], clipStartSeconds: number, clipEndSeconds: number): CaptionWord[] {
  const words: CaptionWord[] = [];
  const ordered = [...segments].sort((a, b) => a.startSeconds - b.startSeconds);
  for (const segment of ordered) {
    if (!(segment.endSeconds > clipStartSeconds && segment.startSeconds < clipEndSeconds)) continue;
    const spoken = segment.words?.length ? segment.words : distributeWords(segment.text, segment.startSeconds, segment.endSeconds);
    for (const word of spoken) {
      const text = word.text.trim();
      if (!text) continue;
      const start = Math.max(word.startSeconds, clipStartSeconds); const end = Math.min(word.endSeconds, clipEndSeconds);
      if (end <= start || end - start < 0.5 * (word.endSeconds - word.startSeconds)) continue;
      words.push({ text, startSeconds: start - clipStartSeconds, endSeconds: end - clipStartSeconds });
    }
  }
  return words;
}

/** Words a line should not end on: they belong with what comes next ("about growing a | channel" reads better as "about growing | a channel"). */
const WEAK_ENDERS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'and', 'but', 'or', 'so', 'if', 'as', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'is', 'are', 'was', 'be', 'i', 'we', 'you', 'they', 'it']);
const bareWord = (text: string) => text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const endsSentence = (chunk: CaptionChunk) => SENTENCE_END.test(chunk.words[chunk.words.length - 1].text);
const charsOf = (words: CaptionWord[]) => words.reduce((total, word) => total + word.text.length, 0) + Math.max(0, words.length - 1);
const chunkOf = (words: CaptionWord[]): CaptionChunk => ({ startSeconds: words[0].startSeconds, endSeconds: words[words.length - 1].endSeconds, words });

export function chunkWords(words: CaptionWord[], rules: ChunkRules): CaptionChunk[] {
  const chunks: CaptionChunk[] = [];
  let current: CaptionWord[] = [];
  const flush = () => { if (current.length) chunks.push(chunkOf(current)); current = []; };
  for (const word of words) {
    if (current.length) {
      const previous = current[current.length - 1];
      const paused = word.startSeconds - previous.endSeconds > rules.maxGapSeconds;
      const full = charsOf(current) + 1 + word.text.length > rules.maxChars || current.length >= rules.maxWords;
      if (paused) flush();
      else if (full) {
        // The group is full. If it would end on a word that belongs with the next one, that word starts the next group instead.
        const carried = current.length > 1 && WEAK_ENDERS.has(bareWord(previous.text)) && !SENTENCE_END.test(previous.text) && !SOFT_END.test(previous.text) ? current.pop() : undefined;
        flush();
        if (carried) current.push(carried);
      }
    }
    current.push(word);
    if (SENTENCE_END.test(word.text) || (SOFT_END.test(word.text) && charsOf(current) >= rules.softBreakChars)) flush();
  }
  flush();
  // A sentence should not end with a group of one word when the group before it (same sentence) can spare a word.
  for (let index = 1; index < chunks.length; index += 1) {
    const last = chunks[index]; const before = chunks[index - 1];
    if (last.words.length !== 1 || endsSentence(before) || before.words.length < 3) continue;
    if (last.startSeconds - before.endSeconds > rules.maxGapSeconds) continue;
    const spare = before.words[before.words.length - 1];
    if (charsOf([spare, ...last.words]) > rules.maxChars) continue;
    if (WEAK_ENDERS.has(bareWord(before.words[before.words.length - 2].text))) continue; // that would leave the group before it ending on a word that belongs with the next
    chunks[index - 1] = chunkOf(before.words.slice(0, -1));
    chunks[index] = chunkOf([spare, ...last.words]);
  }
  return chunks;
}

/** What is on screen when: each group from its first word to a moment after its last, but never into the next group. */
export function buildCaptionChunks(segments: CaptionSegmentInput[], clipStartSeconds: number, clipEndSeconds: number, style: VisibleCaptionStyle): CaptionChunk[] {
  const rules = chunkRules[style];
  const chunks = chunkWords(clipWords(segments, clipStartSeconds, clipEndSeconds), rules);
  const clipLength = clipEndSeconds - clipStartSeconds;
  return chunks
    .map((chunk, index) => {
      const wanted = Math.max(chunk.endSeconds + rules.holdSeconds, chunk.startSeconds + MIN_CHUNK_SECONDS);
      const limit = chunks[index + 1]?.startSeconds ?? clipLength;
      return { ...chunk, endSeconds: Math.min(wanted, limit, clipLength) };
    })
    .filter((chunk) => chunk.endSeconds > chunk.startSeconds);
}

/** Builds a UTF-8 SRT file of short phrases with clip-relative timestamps. Returns how many captions it holds. */
export async function writeSrtCaptions(path: string, segments: CaptionSegmentInput[], clipStartSeconds: number, clipEndSeconds: number) {
  const chunks = buildCaptionChunks(segments, clipStartSeconds, clipEndSeconds, 'classic');
  const body = chunks.map((chunk, index) => `${index + 1}\n${formatSrtTime(chunk.startSeconds)} --> ${formatSrtTime(chunk.endSeconds)}\n${chunk.words.map((word) => word.text).join(' ')}\n`).join('\n');
  await writeFile(path, body, 'utf8');
  return chunks.length;
}

export function formatSrtTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Styled captions (ASS), drawn by FFmpeg's libass with the font that ships with the program.

/** The name the font identifies itself by; the file is in assets/fonts. */
export const CAPTION_FONT = 'Inter ExtraBold';
/**
 * The picture the sizes below are written for, per shape of clip; libass scales the captions to the real size of the picture. Vertical is the
 * shape the captions were first made for.
 */
export const captionCanvas: Record<AspectChoice, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 }, portrait: { width: 1080, height: 1350 }, square: { width: 1080, height: 1080 }, landscape: { width: 1920, height: 1080 },
};
const PLAY_WIDTH = captionCanvas.vertical.width;
const WHITE = '&H00FFFFFF&'; const HIGHLIGHT = '&H0000D7FF&'; // colours are blue-green-red: this is gold

interface Look {
  fontSize: number; outline: number; shadow: number; alignment: number; marginV: number;
  uppercase: boolean; highlightWord: boolean; popIn: boolean; centre?: { x: number; y: number };
}
/** The looks for a vertical clip. `captionLookFor` moves them to the other shapes. */
export const captionLooks: Record<VisibleCaptionStyle, Look> = {
  // Bottom of the text about 70% of the way down: clear of the buttons and the title the apps draw over the bottom of a short video.
  classic: { fontSize: 92, outline: 8, shadow: 0, alignment: 2, marginV: 560, uppercase: false, highlightWord: false, popIn: false },
  highlight: { fontSize: 96, outline: 8, shadow: 0, alignment: 2, marginV: 560, uppercase: false, highlightWord: true, popIn: false },
  pop: { fontSize: 124, outline: 10, shadow: 0, alignment: 5, marginV: 0, uppercase: true, highlightWord: true, popIn: true, centre: { x: PLAY_WIDTH / 2, y: 1180 } },
};

/**
 * Where captions go and how big they are in each shape (the vertical values are what the captions always had). Vertical: the bottom of the text is about
 * 70% of the way down, clear of what the apps draw over a short video. The other shapes are not covered like that, so their text sits lower, but still off
 * the edge. `scale` is the size of the text against the vertical shape: a landscape picture is wider, not taller, so its text is a little smaller.
 */
const placements: Record<AspectChoice, { marginV: number; popY: number; scale: number }> = {
  vertical: { marginV: 560, popY: 1180, scale: 1 },
  portrait: { marginV: 200, popY: 800, scale: 1 },
  square: { marginV: 150, popY: 640, scale: 1 },
  landscape: { marginV: 110, popY: 640, scale: 0.8 },
};

/** The look of a style in a shape of clip. */
export function captionLookFor(style: VisibleCaptionStyle, aspect: AspectChoice): Look {
  const look = captionLooks[style];
  if (aspect === 'vertical') return look;
  const place = placements[aspect]; const canvas = captionCanvas[aspect];
  const scaled = (value: number) => Math.round(value * place.scale);
  return {
    ...look, fontSize: scaled(look.fontSize), outline: scaled(look.outline),
    marginV: look.centre ? 0 : place.marginV,
    ...(look.centre ? { centre: { x: canvas.width / 2, y: place.popY } } : {}),
  };
}

/** The width a line may have: the picture less the side margins (and a little room for the outline). */
const safeLineWidth = (aspect: AspectChoice) => captionCanvas[aspect].width - 2 * 80 - 20;
/** About how wide a word is, in multiples of the font size (capitals and digits are wider than other letters in this font). */
function widthInEm(word: string) { let total = 0; for (const letter of word) total += /[\p{Lu}0-9]/u.test(letter) ? 0.72 : 0.58; return total; }

/** Characters that mean something in a caption file are replaced, so nothing a person says can turn into formatting. */
function assText(text: string) { return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\\/g, '/').replace(/\s+/g, ' ').trim(); }

export function formatAssTime(seconds: number) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  return `${hours}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(centiseconds % 100, 2)}`;
}

/** Within a group: who is being spoken from when to when. `index` is the position of the word, or null while nobody is speaking (a pause). */
export function wordSpans(chunk: CaptionChunk): Array<{ index: number | null; startSeconds: number; endSeconds: number }> {
  const spans: Array<{ index: number | null; startSeconds: number; endSeconds: number }> = [];
  let cursor = chunk.startSeconds;
  chunk.words.forEach((word, index) => {
    const start = Math.max(word.startSeconds, cursor);
    if (start - cursor > 0.01) spans.push({ index: null, startSeconds: cursor, endSeconds: start });
    const next = chunk.words[index + 1];
    // A word stays lit until the next one starts, unless there is a pause in between.
    let end = next ? next.startSeconds : chunk.endSeconds;
    if (next && next.startSeconds - word.endSeconds > 0.3) end = Math.max(word.endSeconds, start + 0.05);
    end = Math.min(Math.max(end, start + 0.02), chunk.endSeconds);
    if (end > start) { spans.push({ index, startSeconds: start, endSeconds: end }); cursor = end; }
  });
  if (chunk.endSeconds - cursor > 0.02) spans.push({ index: null, startSeconds: cursor, endSeconds: chunk.endSeconds });
  return spans;
}

export function renderAss(chunks: CaptionChunk[], style: VisibleCaptionStyle, aspect: AspectChoice = 'vertical'): string {
  const look = captionLookFor(style, aspect);
  const canvas = captionCanvas[aspect];
  const header = `[Script Info]
Title: Captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${canvas.width}
PlayResY: ${canvas.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${CAPTION_FONT},${look.fontSize},${WHITE},&H000000FF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,${look.outline},${look.shadow},${look.alignment},80,80,${look.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  const position = look.centre ? `\\an5\\pos(${look.centre.x},${look.centre.y})` : '';
  for (const chunk of chunks) {
    const words = chunk.words.map((word) => assText(look.uppercase ? word.text.toUpperCase() : word.text));
    // Lines are broken between words, so a word wider than the picture would be cut off at its edge: such a group is set smaller.
    const fitSize = Math.floor(safeLineWidth(aspect) / Math.max(...words.map(widthInEm)));
    const size = fitSize < look.fontSize ? Math.max(36, fitSize) : null;
    const spans = look.highlightWord ? wordSpans(chunk) : [{ index: null, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds }];
    spans.forEach((span, spanNumber) => {
      const text = words.map((word, index) => (index === span.index ? `{\\1c${HIGHLIGHT}}${word}{\\1c${WHITE}}` : word)).join(' ');
      // The group pops in when it appears (and only then: the later events of the same group continue where it left off).
      const pop = look.popIn && spanNumber === 0 ? '\\fscx82\\fscy82\\t(0,110,\\fscx100\\fscy100)' : '';
      const tags = `${position}${size ? `\\fs${size}` : ''}${pop}`;
      lines.push(`Dialogue: 0,${formatAssTime(span.startSeconds)},${formatAssTime(span.endSeconds)},Caption,,0,0,0,,${tags ? `{${tags}}` : ''}${text}`);
    });
  }
  return `${header}${lines.join('\n')}\n`;
}

/** Writes the styled caption file FFmpeg burns into the clip. Returns how many caption groups it holds (0: nothing was said, no file is written). */
export async function writeAssCaptions(path: string, segments: CaptionSegmentInput[], clipStartSeconds: number, clipEndSeconds: number, style: VisibleCaptionStyle, aspect: AspectChoice = 'vertical') {
  const chunks = buildCaptionChunks(segments, clipStartSeconds, clipEndSeconds, style);
  if (!chunks.length) return 0;
  await writeFile(path, renderAss(chunks, style, aspect), 'utf8');
  return chunks.length;
}

function pad(value: number, width: number) { return String(value).padStart(width, '0'); }
