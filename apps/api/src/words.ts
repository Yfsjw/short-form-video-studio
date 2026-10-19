import type { TranscriptWord } from './domain.js';

/** The shortest time a word is given on screen, in seconds. */
const MIN_WORD_SECONDS = 0.04;
/** whisper.cpp's special tokens: "[_BEG_]", "[_TT_150]" (time stamps), "<|endoftext|>". They are not speech. */
const SPECIAL_TOKEN = /^(?:\[_[A-Za-z0-9_]+\]|<\|[^|>]*\|>)$/;

/** One piece of text the speech recognition produced (a word, part of a word, or punctuation) with the times it reported, if any. */
export interface RawToken { text: string; startSeconds?: number; endSeconds?: number; }

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

export function splitWords(text: string): string[] { return text.split(/\s+/).filter(Boolean); }

/**
 * The words of `text` spread over the given time in proportion to their length. This is a guess, not a measurement: it is what is
 * used for a transcript that has no word timing (made before words were stored, or by an engine that does not report them), so a
 * caption that follows the speech word by word is a little off but never missing.
 */
export function distributeWords(text: string, startSeconds: number, endSeconds: number): TranscriptWord[] {
  const pieces = splitWords(text);
  if (!pieces.length) return [];
  const duration = Math.max(0, endSeconds - startSeconds);
  const weights = pieces.map((piece) => piece.length + 1); // +1: every word is followed by a small gap
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = startSeconds;
  return pieces.map((piece, index) => {
    const start = cursor;
    cursor += (duration * weights[index]) / total;
    return { text: piece, startSeconds: start, endSeconds: index === pieces.length - 1 ? Math.max(start, endSeconds) : cursor };
  });
}

/**
 * Joins the pieces whisper.cpp reports for one segment into words (a piece that starts with a space starts a new word, the others
 * continue the word before them, so "don" "'t" and "." end up in the right words) and tidies their times: they never go backwards,
 * every word lasts a moment, and times outside the segment are pulled in.
 *
 * Returns undefined when the times cannot be trusted (nothing usable, or they collapsed into a few instants / a small part of the
 * segment, which is what a failed alignment looks like). The caller then falls back to {@link distributeWords}.
 */
export function wordsFromTokens(tokens: RawToken[], segmentStart: number, segmentEnd: number): TranscriptWord[] | undefined {
  const drafts: Array<{ text: string; start?: number; end?: number }> = [];
  let startNew = true;
  for (const token of tokens) {
    const clean = token.text.trim();
    if (!clean) { startNew = true; continue; }
    if (SPECIAL_TOKEN.test(clean)) continue;
    const begins = startNew || /^\s/.test(token.text) || !drafts.length;
    startNew = false;
    if (begins) { drafts.push({ text: clean, start: token.startSeconds, end: token.endSeconds }); continue; }
    const word = drafts[drafts.length - 1];
    word.text += clean;
    if (word.start === undefined) word.start = token.startSeconds;
    if (token.endSeconds !== undefined) word.end = token.endSeconds;
  }
  if (!drafts.length) return undefined;
  if (drafts.every((draft) => draft.start === undefined && draft.end === undefined)) return undefined; // no times at all

  const low = Math.min(segmentStart, segmentEnd); const high = Math.max(segmentStart, segmentEnd);
  const words: TranscriptWord[] = [];
  let previousStart = low; let previousEnd = low;
  for (const draft of drafts) {
    const start = Math.max(clamp(draft.start ?? previousEnd, low, high), previousStart); // starts never go backwards
    const end = Math.max(clamp(draft.end ?? start, low, high), start);
    words.push({ text: draft.text, startSeconds: start, endSeconds: end });
    previousStart = start; previousEnd = end;
  }
  // A word has ended by the time the next one starts (the start of the next word is the more reliable of the two). A word that lasts
  // no time at all is given a moment, which pushes the next word's start back when it would otherwise overlap.
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]; const next = words[index + 1];
    if (next && word.endSeconds > next.startSeconds) word.endSeconds = next.startSeconds;
    if (word.endSeconds - word.startSeconds < MIN_WORD_SECONDS) {
      word.endSeconds = word.startSeconds + MIN_WORD_SECONDS;
      if (next && next.startSeconds < word.endSeconds) { next.startSeconds = word.endSeconds; next.endSeconds = Math.max(next.endSeconds, next.startSeconds); }
    }
  }

  // A failed alignment gives many words the same time, or squeezes all of them into a corner of the segment.
  if (words.length >= 4) {
    const distinctStarts = new Set(words.map((word) => word.startSeconds.toFixed(2))).size;
    if (distinctStarts < words.length * 0.5) return undefined;
  }
  const segmentLength = high - low;
  if (segmentLength >= 2) {
    const covered = words[words.length - 1].endSeconds - words[0].startSeconds;
    if (covered < segmentLength * 0.25) return undefined;
  }
  return words;
}

/** Reads words back from the database; anything that is not a usable list of words counts as "no words stored". */
export function parseStoredWords(json: string | null | undefined): TranscriptWord[] | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const words: TranscriptWord[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return undefined;
      const { text, startSeconds, endSeconds } = item as Record<string, unknown>;
      if (typeof text !== 'string' || !text || typeof startSeconds !== 'number' || typeof endSeconds !== 'number' || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return undefined;
      words.push({ text, startSeconds, endSeconds: Math.max(startSeconds, endSeconds) });
    }
    return words.length ? words : undefined;
  } catch { return undefined; }
}
