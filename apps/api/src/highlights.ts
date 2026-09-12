import type { HighlightCandidate, HighlightSignals, TranscriptSegment } from './domain.js';

export interface HighlightDetector { detect(input: HighlightDetectionInput): Array<Omit<HighlightCandidate, 'id' | 'jobId' | 'candidateIndex' | 'createdAt'>>; }
export interface HighlightDetectionInput { segments: TranscriptSegment[]; durationSeconds: number; metadata: { width: number | null; height: number | null }; options: HighlightOptions; }
export interface HighlightOptions { minDurationSeconds: number; maxDurationSeconds: number; maxCandidates: number; overlapThreshold: number; weights: Record<string, number>; }

const emphaticWords = /\b(amazing|best|breakthrough|critical|essential|powerful|unbelievable|surprising|incredible|must|never|always|huge)\b/gi;
const contrastWords = /\b(but|however|instead|although|yet|actually|turns out|the problem|the key)\b/gi;
const hookStart = /^(here(?:'s| is)|what if|the truth is|you need to|let me show you|most people|this is why|imagine)\b/i;
const wordPattern = /[\p{L}\p{N}]+/gu;

/** Transparent lexical/timing baseline; it makes no semantic or model-based claims. */
export class DeterministicHighlightDetector implements HighlightDetector {
  detect(input: HighlightDetectionInput) {
    const segments = input.segments.filter((segment) => segment.text.trim() && segment.endSeconds > segment.startSeconds).sort((a, b) => a.segmentIndex - b.segmentIndex);
    const candidates: Array<Omit<HighlightCandidate, 'id' | 'jobId' | 'candidateIndex' | 'createdAt'>> = [];
    for (let start = 0; start < segments.length; start += 1) {
      for (let end = start; end < segments.length; end += 1) {
        const startSeconds = clamp(segments[start].startSeconds, 0, input.durationSeconds);
        const endSeconds = clamp(segments[end].endSeconds, 0, input.durationSeconds);
        const duration = endSeconds - startSeconds;
        if (duration > input.options.maxDurationSeconds) break;
        if (duration < input.options.minDurationSeconds || !endsAtBoundary(segments[end], end === segments.length - 1)) continue;
        candidates.push(scoreCandidate(segments.slice(start, end + 1), startSeconds, endSeconds, input.options.weights));
      }
    }
    const ranked = candidates.sort((a, b) => b.score - a.score || a.startSeconds - b.startSeconds);
    const accepted: typeof ranked = [];
    for (const candidate of ranked) {
      if (accepted.length >= input.options.maxCandidates) break;
      if (accepted.some((chosen) => overlapRatio(candidate, chosen) >= input.options.overlapThreshold)) continue;
      accepted.push(candidate);
    }
    return accepted;
  }
}

function scoreCandidate(segments: TranscriptSegment[], startSeconds: number, endSeconds: number, weights: Record<string, number>) {
  const text = segments.map((segment) => segment.text.trim()).join(' '); const duration = endSeconds - startSeconds;
  const wordCount = (text.match(wordPattern) ?? []).length;
  const values: Record<string, number> = {
    density: clamp(wordCount / Math.max(duration, 1) / 3, 0, 1),
    emphasis: clamp(count(emphaticWords, text) / 3, 0, 1), question: text.includes('?') ? 1 : 0,
    number: /\b\d+(?:[.,]\d+)?(?:%|x)?\b/.test(text) ? 1 : 0, contrast: clamp(count(contrastWords, text) / 2, 0, 1),
    hook: hookStart.test(segments[0].text.trim()) ? 1 : 0, completeness: sentenceCompleteness(segments[0], segments.at(-1)!)
  };
  const signals: HighlightSignals = {}; let weighted = 0; let totalWeight = 0;
  for (const [name, value] of Object.entries(values)) { const weight = weights[name] ?? 0; const contribution = value * weight; signals[name] = { value, weight, contribution }; weighted += contribution; totalWeight += weight; }
  const score = totalWeight ? Math.round((weighted / totalWeight) * 10000) / 100 : 0;
  const reasons = Object.entries(signals).filter(([, signal]) => signal.value > 0).sort(([, a], [, b]) => b.contribution - a.contribution).map(([name]) => reason(name));
  return { startSeconds, endSeconds, score, quality: score >= 70 ? 'high' as const : score >= 45 ? 'medium' as const : 'low' as const, reasons, signals, sourceSegmentIndexes: segments.map((segment) => segment.segmentIndex) };
}
function endsAtBoundary(segment: TranscriptSegment, isFinal: boolean) { return isFinal || /[.!?][”"']?$/.test(segment.text.trim()); }
function sentenceCompleteness(first: TranscriptSegment, last: TranscriptSegment) { return (endsAtBoundary(last, false) ? 0.6 : 0) + (/^[A-Z0-9“"']/.test(first.text.trim()) ? 0.4 : 0); }
function count(pattern: RegExp, text: string) { return [...text.matchAll(pattern)].length; }
function clamp(value: number, min: number, max: number) { return Math.min(Math.max(value, min), max); }
function overlapRatio(a: { startSeconds: number; endSeconds: number }, b: { startSeconds: number; endSeconds: number }) { const overlap = Math.max(0, Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds)); return overlap / Math.max(0.001, Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds)); }
function reason(signal: string) { return ({ density: 'high transcript density', emphasis: 'emphatic language', question: 'question phrasing', number: 'numeric detail', contrast: 'contrast or turning-point language', hook: 'hook opening', completeness: 'sentence-boundary completeness' } as Record<string, string>)[signal] ?? signal; }
