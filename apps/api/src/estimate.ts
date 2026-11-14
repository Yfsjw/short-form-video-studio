import { clipLengthRanges } from './options.js';
import type { JobOptions } from './domain.js';
import { stageFraction } from './progress.js';

/**
 * How long a video takes, worked out from what this server has been seen to do (see speeds.ts for where the numbers come from). These are plain sums and
 * proportions over measured speeds: nothing here is a model that was trained, and what a person is shown is always called an estimate.
 */

/**
 * What the work costs on this server, in seconds of work for each second of video (or of clip). A speed that is not known is left out, and an
 * estimate that needs it is not made: a wrong number is worse than none.
 */
export interface Speeds {
  /** Taking the sound out of the video (and noting which sound it is). Per second of video. Small next to the others; left out it counts as nothing. */
  extractAudio?: number;
  /**
   * The speech engine listening. For each second of the windows it listens in (see `listenedSeconds`): a video of 45 s is listened to for 60. Learned from the videos this
   * server has finished; the start-up check cannot tell it (see `MeasuredSpeeds`).
   */
  listen?: number;
  /** Making a clip: cutting it, drawing the captions, saving it. Per second of clip. */
  render?: number;
}

/**
 * What a start-up check can measure. The speed of listening is not part of it: the check listens to a recording of 11 seconds, which whisper.cpp works on as one window of
 * 30 seconds, so it says what one window costs for a little speech and not how long a real video takes (see speeds.ts).
 */
export type MeasuredSpeeds = Omit<Speeds, 'listen'>;

/**
 * What the speech engine works on at a time. whisper.cpp listens to a video in windows of 30 seconds, and a window costs about the same whatever part of it is speech (it
 * always looks at a whole one): a video of 45 s is two windows, as one of 60 s is. A tail of less than a second is not listened to. The cost of listening is therefore
 * counted in windows and not in seconds of video. (A hosted service is not built like that, but a speed that is learned and used in the same way is right for it all the same.)
 */
export const LISTEN_WINDOW_SECONDS = 30;

/** The seconds a video of `videoSeconds` is listened to for: a whole number of windows, at least one. */
export function listenedSeconds(videoSeconds: number): number {
  const windows = Number.isFinite(videoSeconds) ? Math.max(1, Math.ceil((videoSeconds - 1) / LISTEN_WINDOW_SECONDS)) : 1;
  return windows * LISTEN_WINDOW_SECONDS;
}

/** What a video asks of the server. */
export interface Work {
  /** How long the video is, in seconds. */
  videoSeconds: number;
  /** How many clips are made at most. */
  clipCount: number;
  /** How long a clip usually is, in seconds. */
  clipSeconds: number;
}

/** The server's own defaults for what a person does not choose (CLIP_MAX_CANDIDATES and the length range of the clips). */
export interface WorkDefaults { clipCount: number; clipSeconds: { min: number; max: number }; }

/** The work a video of `videoSeconds` asks for, given what the person chose (the middle of the length range stands for how long a clip is). */
export function workFor(options: JobOptions, videoSeconds: number, defaults: WorkDefaults): Work {
  const range = options.clipLength === 'auto' ? defaults.clipSeconds : clipLengthRanges[options.clipLength];
  return { videoSeconds, clipCount: options.clipCount ?? defaults.clipCount, clipSeconds: (range.min + range.max) / 2 };
}

export interface Estimate { extractSeconds: number; listenSeconds: number; renderSeconds: number; totalSeconds: number; }

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * How long the whole of `work` takes, once it has started. Nothing when the speed of listening or of making a clip is not known, or when the work makes no
 * sense. A video too short to hold the clips asked for makes fewer (at least one), and a clip is never longer than the video.
 */
export function estimateWork(work: Work, speeds: Speeds): Estimate | undefined {
  if (!positive(speeds.listen) || !positive(speeds.render)) return undefined;
  if (!positive(work.videoSeconds) || !positive(work.clipSeconds) || !(work.clipCount >= 1)) return undefined;
  const clips = Math.max(1, Math.min(Math.floor(work.clipCount), Math.floor(work.videoSeconds / work.clipSeconds)));
  const extractSeconds = positive(speeds.extractAudio) ? speeds.extractAudio * work.videoSeconds : 0;
  const listenSeconds = speeds.listen * listenedSeconds(work.videoSeconds);
  const renderSeconds = speeds.render * clips * Math.min(work.clipSeconds, work.videoSeconds);
  return { extractSeconds, listenSeconds, renderSeconds, totalSeconds: extractSeconds + listenSeconds + renderSeconds };
}

/** Where a video that is being worked on is: its stage, how long it has been in it, and how far along the whole job reads (0 to 100). */
export interface Running { stage: string; stageSeconds: number; percent: number; }

/** What a stage has to have behind it before its own pace says more than the estimate does. */
const PACE_MIN_FRACTION = 0.02;
const PACE_MIN_SECONDS = 30;

/** A stage that began `elapsed` seconds ago and is `fraction` of the way through, expected to take `whole` seconds: what is left of it. */
function leftInStage(elapsed: number, fraction: number, whole: number): number {
  // Once the stage has shown its own pace that is the better guide, because it is this video on this server right now.
  if (fraction >= PACE_MIN_FRACTION && elapsed >= PACE_MIN_SECONDS) return (elapsed * (1 - fraction)) / fraction;
  // Before that, the estimate, never counting the stage as done early and never leaving less than a tenth of it to do.
  return Math.max(whole - elapsed, whole / 10) * (1 - fraction);
}

/** The stages before any heavy work: a video in them has all of it ahead. */
const notStarted = new Set(['queued', 'preparing_source', 'saving_source', 'restoring_source', 'waiting_for_capacity', 'waiting_to_retry', 'probing_video']);

/**
 * How much longer a video that is being worked on needs, or nothing when it cannot be said (a stage that is not a stretch of work, a speed that is not
 * known). Each long stage reports how far along it is, so once it has shown its pace that is used instead of the estimate.
 */
export function timeLeft(running: Running, work: Work, speeds: Speeds): number | undefined {
  const whole = estimateWork(work, speeds);
  if (!whole) return undefined;
  const elapsed = Number.isFinite(running.stageSeconds) ? Math.max(0, running.stageSeconds) : 0;
  const { stage } = running;
  if (notStarted.has(stage)) return whole.totalSeconds;
  switch (stage) {
    case 'extracting_audio': return Math.max(0, whole.extractSeconds - elapsed) + whole.listenSeconds + whole.renderSeconds;
    case 'transcribing': return leftInStage(elapsed, stageFraction(stage, running.percent) ?? 0, whole.listenSeconds) + whole.renderSeconds;
    case 'reusing_transcript':
    case 'detecting_highlights': return whole.renderSeconds;
    case 'extracting_clips': return leftInStage(elapsed, stageFraction(stage, running.percent) ?? 0, whole.renderSeconds);
    default: return undefined;
  }
}

/**
 * When a video that waits will start. `busy` is how much longer each place that is in use has to run, `ahead` how long each video in front of this one
 * takes once it starts (they start in this order, each in the first place that is free), and `places` how many videos are worked on at once. Nothing
 * when any of it is not known.
 */
export function startsIn(busy: ReadonlyArray<number | undefined>, ahead: ReadonlyArray<number | undefined>, places: number): number | undefined {
  const free: number[] = [];
  for (const left of busy) {
    if (left === undefined || !Number.isFinite(left)) return undefined;
    free.push(Math.max(0, left));
  }
  while (free.length < places) free.push(0);
  for (const seconds of ahead) {
    if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
    free.sort((a, b) => a - b);
    free[0] = (free[0] ?? 0) + Math.max(0, seconds);
  }
  return Math.min(...free);
}

/** A time as a person would say it for something that is only an estimate: "less than a minute", "about 7 min", "about 35 min", "about 1 h 20 min", "about 4 h 30 min". */
export function roughly(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'a while';
  if (seconds < 60) return 'less than a minute';
  const minutes = seconds / 60;
  if (minutes < 10) return `about ${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 60) { const nearest = Math.round(minutes / 5) * 5; return nearest >= 60 ? 'about 1 h' : `about ${nearest} min`; }
  const step = minutes < 180 ? 10 : 30;
  const total = Math.round(minutes / step) * step;
  const hours = Math.floor(total / 60); const rest = total % 60;
  return rest === 0 ? `about ${hours} h` : `about ${hours} h ${rest} min`;
}

/** Listening is stopped when it takes longer than the limit, so a video is only accepted when it is expected to need at most this share of that limit. */
export const LISTENING_SHARE_OF_LIMIT = 0.9;

/**
 * The longest video that can be listened to before the engine is stopped at `limitSeconds`, with a tenth of the limit kept in hand: a whole number of windows, so a
 * multiple of 30 s, and never less than one window, however slow the speed looks. A server that turned every video away would never finish one, so it could never find
 * out that it had become quicker again (the speeds are learned from finished videos), and a speed that says that not even one window fits is more likely a bad day than
 * the truth. Nothing when that cannot be told.
 */
export function longestListenable(speeds: Speeds, limitSeconds: number): number | undefined {
  if (!positive(speeds.listen) || !positive(limitSeconds)) return undefined;
  return Math.max(1, Math.floor((limitSeconds * LISTENING_SHARE_OF_LIMIT) / (speeds.listen * LISTEN_WINDOW_SECONDS) + 1e-9)) * LISTEN_WINDOW_SECONDS;
}

export type ListeningVerdict = { fits: true } | { fits: false; listenSeconds: number; longestSeconds: number };

/**
 * Whether a video of `videoSeconds` can be listened to before the engine is stopped at `limitSeconds`. A tenth of the limit is kept in hand, because a speed
 * is an estimate and a video that is stopped at the limit has cost all of that time for nothing. `longestSeconds` is the longest video that fits. Nothing when
 * the speed of listening is not known (then nothing is said against the video).
 */
export function listeningVerdict(videoSeconds: number, speeds: Speeds, limitSeconds: number): ListeningVerdict | undefined {
  const longestSeconds = longestListenable(speeds, limitSeconds);
  if (longestSeconds === undefined || !positive(videoSeconds)) return undefined;
  const covered = listenedSeconds(videoSeconds);
  return covered <= longestSeconds ? { fits: true } : { fits: false, listenSeconds: speeds.listen! * covered, longestSeconds };
}
