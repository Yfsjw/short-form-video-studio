import type { VideoJob } from './domain.js';
import { estimateWork, startsIn, timeLeft, workFor, type Running, type Work, type WorkDefaults } from './estimate.js';
import type { QueueView } from './pipeline.js';
import { describeBasis, type KnownSpeeds } from './speeds.js';

/**
 * What a person is told about time: how long their video should take, and where it is in line. All of it is a rough estimate (estimate.ts), and a figure is only
 * given when it can be worked out from what is known: a video whose length is not known, or a server whose speed is not known yet, gets no figure.
 */

/** Where the things a forecast needs come from (the pipeline, the database, the speed book), so that it can be tested without them. */
export interface ForecastSources {
  queue(): QueueView;
  runState(jobId: string): Running | undefined;
  jobs(ids: string[]): Promise<VideoJob[]>;
  speeds(): Promise<KnownSpeeds>;
  defaults: WorkDefaults;
}

export interface Forecast {
  /** For a video that waits for its turn: how many videos are being worked on, and how many wait in front of it. */
  ahead?: { running: number; waiting: number };
  /** How long, roughly, until a video that waits starts. */
  startsInSeconds?: number;
  /** How long, roughly, until the video is finished. */
  finishesInSeconds?: number;
  /** What the figures rest on, in words. Only there when there is a figure. */
  basis?: string;
}

const workOf = (job: VideoJob, defaults: WorkDefaults): Work | undefined => (job.durationSeconds !== null && job.durationSeconds > 0 ? workFor(job.options, job.durationSeconds, defaults) : undefined);

/** How long the jobs that run (`busy`) still need, and how long the jobs in front of a waiting one (`ahead`) will take, from their records. */
async function timesAhead(sources: ForecastSources, known: KnownSpeeds, running: string[], waitingAhead: string[]) {
  const ids = [...running, ...waitingAhead];
  const jobs = new Map((ids.length ? await sources.jobs(ids) : []).map((job) => [job.id, job]));
  const busy = running.map((id) => {
    const job = jobs.get(id); const work = job && workOf(job, sources.defaults); const state = sources.runState(id);
    return work && state ? timeLeft(state, work, known.speeds) : undefined;
  });
  const ahead = waitingAhead.map((id) => {
    const job = jobs.get(id); const work = job && workOf(job, sources.defaults);
    return work ? estimateWork(work, known.speeds)?.totalSeconds : undefined;
  });
  return { busy, ahead };
}

/**
 * What can be said about the time of `job`: for one that is being worked on, how long is left; for one that waits for its turn, how many are in front of it and
 * roughly when it starts and ends. Nothing for a video that is over, one that is still getting ready for its turn, or one that this process does not work on.
 */
export async function forecastFor(job: VideoJob, sources: ForecastSources): Promise<Forecast | undefined> {
  if (job.status === 'completed' || job.status === 'failed') return undefined;
  const view = sources.queue();
  const place = view.waiting.indexOf(job.id);
  const isRunning = view.running.includes(job.id);
  if (!isRunning && place < 0) return undefined;
  const known = await sources.speeds();
  const basis = describeBasis(known);
  const work = workOf(job, sources.defaults);
  const withBasis = (forecast: Forecast): Forecast => (forecast.startsInSeconds !== undefined || forecast.finishesInSeconds !== undefined) && basis ? { ...forecast, basis } : forecast;

  if (isRunning) {
    const state = sources.runState(job.id);
    const left = work && state ? timeLeft(state, work, known.speeds) : undefined;
    return withBasis(left === undefined ? {} : { finishesInSeconds: left });
  }
  const forecast: Forecast = { ahead: { running: view.running.length, waiting: place } };
  const { busy, ahead } = await timesAhead(sources, known, view.running, view.waiting.slice(0, place));
  const starts = startsIn(busy, ahead, view.places);
  if (starts === undefined) return forecast;
  forecast.startsInSeconds = starts;
  const whole = work && estimateWork(work, known.speeds);
  if (whole) forecast.finishesInSeconds = starts + whole.totalSeconds;
  return withBasis(forecast);
}

/**
 * How long, roughly, until a place for the heavy stages frees up, which is when the line moves by one (the next video in it takes the place). 0 when a place
 * is free now. Nothing when it cannot be told (a video that is being worked on is of a length that is not known, or the speed of the server is not known).
 */
export async function placeFreesIn(sources: ForecastSources): Promise<number | undefined> {
  const view = sources.queue();
  if (view.running.length < view.places) return 0;
  const { busy } = await timesAhead(sources, await sources.speeds(), view.running, []);
  return startsIn(busy, [], view.places);
}

/** How busy the server is, for the upload page and for programs. */
export interface Load {
  /** Videos being worked on. */
  running: number;
  /** Videos waiting for their turn, and those still getting their video ready for it. */
  waiting: number;
  /** How many videos are worked on at once. */
  places: number;
  /** How long, roughly, until a video uploaded now would start (0: at once). Only when it can be told. */
  newVideoStartsInSeconds?: number;
  /** What that rests on, in words. */
  basis?: string;
}

export async function loadOf(sources: ForecastSources): Promise<Load> {
  const view = sources.queue();
  const load: Load = { running: view.running.length, waiting: view.waiting.length + view.other, places: view.places };
  if (load.running < view.places && load.waiting === 0) return { ...load, newVideoStartsInSeconds: 0 };
  // Videos that are still getting ready will join the line in an order nobody knows yet, and their length is not known to the line.
  if (view.other > 0) return load;
  const known = await sources.speeds();
  const { busy, ahead } = await timesAhead(sources, known, view.running, view.waiting);
  const starts = startsIn(busy, ahead, view.places);
  const basis = describeBasis(known);
  return starts === undefined ? load : { ...load, newVideoStartsInSeconds: starts, ...(basis ? { basis } : {}) };
}
