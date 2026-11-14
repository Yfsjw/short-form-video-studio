import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultJobOptions, type VideoJob } from './domain.js';
import type { Running } from './estimate.js';
import { forecastFor, loadOf, placeFreesIn, type ForecastSources } from './forecast.js';
import type { QueueView } from './pipeline.js';
import type { KnownSpeeds } from './speeds.js';

const near = (actual: number | undefined, expected: number, message?: string) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, message ?? `${actual} is not ${expected}`);

/** What a ten-minute video asks of the live server (see the README): 12 s to take the sound out, 2040 s to listen, 408 s for three clips of 40 s. */
const learned: KnownSpeeds = { speeds: { extractAudio: 0.02, listen: 3.4, render: 3.4 }, sources: { extractAudio: { kind: 'learned', samples: 7 }, listen: { kind: 'learned', samples: 7 }, render: { kind: 'learned', samples: 7 } } };
const LISTEN = 2040; const RENDER = 408; const WHOLE = 12 + LISTEN + RENDER;
const BASIS = 'how long this server took for its last 7 videos';

const job = (id: string, extra: Partial<VideoJob> = {}): VideoJob => ({ id, originalFilename: 'v.mp4', storedFilename: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'queued', stage: 'waiting_for_capacity', errorMessage: null, durationSeconds: 600, width: 1920, height: 1080, createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z', sourceStorageKey: null, attempts: 1, options: defaultJobOptions, stageTimings: {}, progress: 4, ...extra });
/** Half way through listening to a ten-minute video, after 1000 s: 1000 s of listening and the three clips are left. */
const halfWayListening: Running = { stage: 'transcribing', stageSeconds: 1000, percent: 40 };
const LEFT_HALF_WAY = 1000 + RENDER;

function sourcesFor(view: Partial<QueueView>, jobs: VideoJob[], states: Record<string, Running>, extra: { speeds?: KnownSpeeds } = {}) {
  const calls = { jobs: [] as string[][], speeds: 0 };
  const sources: ForecastSources = {
    queue: () => ({ places: 1, running: [], waiting: [], other: 0, ...view }),
    runState: (id) => states[id],
    jobs: async (ids) => { calls.jobs.push(ids); return jobs.filter((candidate) => ids.includes(candidate.id)); },
    speeds: async () => { calls.speeds += 1; return extra.speeds ?? learned; },
    defaults: { clipCount: 3, clipSeconds: { min: 20, max: 60 } },
  };
  return { sources, calls };
}

test('a video that is over says nothing about time, and neither does one that this process is not working on', async () => {
  // The two that are over are still in the line for the instant before it forgets them.
  const { sources } = sourcesFor({ running: ['other', 'done', 'broken'] }, [], {});
  assert.equal(await forecastFor(job('done', { status: 'completed', stage: 'clip_extraction_complete' }), sources), undefined);
  assert.equal(await forecastFor(job('broken', { status: 'failed', stage: 'failed' }), sources), undefined);
  assert.equal(await forecastFor(job('elsewhere'), sources), undefined, 'a job that is getting its video ready, or that another server has, is neither working nor waiting here');
});

test('a video that is being worked on says how long is left, from the pace it has shown, and what that rests on', async () => {
  const { sources, calls } = sourcesFor({ running: ['r1'] }, [], { r1: halfWayListening });
  const forecast = await forecastFor(job('r1', { status: 'processing', stage: 'transcribing', progress: 40 }), sources);
  assert.deepEqual(Object.keys(forecast ?? {}).sort(), ['basis', 'finishesInSeconds']);
  near(forecast?.finishesInSeconds, LEFT_HALF_WAY);
  assert.equal(forecast?.basis, BASIS);
  assert.deepEqual(calls.jobs, [], 'nothing else has to be read for a video that is being worked on');
});

test('nothing is said about time when the length of the video, the state of the work or the speed of the server is not known, and then nothing is said about what it rests on either', async () => {
  const running = (id: string, extra: Partial<VideoJob> = {}) => job(id, { status: 'processing', stage: 'transcribing', ...extra });
  const known = sourcesFor({ running: ['a'] }, [], { a: halfWayListening });
  assert.deepEqual(await forecastFor(running('a', { durationSeconds: null }), known.sources), {}, 'length not known');
  const noState = sourcesFor({ running: ['a'] }, [], {});
  assert.deepEqual(await forecastFor(running('a'), noState.sources), {}, 'no state (the video was just picked up, or just finished)');
  const noSpeed = sourcesFor({ running: ['a'] }, [], { a: halfWayListening }, { speeds: { speeds: {}, sources: {} } });
  assert.deepEqual(await forecastFor(running('a'), noSpeed.sources), {}, 'no speed known');
});

test('a video that waits says how many are in front of it, and when it starts and ends: when the one that works is done, and then the ones in front, one after the other', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' }), job('w1'), job('w2'), job('w3')];
  const { sources, calls } = sourcesFor({ running: ['r1'], waiting: ['w1', 'w2', 'w3'] }, jobs, { r1: halfWayListening });
  const first = await forecastFor(jobs[1]!, sources);
  assert.deepEqual(first?.ahead, { running: 1, waiting: 0 });
  near(first?.startsInSeconds, LEFT_HALF_WAY); near(first?.finishesInSeconds, LEFT_HALF_WAY + WHOLE);
  assert.equal(first?.basis, BASIS);
  const second = await forecastFor(jobs[2]!, sources);
  assert.deepEqual(second?.ahead, { running: 1, waiting: 1 });
  near(second?.startsInSeconds, LEFT_HALF_WAY + WHOLE); near(second?.finishesInSeconds, LEFT_HALF_WAY + 2 * WHOLE);
  const third = await forecastFor(jobs[3]!, sources);
  assert.deepEqual(third?.ahead, { running: 1, waiting: 2 });
  near(third?.startsInSeconds, LEFT_HALF_WAY + 2 * WHOLE);
  assert.deepEqual(calls.jobs.map((ids) => [...ids].sort()), [['r1'], ['r1', 'w1'], ['r1', 'w1', 'w2']].map((ids) => [...ids].sort()), 'only the video that works and those in front of this one are read, never those behind it');
});

test('with two places the video that waits starts when the first of them is free', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' }), job('r2', { status: 'processing', stage: 'extracting_clips' }), job('w1')];
  const { sources } = sourcesFor({ places: 2, running: ['r1', 'r2'], waiting: ['w1'] }, jobs, { r1: halfWayListening, r2: { stage: 'extracting_clips', stageSeconds: 0, percent: 72 } });
  const forecast = await forecastFor(jobs[2]!, sources);
  near(forecast?.startsInSeconds, RENDER, 'the one that is only making its clips is done first');
  near(forecast?.finishesInSeconds, RENDER + WHOLE);
});

test('a video behind one whose length is not known is told how many are in front of it, and no time', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' }), job('w1', { durationSeconds: null }), job('w2')];
  const { sources } = sourcesFor({ running: ['r1'], waiting: ['w1', 'w2'] }, jobs, { r1: halfWayListening });
  assert.deepEqual(await forecastFor(jobs[2]!, sources), { ahead: { running: 1, waiting: 1 } });
  const unknownRunning = sourcesFor({ running: ['r1'], waiting: ['w2'] }, [job('r1', { durationSeconds: null }), job('w2')], { r1: halfWayListening });
  assert.deepEqual(await forecastFor(job('w2'), unknownRunning.sources), { ahead: { running: 1, waiting: 0 } }, 'nor behind one that works on a video whose length is not known');
});

test('a video whose own length is not known is told when it starts, but not when it ends', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' }), job('w1', { durationSeconds: null })];
  const { sources } = sourcesFor({ running: ['r1'], waiting: ['w1'] }, jobs, { r1: halfWayListening });
  const forecast = await forecastFor(jobs[1]!, sources);
  near(forecast?.startsInSeconds, LEFT_HALF_WAY);
  assert.equal(forecast?.finishesInSeconds, undefined);
  assert.equal(forecast?.basis, BASIS);
});

test('a video that waits with nothing working in front of it starts at once', async () => {
  const jobs = [job('w1')];
  const { sources } = sourcesFor({ running: [], waiting: ['w1'] }, jobs, {});
  const forecast = await forecastFor(jobs[0]!, sources);
  assert.equal(forecast?.startsInSeconds, 0); near(forecast?.finishesInSeconds, WHOLE);
});

test('a server that does no work and has nobody waiting is free at once, and nothing needs to be read to say so', async () => {
  const { sources, calls } = sourcesFor({}, [], {});
  assert.deepEqual(await loadOf(sources), { running: 0, waiting: 0, places: 1, newVideoStartsInSeconds: 0 });
  assert.deepEqual(calls, { jobs: [], speeds: 0 });
  const two = sourcesFor({ places: 2, running: ['r1'] }, [], {});
  assert.deepEqual(await loadOf(two.sources), { running: 1, waiting: 0, places: 2, newVideoStartsInSeconds: 0 }, 'a place is free');
});

test('a free place is not a free server while videos wait for it: the video that waits takes it, and a video uploaded now starts when the next place frees up', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' }), job('w1')];
  const { sources } = sourcesFor({ places: 2, running: ['r1'], waiting: ['w1'] }, jobs, { r1: halfWayListening });
  const load = await loadOf(sources);
  assert.equal(load.waiting, 1);
  near(load.newVideoStartsInSeconds, LEFT_HALF_WAY, 'not 0: the free place goes to the video that waits, and the other is busy until it is done');
});

test('how busy the server is says how many work and wait, and when a video uploaded now would start: after the one that works and all that wait', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' }), job('w1'), job('w2')];
  const busy = sourcesFor({ running: ['r1'] }, jobs, { r1: halfWayListening });
  const one = await loadOf(busy.sources);
  assert.deepEqual({ ...one, newVideoStartsInSeconds: undefined }, { running: 1, waiting: 0, places: 1, newVideoStartsInSeconds: undefined, basis: BASIS });
  near(one.newVideoStartsInSeconds, LEFT_HALF_WAY);
  const full = sourcesFor({ running: ['r1'], waiting: ['w1', 'w2'] }, jobs, { r1: halfWayListening });
  const three = await loadOf(full.sources);
  assert.equal(three.waiting, 2);
  near(three.newVideoStartsInSeconds, LEFT_HALF_WAY + 2 * WHOLE);
});

test('videos that are still getting ready are counted as waiting, but no time is told, because where they will stand in the line and how long they are is not known', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' })];
  const { sources, calls } = sourcesFor({ running: ['r1'], other: 2 }, jobs, { r1: halfWayListening });
  assert.deepEqual(await loadOf(sources), { running: 1, waiting: 2, places: 1 });
  assert.deepEqual(calls, { jobs: [], speeds: 0 });
});

test('no time is told when the speed of the server is not known', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' })];
  const { sources } = sourcesFor({ running: ['r1'] }, jobs, { r1: halfWayListening }, { speeds: { speeds: {}, sources: {} } });
  assert.deepEqual(await loadOf(sources), { running: 1, waiting: 0, places: 1 });
});

test('the line moves when the first place frees up: at once when one is free, otherwise when the video that has least left is done', async () => {
  const jobs = [job('r1', { status: 'processing', stage: 'transcribing' }), job('r2', { status: 'processing', stage: 'extracting_clips' })];
  assert.equal(await placeFreesIn(sourcesFor({}, [], {}).sources), 0, 'nobody works');
  assert.equal(await placeFreesIn(sourcesFor({ places: 2, running: ['r1'] }, jobs, { r1: halfWayListening }).sources), 0, 'a place is free');
  near(await placeFreesIn(sourcesFor({ running: ['r1'], waiting: ['w1'] }, jobs, { r1: halfWayListening }).sources), LEFT_HALF_WAY);
  const two = sourcesFor({ places: 2, running: ['r1', 'r2'], waiting: ['w1'] }, jobs, { r1: halfWayListening, r2: { stage: 'extracting_clips', stageSeconds: 0, percent: 72 } });
  near(await placeFreesIn(two.sources), RENDER, 'the one that is only making its clips is done first');
});

test('it is not said when the line moves if a video that works has a length that is not known, or the speed of the server is not', async () => {
  const unknownLength = sourcesFor({ running: ['r1'] }, [job('r1', { status: 'processing', stage: 'transcribing', durationSeconds: null })], { r1: halfWayListening });
  assert.equal(await placeFreesIn(unknownLength.sources), undefined);
  const unknownSpeed = sourcesFor({ running: ['r1'] }, [job('r1', { status: 'processing', stage: 'transcribing' })], { r1: halfWayListening }, { speeds: { speeds: {}, sources: {} } });
  assert.equal(await placeFreesIn(unknownSpeed.sources), undefined);
});
