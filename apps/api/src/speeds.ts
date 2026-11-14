import { listenedSeconds, type MeasuredSpeeds, type Speeds } from './estimate.js';

/**
 * Where the speeds of this server come from (see estimate.ts for what they are used for). The speed of listening, which is most of the time a video takes, is learned from
 * what this server's own finished jobs took (`learnSpeeds`: this video tool, on this server, as it really is used) and from nothing else. It is not taken from the start-up
 * check: that listens to a recording of 11 seconds, which whisper.cpp works on as one window of 30 seconds, so it says what one window costs for a little speech and not
 * what a long video costs, and the two can be far apart (counted per second of the recording the cost looks about three times what it is per second of a long video, if the
 * cost is the same for every window; if it grows with how much is said it is close to it; which of the two holds on the live server was not known when this was written).
 * The speed of making a clip is learned too, and until enough jobs have finished the start-up check's measurement of it stands in for it (`SpeedBook.noteMeasured`):
 * FFmpeg's time grows with the length of the clip, so a few seconds of clip do say something about it. Neither is a model that was trained: the first is a median of
 * what happened, the second a stopwatch.
 */

/** One job that finished, as far as its speed is concerned. */
export interface FinishedRun {
  /** The length of the video, in seconds. */
  videoSeconds: number;
  /** The length of all the clips that were made from it, in seconds. */
  clipSeconds: number;
  /** How the pictures of the clips were cut. Following a face takes longer than the other ways, so those jobs are left out of the speed of making clips. */
  framing: string;
  /** How long each stage took, in milliseconds. */
  timings: Record<string, number>;
}

/** A speed is only learned from this many jobs or more: one or two can be an unusual day. */
export const MIN_SAMPLES = 3;
/** A video shorter than this says little about speed: what is the same for every video (starting a program, loading its model) is most of its time. */
export const MIN_VIDEO_SECONDS = 30;

/** The middle of a list of numbers (of the two in the middle, their mean). Nothing for an empty list. Unlike a mean, one very slow or very fast run does not move it. */
export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export interface LearnedSpeeds { speeds: Speeds; samples: { extractAudio: number; listen: number; render: number }; }

const usable = (value: number) => Number.isFinite(value) && value > 0;

/**
 * The speeds the finished jobs show: for each, the median of what the jobs that did that work took, for each second of video (for listening: of the windows that were
 * listened to, see `listenedSeconds`) or of clip. A job that did not do the work (its transcript was reused, so it did not listen) says nothing about it. A speed seen in
 * fewer than `MIN_SAMPLES` jobs is left out.
 */
export function learnSpeeds(runs: readonly FinishedRun[]): LearnedSpeeds {
  const samples: Record<'extractAudio' | 'listen' | 'render', number[]> = { extractAudio: [], listen: [], render: [] };
  for (const run of runs) {
    if (!Number.isFinite(run.videoSeconds) || run.videoSeconds < MIN_VIDEO_SECONDS) continue;
    const perVideoSecond = (stage: string) => ((run.timings[stage] ?? 0) / 1000) / run.videoSeconds;
    const extract = perVideoSecond('extracting_audio'); if (usable(extract)) samples.extractAudio.push(extract);
    const listen = ((run.timings.transcribing ?? 0) / 1000) / listenedSeconds(run.videoSeconds); if (usable(listen)) samples.listen.push(listen);
    const render = run.clipSeconds > 0 && run.framing !== 'face' ? ((run.timings.extracting_clips ?? 0) / 1000) / run.clipSeconds : 0; if (usable(render)) samples.render.push(render);
  }
  const speeds: Speeds = {};
  for (const key of ['extractAudio', 'listen', 'render'] as const) {
    const value = samples[key].length >= MIN_SAMPLES ? median(samples[key]) : undefined;
    if (value !== undefined) speeds[key] = value;
  }
  return { speeds, samples: { extractAudio: samples.extractAudio.length, listen: samples.listen.length, render: samples.render.length } };
}

/** Where a speed came from: the median of this many finished jobs, or the start-up check. */
export type SpeedSource = { kind: 'learned'; samples: number } | { kind: 'measured' };
export interface KnownSpeeds { speeds: Speeds; sources: Partial<Record<keyof Speeds, SpeedSource>>; }

/** In words, for a page: what the estimate rests on. The speed of listening (what most of the time is made of) is always learned; nothing is said when it is not known. */
export function describeBasis(known: KnownSpeeds): string | undefined {
  const source = known.sources.listen;
  if (source?.kind !== 'learned') return undefined;
  const base = `how long this server took for its last ${source.samples} videos`;
  return known.sources.render?.kind === 'measured' ? `${base} (and, for making the clips, on a test it made when it started)` : base;
}

export interface SpeedBookOptions {
  now?: () => number;
  /** How long what was learned is used before the finished jobs are looked at again. */
  refreshMs?: number;
  /** Told when the finished jobs could not be read (what was learned before is kept). */
  onError?: (error: unknown) => void;
}

/** What is known about the speeds of this server: the start-up measurements, and what its finished jobs show (read when needed, and kept for a minute). */
export class SpeedBook {
  private measured: MeasuredSpeeds = {};
  private learned: LearnedSpeeds = { speeds: {}, samples: { extractAudio: 0, listen: 0, render: 0 } };
  private loadedAt: number | undefined;
  private loading: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly loadRuns: () => Promise<FinishedRun[]>, private readonly options: SpeedBookOptions = {}) {
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? 60_000;
  }

  /** Takes in what the start-up check measured. A speed that is not a positive number is not taken, and the speed of listening never is (see the top of this file). */
  noteMeasured(speeds: MeasuredSpeeds) {
    for (const key of ['extractAudio', 'render'] as const) {
      const value = speeds[key];
      if (value !== undefined && usable(value)) this.measured = { ...this.measured, [key]: value };
    }
  }

  /** The next question looks at the finished jobs again, however recently it did. */
  invalidate() { this.loadedAt = undefined; }

  /** The speeds as they are known now, each with where it came from. Never fails: when the finished jobs cannot be read, what was learned before is used. */
  async current(): Promise<KnownSpeeds> {
    await this.refreshIfStale();
    const speeds: Speeds = {}; const sources: KnownSpeeds['sources'] = {};
    for (const key of ['extractAudio', 'listen', 'render'] as const) {
      const learned = this.learned.speeds[key]; const measured = key === 'listen' ? undefined : this.measured[key];
      if (learned !== undefined) { speeds[key] = learned; sources[key] = { kind: 'learned', samples: this.learned.samples[key] }; }
      else if (measured !== undefined) { speeds[key] = measured; sources[key] = { kind: 'measured' }; }
    }
    return { speeds, sources };
  }

  private refreshIfStale(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.loadedAt !== undefined && this.now() - this.loadedAt < this.refreshMs) return Promise.resolve();
    const loading: Promise<void> = this.load().finally(() => { if (this.loading === loading) this.loading = undefined; });
    this.loading = loading;
    return loading;
  }

  /** Reads the finished jobs. Never rejects: a failure is told and what was learned before stays, and the next try is a refresh period away. */
  private async load() {
    try { this.learned = learnSpeeds(await this.loadRuns()); }
    catch (error) { try { this.options.onError?.(error); } catch { /* telling about it must not make it worse */ } }
    finally { this.loadedAt = this.now(); }
  }
}
