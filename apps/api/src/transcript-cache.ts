import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { TranscriptInput } from './transcription.js';
import { parseStoredWords } from './words.js';

/**
 * A fingerprint of the sound of a video: the SHA-256 of the 16 kHz mono audio that speech recognition is given. What a speech engine
 * writes down depends on that sound and on the engine (see `TranscriptionEngine.cacheKey`), nothing else, so a video whose sound has
 * been recognised before does not have to be recognised again, which is by far the longest stage on a small server.
 */
export function fingerprintAudio(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** A transcript as it is kept in the cache. */
export function serializeSegments(segments: TranscriptInput): string {
  return JSON.stringify(segments.map((segment) => ({
    segmentIndex: segment.segmentIndex, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, text: segment.text,
    ...(segment.words?.length ? { words: segment.words } : {}),
  })));
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Reads a transcript back from the cache. Anything that is not a whole, usable transcript (not JSON, nothing in it, a segment that is
 * missing a field, times that run backwards, the same segment twice, words that are not usable) counts as "not in the cache", so
 * the speech is recognised again instead of a damaged transcript being trusted.
 */
export function parseCachedSegments(json: string | null | undefined): TranscriptInput | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  if (!Array.isArray(parsed) || !parsed.length) return undefined;
  const segments: TranscriptInput = [];
  const seen = new Set<number>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return undefined;
    const { segmentIndex, startSeconds, endSeconds, text, words } = item as Record<string, unknown>;
    if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0 || seen.has(segmentIndex)) return undefined;
    if (!isTime(startSeconds) || !isTime(endSeconds) || endSeconds < startSeconds) return undefined;
    if (typeof text !== 'string' || !text.trim()) return undefined;
    seen.add(segmentIndex);
    if (words === undefined) { segments.push({ segmentIndex, startSeconds, endSeconds, text }); continue; }
    const kept = parseStoredWords(JSON.stringify(words));
    if (!kept) return undefined;
    segments.push({ segmentIndex, startSeconds, endSeconds, text, words: kept });
  }
  return segments;
}
