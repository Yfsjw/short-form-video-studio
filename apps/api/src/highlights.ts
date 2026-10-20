import type { HighlightCandidate, HighlightSignals, TranscriptSegment } from './domain.js';
import { HOOK_START, LEADING_FILLER, suggestTitle } from './titles.js';

export interface HighlightDetector { detect(input: HighlightDetectionInput): Array<Omit<HighlightCandidate, 'id' | 'jobId' | 'candidateIndex' | 'createdAt'>>; }
export interface HighlightDetectionInput { segments: TranscriptSegment[]; durationSeconds: number; metadata: { width: number | null; height: number | null }; options: HighlightOptions; }
export interface HighlightOptions { minDurationSeconds: number; maxDurationSeconds: number; maxCandidates: number; overlapThreshold: number; weights: Record<string, number>; }

const emphaticWords = /\b(amazing|best|breakthrough|critical|essential|powerful|unbelievable|surprising|incredible|must|never|always|huge)\b/gi;
const contrastWords = /\b(but|however|instead|although|yet|actually|turns out|the problem|the key)\b/gi;
const wordPattern = /[\p{L}\p{N}]+/gu;

/** Shortest stretch of speech worth cutting a clip from when nothing better exists, in seconds. */
const MIN_USABLE_SECONDS = 2;
const MID_SENTENCE_REASON = 'may start or end in the middle of a sentence (the speech has no clear sentence ends)';
type Detected = Omit<HighlightCandidate, 'id' | 'jobId' | 'candidateIndex' | 'createdAt'>;

/**
 * Transparent lexical/timing baseline; it makes no semantic or model-based claims. Every signal is a plain rule over the words and
 * their timing (questions, numbers, strong wording, a clean start and end, no long silences, a length that suits short video), and a
 * clip's `reasons` say which rules it satisfied.
 *
 * It always tries to return something when there is speech: passages that end at sentence boundaries first; when there are fewer
 * of those than clips asked for (speech with little punctuation, or a short video) the rest are passages that may start or end in
 * the middle of a sentence, marked as such; and finally the whole video when it is shorter than the shortest clip allowed.
 */
export class DeterministicHighlightDetector implements HighlightDetector {
  detect(input: HighlightDetectionInput): Detected[] {
    const segments = input.segments.filter((segment) => segment.text.trim() && segment.endSeconds > segment.startSeconds).sort((a, b) => a.segmentIndex - b.segmentIndex);
    const clean = select(windows(segments, input, true), input, []);
    if (clean.length >= input.options.maxCandidates) return clean;
    const loose = select(windows(segments, input, false), input, clean).map((candidate) => ({ ...candidate, reasons: [...candidate.reasons, MID_SENTENCE_REASON] }));
    const found = [...clean, ...loose];
    return found.length ? found : wholeVideo(segments, input);
  }
}

/** Every passage made of whole transcript segments that lasts between the shortest and the longest clip allowed. */
function windows(segments: TranscriptSegment[], input: HighlightDetectionInput, requireSentenceEnd: boolean): Detected[] {
  const candidates: Detected[] = [];
  for (let start = 0; start < segments.length; start += 1) {
    for (let end = start; end < segments.length; end += 1) {
      const startSeconds = clamp(segments[start].startSeconds, 0, input.durationSeconds);
      const endSeconds = clamp(segments[end].endSeconds, 0, input.durationSeconds);
      const duration = endSeconds - startSeconds;
      if (duration > input.options.maxDurationSeconds) break;
      if (duration < input.options.minDurationSeconds || (requireSentenceEnd && !endsAtBoundary(segments[end], end === segments.length - 1))) continue;
      candidates.push(scoreCandidate(segments.slice(start, end + 1), startSeconds, endSeconds, input.options));
    }
  }
  return candidates;
}

/** The best passages, best first, skipping any that mostly repeat one already chosen (here or in `chosen`); at most `maxCandidates` in all. */
function select(candidates: Detected[], input: HighlightDetectionInput, chosen: Detected[]): Detected[] {
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.startSeconds - b.startSeconds);
  const accepted: Detected[] = [];
  for (const candidate of ranked) {
    if (chosen.length + accepted.length >= input.options.maxCandidates) break;
    if (chosen.some((other) => overlapRatio(candidate, other) >= input.options.overlapThreshold) || accepted.some((other) => overlapRatio(candidate, other) >= input.options.overlapThreshold)) continue;
    accepted.push(candidate);
  }
  return accepted;
}

/** For a video shorter than the shortest clip allowed (or with too little speech to form a passage): all of its speech as one clip. */
function wholeVideo(segments: TranscriptSegment[], input: HighlightDetectionInput): Detected[] {
  if (!segments.length) return [];
  const startSeconds = clamp(segments[0].startSeconds, 0, input.durationSeconds);
  const endSeconds = clamp(segments[segments.length - 1].endSeconds, 0, input.durationSeconds);
  if (endSeconds - startSeconds < MIN_USABLE_SECONDS) return [];
  const whole = scoreCandidate(segments, startSeconds, endSeconds, input.options);
  return [{ ...whole, reasons: [...whole.reasons, 'the whole speech of the video, because it is shorter than the shortest clip length'] }];
}

function scoreCandidate(segments: TranscriptSegment[], startSeconds: number, endSeconds: number, options: HighlightOptions): Detected {
  const weights = options.weights;
  const text = segments.map((segment) => segment.text.trim()).join(' '); const duration = endSeconds - startSeconds;
  const wordCount = (text.match(wordPattern) ?? []).length;
  const opening = text.split(/\s+/).slice(0, 14).join(' ');
  const values: Record<string, number> = {
    density: clamp(wordCount / Math.max(duration, 1) / 3, 0, 1),
    emphasis: clamp(count(emphaticWords, text) / 3, 0, 1), question: text.includes('?') ? 1 : 0,
    number: /\b\d+(?:[.,]\d+)?(?:%|x)?\b/.test(text) ? 1 : 0, contrast: clamp(count(contrastWords, text) / 2, 0, 1),
    hook: HOOK_START.test(opening.replace(LEADING_FILLER, '')) ? 1 : 0, completeness: sentenceCompleteness(segments[0], segments.at(-1)!),
    standalone: standalone(segments[0]), continuity: continuity(segments, duration), length: lengthFit(duration, options),
  };
  const signals: HighlightSignals = {}; let weighted = 0; let totalWeight = 0;
  for (const [name, value] of Object.entries(values)) { const weight = weights[name] ?? 0; const contribution = value * weight; signals[name] = { value, weight, contribution }; weighted += contribution; totalWeight += weight; }
  const score = totalWeight ? Math.round((weighted / totalWeight) * 10000) / 100 : 0;
  const reasons = Object.entries(signals).filter(([, signal]) => signal.value > 0 && signal.weight > 0).sort(([, a], [, b]) => b.contribution - a.contribution).map(([name]) => reason(name));
  return { startSeconds, endSeconds, score, quality: score >= 70 ? 'high' as const : score >= 45 ? 'medium' as const : 'low' as const, reasons, signals, sourceSegmentIndexes: segments.map((segment) => segment.segmentIndex), title: suggestTitle(segments.map((segment) => segment.text)) };
}
/** Starts cleanly: not with a lead-in such as "and" / "so" / "um" that only makes sense after what came before. */
function standalone(first: TranscriptSegment) { const text = first.text.trim(); return LEADING_FILLER.test(text) ? 0 : /^[a-z]/.test(text) ? 0.5 : 1; }
/** Speech without long silences: pauses beyond 0.6 s add up, and a clip that is a quarter silence scores nothing. */
function continuity(segments: TranscriptSegment[], duration: number) {
  let silent = 0;
  for (let index = 1; index < segments.length; index += 1) silent += Math.max(0, segments[index].startSeconds - segments[index - 1].endSeconds - 0.6);
  return clamp(1 - silent / Math.max(1, duration * 0.25), 0, 1);
}
/** Short video works best neither at the very shortest nor at the very longest of the allowed lengths: the best fit is a little past the middle. */
function lengthFit(duration: number, options: HighlightOptions) {
  const span = options.maxDurationSeconds - options.minDurationSeconds;
  if (span <= 0) return 1;
  const position = clamp((duration - options.minDurationSeconds) / span, 0, 1);
  return clamp(1 - Math.abs(position - 0.6) / 0.6, 0, 1);
}
function endsAtBoundary(segment: TranscriptSegment, isFinal: boolean) { return isFinal || /[.!?][”"']?$/.test(segment.text.trim()); }
function sentenceCompleteness(first: TranscriptSegment, last: TranscriptSegment) { return (endsAtBoundary(last, false) ? 0.6 : 0) + (/^[A-Z0-9“"']/.test(first.text.trim()) ? 0.4 : 0); }
function count(pattern: RegExp, text: string) { return [...text.matchAll(pattern)].length; }
function clamp(value: number, min: number, max: number) { return Math.min(Math.max(value, min), max); }
function overlapRatio(a: { startSeconds: number; endSeconds: number }, b: { startSeconds: number; endSeconds: number }) { const overlap = Math.max(0, Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds)); return overlap / Math.max(0.001, Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds)); }
function reason(signal: string) { return ({ density: 'high transcript density', emphasis: 'emphatic language', question: 'question phrasing', number: 'numeric detail', contrast: 'contrast or turning-point language', hook: 'hook opening', completeness: 'sentence-boundary completeness', standalone: 'starts cleanly, without a lead-in that needs what came before', continuity: 'continuous speech without long pauses', length: 'a length that suits short video' } as Record<string, string>)[signal] ?? signal; }
