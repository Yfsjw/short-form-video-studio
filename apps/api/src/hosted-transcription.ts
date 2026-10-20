import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDuration, detectSilences, encodeChunk, planChunks } from './audio-chunks.js';
import type { TranscriptInput, TranscriptionEngine } from './transcription.js';
import { wordsFromTokens, type RawToken } from './words.js';

/**
 * Speech recognition by a hosted service that speaks the OpenAI "audio/transcriptions" protocol (OpenAI itself, Groq, and others that
 * copy it). Much faster than whisper.cpp on a small server: a video that takes hours on the free instance takes seconds to minutes.
 * The audio is cut into pieces at pauses (the services take a limited amount at a time), sent a few at a time, and the answers are
 * joined back into one transcript with the same shape whisper.cpp produces, word timing included.
 *
 * Nothing here is used unless TRANSCRIPTION_ENGINE says so. The audio of the video is sent to that service.
 */
export interface HostedTranscriptionSettings {
  /** Base address of the service, for example the address ending in /v1 (".../audio/transcriptions" is added). */
  apiUrl: string;
  /** Never logged, never put in a message. */
  apiKey: string;
  model: string;
  /** A language code such as "en", or "auto" to let the service detect it. */
  language: string;
  /** How long one request may take, in milliseconds. */
  timeoutMs: number;
  /** About how many seconds of audio go in one request. */
  chunkSeconds: number;
  /** How many requests are in flight at once. */
  concurrency: number;
  ffmpegPath: string;
  ffprobePath: string;
}
/** Seams for the tests: a different `fetch`, no real waiting between retries. */
export interface HostedTranscriptionTools { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; retryDelayMs?: number; maxAttempts?: number; }

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number) => Math.round(value * 1000) / 1000;
/** The letters and digits of a text, lower case: what is left when punctuation and spaces are ignored. */
const lettersOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

interface ServiceWord { text: string; startSeconds: number; endSeconds: number; }

function readWords(value: unknown): ServiceWord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: { word?: unknown; text?: unknown; start?: unknown; end?: unknown } | null) => {
    const text = typeof item?.word === 'string' ? item.word : typeof item?.text === 'string' ? item.text : '';
    return text.trim() && isNumber(item?.start) && isNumber(item?.end) ? [{ text: text.trim(), startSeconds: item.start, endSeconds: item.end }] : [];
  }).sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * The words of a segment as pieces with times, in the form {@link wordsFromTokens} takes. Services give the words without their
 * punctuation ("Hello" for "Hello,"), which the captions need to end a phrase at a comma or a full stop, so each spoken word is
 * matched to the word of the segment's text it belongs to and takes its spelling from there. When the two cannot be matched up (a
 * word the text has and the list does not, or the other way round) the words are used as the service gave them.
 */
export function alignWords(text: string, words: ServiceWord[]): RawToken[] {
  const asGiven = (): RawToken[] => words.map((word) => ({ text: ` ${word.text}`, startSeconds: word.startSeconds, endSeconds: word.endSeconds }));
  const tokens: RawToken[] = [];
  let next = 0;
  for (const piece of text.split(/\s+/).filter(Boolean)) {
    const wanted = lettersOf(piece);
    if (!wanted) { if (tokens.length) tokens[tokens.length - 1].text += piece; continue; } // a lone dash or ellipsis stays with the word before it
    let built = ''; let end = next;
    while (end < words.length && built.length < wanted.length) {
      built += lettersOf(words[end].text); end += 1;
      if (!wanted.startsWith(built)) return asGiven();
    }
    if (built !== wanted) return asGiven();
    tokens.push({ text: ` ${piece}`, startSeconds: words[next].startSeconds, endSeconds: words[end - 1].endSeconds });
    next = end;
  }
  return next === words.length ? tokens : asGiven();
}

/**
 * Reads the service's "verbose_json" answer for one piece of audio into segments with word timing, `offsetSeconds` later than the
 * piece's own clock (so the times are those of the whole recording). Segments the service itself says are not speech (it is sure
 * there was no speech and unsure of what it wrote: the two thresholds Whisper uses) are dropped, since silence and music make it
 * write phrases such as "Thank you." that nobody said.
 */
export function parseVerboseTranscription(document: unknown, offsetSeconds = 0): TranscriptInput {
  const body = (document && typeof document === 'object' ? document : {}) as { segments?: unknown; words?: unknown };
  if (!Array.isArray(body.segments)) throw new Error('The speech recognition service did not send timed segments. It has to answer in the "verbose_json" format.');
  const words = readWords(body.words);
  const segments = (body.segments as Array<Record<string, unknown> | null>).filter((segment): segment is Record<string, unknown> => !!segment && typeof segment === 'object')
    .sort((a, b) => (isNumber(a.start) ? a.start : 0) - (isNumber(b.start) ? b.start : 0));
  const shift = (seconds: number) => round(seconds + offsetSeconds);
  const result: TranscriptInput = [];
  let pointer = 0;
  for (const segment of segments) {
    const { start, end } = segment;
    if (!isNumber(start) || !isNumber(end)) continue;
    while (pointer < words.length && words[pointer].startSeconds < start - 0.5) pointer += 1; // words that belong to no segment
    const own: ServiceWord[] = [];
    while (pointer < words.length && words[pointer].startSeconds < end - 0.001) { own.push(words[pointer]); pointer += 1; }
    const text = typeof segment.text === 'string' ? segment.text.replace(/\s+/g, ' ').trim() : '';
    if (!text || end <= start) continue;
    if (isNumber(segment.no_speech_prob) && isNumber(segment.avg_logprob) && segment.no_speech_prob > 0.6 && segment.avg_logprob < -1) continue;
    const spoken = own.length ? wordsFromTokens(alignWords(text, own), start, end) : undefined;
    result.push({
      segmentIndex: result.length, startSeconds: shift(start), endSeconds: shift(end), text,
      ...(spoken ? { words: spoken.map((word) => ({ text: word.text, startSeconds: shift(word.startSeconds), endSeconds: shift(word.endSeconds) })) } : {}),
    });
  }
  return result;
}

/** Runs `work(0..count-1)` with at most `limit` at a time. The first failure stops new work, aborts what is running and is the one thrown. */
async function runLimited(count: number, limit: number, stop: AbortController, work: (index: number) => Promise<void>): Promise<void> {
  let next = 0; let failed = false; let failure: unknown;
  const worker = async () => {
    while (!failed && next < count) {
      const index = next; next += 1;
      try { await work(index); } catch (error) { if (!failed) { failed = true; failure = error; stop.abort(); } return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  if (failed) throw failure;
}

const RETRIED_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class OpenAiCompatibleTranscriber implements TranscriptionEngine {
  constructor(private readonly settings: HostedTranscriptionSettings, private readonly tools: HostedTranscriptionTools = {}) {}

  async transcribe(audioPath: string, workDir: string, onProgress?: (fraction: number) => void): Promise<TranscriptInput> {
    const { ffmpegPath, ffprobePath, chunkSeconds, concurrency } = this.settings;
    const duration = await audioDuration(ffprobePath, audioPath);
    const silences = duration > chunkSeconds ? await detectSilences(ffmpegPath, audioPath) : [];
    const plan = planChunks(duration, silences, chunkSeconds);
    const results: TranscriptInput[] = new Array(plan.length);
    const stop = new AbortController();
    let finished = 0;
    await runLimited(plan.length, concurrency, stop, async (index) => {
      const file = join(workDir, `speech-${index}.m4a`);
      try {
        await encodeChunk(ffmpegPath, audioPath, plan[index], file);
        results[index] = parseVerboseTranscription(await this.send(await readFile(file), `speech-${index}.m4a`, stop.signal), plan[index].startSeconds);
      } finally { await rm(file, { force: true }); }
      finished += 1;
      onProgress?.(finished / plan.length);
    });
    return results.flat().map((segment, segmentIndex) => ({ ...segment, segmentIndex }));
  }

  private endpoint(): string {
    const base = this.settings.apiUrl.replace(/\/+$/, '');
    return base.endsWith('/audio/transcriptions') ? base : `${base}/audio/transcriptions`;
  }

  /** One piece of audio to the service, and its answer. Pauses and tries again when the service is busy or cannot be reached. */
  private async send(audio: Buffer, filename: string, stop: AbortSignal): Promise<unknown> {
    const fetchImpl = this.tools.fetch ?? fetch;
    const sleep = this.tools.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const maxAttempts = this.tools.maxAttempts ?? 4; const baseDelay = this.tools.retryDelayMs ?? 1000;
    for (let attempt = 1; ; attempt += 1) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mp4' }), filename);
      form.append('model', this.settings.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      form.append('temperature', '0');
      if (this.settings.language && this.settings.language !== 'auto') form.append('language', this.settings.language);

      let response: Response;
      try {
        response = await fetchImpl(this.endpoint(), { method: 'POST', headers: { Authorization: `Bearer ${this.settings.apiKey}` }, body: form, signal: AbortSignal.any([stop, AbortSignal.timeout(this.settings.timeoutMs)]) });
      } catch (error) {
        if (stop.aborted) throw error;
        if (attempt >= maxAttempts) throw new Error(`Could not reach the speech recognition service: ${this.scrub(describeNetworkError(error))}`);
        await sleep(baseDelay * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) {
        try { return await response.json(); } catch { throw new Error('The speech recognition service sent an answer that could not be read.'); }
      }
      const body = await response.text().catch(() => '');
      if (RETRIED_STATUSES.has(response.status) && attempt < maxAttempts) {
        await sleep(retryAfterMs(response.headers.get('retry-after')) ?? baseDelay * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(this.describeFailure(response.status, body));
    }
  }

  /** A message a person can act on. It never carries the key, not even a masked copy of it that the service may echo back. */
  private describeFailure(status: number, body: string): string {
    if (status === 401 || status === 403) return `The speech recognition service did not accept the credentials (HTTP ${status}). Check TRANSCRIPTION_API_KEY.`;
    if (status === 404) return `The speech recognition service does not know this address or model (HTTP 404). Check TRANSCRIPTION_API_URL and TRANSCRIPTION_API_MODEL. ${this.scrub(body)}`.trim();
    if (status === 413) return 'The audio was too large for the speech recognition service (HTTP 413). Lower TRANSCRIPTION_CHUNK_SECONDS.';
    if (status === 429) return 'The speech recognition service is limiting how much can be sent (HTTP 429). Try again in a few minutes.';
    if (status >= 500 || status === 408 || status === 425) return `The speech recognition service is not available right now (HTTP ${status}). Try again later.`;
    return `The speech recognition service refused the audio (HTTP ${status}). ${this.scrub(body)}`.trim();
  }

  private scrub(text: string): string {
    let clean = text.replace(/\s+/g, ' ').trim();
    if (this.settings.apiKey) clean = clean.split(this.settings.apiKey).join('[key]');
    clean = clean.replace(/\b(?:sk|gsk|pk|rk)[-_][A-Za-z0-9*._-]{4,}/g, '[key]');
    return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
  }
}

/** What a service asks for in its Retry-After header (a number of seconds, or a date), at most 30 s; undefined when it asks for nothing. */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !header.trim()) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds * 1000, 30_000) : undefined;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 30_000);
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : '';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'the service took too long to answer';
  return detail ? `${error.message} (${detail})` : error.message;
}
