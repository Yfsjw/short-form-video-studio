import { listeningVerdict, longestListenable, roughly, type Speeds } from './estimate.js';
import { formatDuration } from './progress.js';

/**
 * Saying no early. A video that this server cannot do should be turned away in the first seconds, in words that say why and what to do, instead of
 * being accepted, made to wait in line and failed an hour later; and a server that already has all the videos it can hold says so instead of
 * piling up uploads on a small disk.
 */

export interface TooLong { code: 'VIDEO_TOO_LONG'; status: 422; message: string }
export interface ServerBusy { code: 'SERVER_BUSY'; status: 503; message: string; retryAfterSeconds: number }
export type Refusal = TooLong | ServerBusy;

export interface AdmissionRules {
  /** How many videos may wait for their turn (or be getting ready for it) behind those being worked on. Nothing: no limit. */
  queueLimit: number | undefined;
  /** How long the speech engine may listen before it is stopped. Nothing for an engine that is not stopped that way (a hosted service). */
  listeningLimitSeconds: number | undefined;
}

/** "1 hour", "90 minutes", "2 hours": an exact time, for a limit. */
export function limitWords(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} seconds`;
  if (seconds % 3600 === 0) { const hours = seconds / 3600; return `${hours} hour${hours === 1 ? '' : 's'}`; }
  return `${Math.round(seconds / 60)} minutes`;
}

/** What is said of the longest video that works: "about 15 min", or that only a very short one does. */
export function longestWords(longestSeconds: number): string {
  const minutes = Math.floor(longestSeconds / 60);
  return minutes >= 1 ? `Videos up to about ${minutes} min work right now.` : 'Right now only a very short video can be done.';
}

/** A video that cannot be listened to in the time allowed is turned away (nothing is said against a video when the speed of listening is not known). */
export function refuseIfTooLong(videoSeconds: number | undefined, speeds: Speeds, rules: AdmissionRules): TooLong | undefined {
  if (videoSeconds === undefined || rules.listeningLimitSeconds === undefined) return undefined;
  const verdict = listeningVerdict(videoSeconds, speeds, rules.listeningLimitSeconds);
  if (!verdict || verdict.fits) return undefined;
  const longest = longestListenable(speeds, rules.listeningLimitSeconds) ?? 0;
  return {
    code: 'VIDEO_TOO_LONG', status: 422,
    message: `This video is ${formatDuration(videoSeconds * 1000)} long, which is too long for this server: listening to it would take ${roughly(verdict.listenSeconds)}, and the server stops listening after ${limitWords(rules.listeningLimitSeconds)}. ${longestWords(longest)} Please upload a shorter part of it.`,
  };
}

/** The most that is waited before asking again, and the least (a person who is told to come back in a second would only be turned away again). */
const RETRY_AFTER_BOUNDS = { min: 60, max: 3600, unknown: 300 } as const;

/**
 * A server that already holds as many waiting videos as it takes on turns the next one away. `waiting` is how many wait or are getting ready, and
 * `placeFreesInSeconds` how long, roughly, until a place for the heavy stages frees up and the line moves (when that is known).
 */
export function refuseIfFull(waiting: number, rules: AdmissionRules, placeFreesInSeconds?: number): ServerBusy | undefined {
  if (rules.queueLimit === undefined || waiting < rules.queueLimit) return undefined;
  const known = placeFreesInSeconds !== undefined && Number.isFinite(placeFreesInSeconds);
  const retryAfterSeconds = known ? Math.min(Math.max(Math.ceil(placeFreesInSeconds), RETRY_AFTER_BOUNDS.min), RETRY_AFTER_BOUNDS.max) : RETRY_AFTER_BOUNDS.unknown;
  return {
    code: 'SERVER_BUSY', status: 503, retryAfterSeconds,
    message: `The server is full right now: ${waiting} video${waiting === 1 ? ' is' : 's are'} already waiting for their turn, and it does not take on more than ${rules.queueLimit}. Please try again ${known ? `in ${roughly(placeFreesInSeconds)}` : 'in a few minutes'}.`,
  };
}
