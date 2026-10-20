import type { TranscriptWord } from './domain.js';

interface SpokenSegment { startSeconds: number; endSeconds: number; words?: TranscriptWord[]; }
/** A stretch of speech with its time: a word when the transcript has word timing, otherwise a whole segment. */
interface Unit { startSeconds: number; endSeconds: number; }

/** How much room is given around the speech of a clip, in seconds. */
export const leadInSeconds = 0.25;
export const tailSeconds = 0.4;
/** Never closer than this to the neighbouring speech, so no sliver of the word before or after sneaks into the clip. */
const SAFETY_SECONDS = 0.02;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The range to cut for a passage: from a little before its first word to a little after its last, so neither is clipped, but never
 * into the words just before or after it (a clip that begins with the end of someone's previous word sounds broken). Uses the timing
 * of every word when the transcript has it and the timing of the segments when it does not.
 */
export function paddedRange(startSeconds: number, endSeconds: number, segments: SpokenSegment[], durationSeconds: number): { startSeconds: number; endSeconds: number } {
  const units = segments.flatMap<Unit>((segment) => (segment.words?.length ? segment.words : [segment])).filter((unit) => unit.endSeconds > unit.startSeconds).sort((a, b) => a.startSeconds - b.startSeconds);
  const firstIndex = units.findIndex((unit) => unit.startSeconds >= startSeconds - 0.05);
  let lastIndex = -1;
  units.forEach((unit, index) => { if (unit.endSeconds <= endSeconds + 0.05) lastIndex = index; });
  const total = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
  const clampedStart = Math.max(0, startSeconds); const clampedEnd = Math.min(total, endSeconds);
  if (firstIndex < 0 || lastIndex < firstIndex) return { startSeconds: round(clampedStart), endSeconds: round(clampedEnd) };

  const first = units[firstIndex]; const last = units[lastIndex];
  const before = units[firstIndex - 1]; const after = units[lastIndex + 1];
  const earliest = Math.max(0, first.startSeconds - leadInSeconds, before ? before.endSeconds + SAFETY_SECONDS : 0);
  const latest = Math.min(total, last.endSeconds + tailSeconds, after ? after.startSeconds - SAFETY_SECONDS : total);
  // The range never begins after the first word or ends before the last one, whatever the neighbours' timing says.
  return { startSeconds: round(Math.max(0, Math.min(earliest, first.startSeconds))), endSeconds: round(Math.min(total, Math.max(latest, last.endSeconds))) };
}
