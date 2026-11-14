import assert from 'node:assert/strict';
import test from 'node:test';
import type { MeasuredSpeeds } from './estimate.js';
import { MIN_SAMPLES, MIN_VIDEO_SECONDS, SpeedBook, describeBasis, learnSpeeds, median, type FinishedRun } from './speeds.js';

/** A run of a ten-minute video (twenty windows of 30 s) that listened at 3.4 times the length of the windows, took the sound out at 0.02 and made 135 s of clip at 3.4 times their length. */
const run = (extra: Partial<FinishedRun> = {}, timings: Record<string, number> = {}): FinishedRun => ({ videoSeconds: 600, clipSeconds: 135, framing: 'center', timings: { extracting_audio: 12_000, transcribing: 2_040_000, extracting_clips: 459_000, ...timings }, ...extra });
const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('the middle of a list is what a speed is made of, and one wild run does not move it', () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([9, 1, 5, 7, 3]), 5, 'the order the numbers come in does not matter');
  assert.equal(median([1, 1, 1, 1000]), 1);
});

test('the speeds of finished jobs are the medians of what each did, per second of video and per second of clip', () => {
  const learned = learnSpeeds([run(), run(), run()]);
  near(learned.speeds.listen, 3.4); near(learned.speeds.extractAudio, 0.02); near(learned.speeds.render, 3.4);
  assert.deepEqual(learned.samples, { extractAudio: 3, listen: 3, render: 3 });
  const mixed = learnSpeeds([run({}, { transcribing: 2_000_000 }), run({}, { transcribing: 2_100_000 }), run({}, { transcribing: 2_400_000 }), run({}, { transcribing: 24_000_000 })]);
  near(mixed.speeds.listen, (2_100_000 + 2_400_000) / 2 / 1000 / 600);
});

test('listening is counted in windows of 30 seconds: a video of 45 seconds was listened to for 60, and a tail of less than a second is not listened to', () => {
  // 74 s for two windows is 37 s for each, which is 1.2333 s for each second of the windows, whatever the 45 s of the video.
  const short = (seconds: number) => run({ videoSeconds: seconds }, { transcribing: 74_000 });
  near(learnSpeeds([short(45), short(45), short(45)]).speeds.listen, 74 / 60);
  near(learnSpeeds([short(31), short(31), short(31)]).speeds.listen, 74 / 30);   // a tail of one second is not a window
  near(learnSpeeds([short(31.5), short(31.5), short(31.5)]).speeds.listen, 74 / 60);   // and one of a second and a half is
  near(learnSpeeds([short(600.016), short(600.016), short(600.016)]).speeds.listen, 74 / 600);   // the hundredths of a second that a container adds do not make a window
  assert.deepEqual(learnSpeeds([short(Number.POSITIVE_INFINITY), short(Number.POSITIVE_INFINITY), short(Number.POSITIVE_INFINITY)]).samples, { extractAudio: 0, listen: 0, render: 0 }, 'a length that is not a number is not a sample');
});

test('a speed is only learned from three jobs or more', () => {
  assert.equal(MIN_SAMPLES, 3);
  assert.deepEqual(learnSpeeds([]).speeds, {});
  assert.deepEqual(learnSpeeds([run(), run()]).speeds, {}, 'two jobs are not enough');
  assert.deepEqual(learnSpeeds([run(), run()]).samples, { extractAudio: 2, listen: 2, render: 2 }, 'and what was seen is counted all the same');
  assert.ok(learnSpeeds([run(), run(), run()]).speeds.listen !== undefined);
});

test('a video shorter than half a minute says nothing about speed', () => {
  assert.equal(MIN_VIDEO_SECONDS, 30);
  assert.deepEqual(learnSpeeds([run({ videoSeconds: 29.9 }), run({ videoSeconds: 10 }), run({ videoSeconds: 5 })]).speeds, {});
  assert.ok(learnSpeeds([run({ videoSeconds: 30 }), run({ videoSeconds: 31 }), run({ videoSeconds: 100 })]).speeds.listen !== undefined, 'half a minute is enough');
});

test('a job that did not do some work says nothing about its speed, and says what it did about the rest', () => {
  // Its transcript was reused: it never listened, but it took the sound out and made clips.
  const reused = (): FinishedRun => ({ ...run(), timings: { extracting_audio: 12_000, reusing_transcript: 50, extracting_clips: 459_000 } });
  const learned = learnSpeeds([reused(), reused(), reused()]);
  assert.equal(learned.speeds.listen, undefined); assert.equal(learned.samples.listen, 0);
  near(learned.speeds.extractAudio, 0.02); near(learned.speeds.render, 3.4);
  // Following a face takes longer: those jobs are not part of the speed of making clips, but they did listen.
  const face = learnSpeeds([run({ framing: 'face' }), run({ framing: 'face' }), run({ framing: 'face' })]);
  assert.equal(face.speeds.render, undefined); assert.equal(face.samples.render, 0);
  near(face.speeds.listen, 3.4);
  // No clip, no speed of making clips.
  const none = learnSpeeds([run({ clipSeconds: 0 }), run({ clipSeconds: 0 }), run({ clipSeconds: 0 })]);
  assert.equal(none.speeds.render, undefined); near(none.speeds.listen, 3.4);
});

test('times that cannot be right are not counted', () => {
  const broken = (timings: Record<string, number>) => ({ ...run(), timings });
  const learned = learnSpeeds([broken({ transcribing: -5, extracting_audio: Number.NaN, extracting_clips: 0 }), broken({ transcribing: 0 }), broken({ transcribing: Number.POSITIVE_INFINITY }), broken({})]);
  assert.deepEqual(learned.samples, { extractAudio: 0, listen: 0, render: 0 }, 'a time that is negative, zero, not a number or without end is not a sample');
  assert.equal(learned.speeds.listen, undefined);
  assert.deepEqual(learnSpeeds([broken({ transcribing: -5 }), run(), broken({ transcribing: 0 })]).samples, { extractAudio: 1, listen: 1, render: 1 }, 'and a time that is real beside them is');
  assert.equal(learnSpeeds([run({ videoSeconds: Number.NaN }), run({ videoSeconds: Number.NaN }), run({ videoSeconds: Number.NaN })]).speeds.listen, undefined);
});

/** A speed book over a list of finished jobs that can be changed, a clock that can be moved, and a count of how often the jobs were read. */
function bookOver(initial: FinishedRun[], options: { refreshMs?: number } = {}) {
  const state = { runs: initial, reads: 0, failWith: undefined as unknown, now: 1_000_000, errors: [] as unknown[] };
  const book = new SpeedBook(async () => { state.reads += 1; if (state.failWith) throw state.failWith; return state.runs; }, { now: () => state.now, onError: (error) => state.errors.push(error), ...options });
  return { book, state };
}

test('with nothing measured and nothing finished, no speed is known and nothing can be said about where it came from', async () => {
  const { book } = bookOver([]);
  const known = await book.current();
  assert.deepEqual(known, { speeds: {}, sources: {} });
  assert.equal(describeBasis(known), undefined);
});

test('what the start-up check measured of making a clip is used until jobs have finished; it gives no basis for an estimate, because there is no speed of listening', async () => {
  const { book } = bookOver([]);
  book.noteMeasured({ render: 3.2 }); book.noteMeasured({ extractAudio: 0.03 });
  const known = await book.current();
  assert.deepEqual(known.speeds, { extractAudio: 0.03, render: 3.2 }, 'the speeds measured at different times are put together');
  assert.deepEqual(known.sources, { extractAudio: { kind: 'measured' }, render: { kind: 'measured' } });
  assert.equal(describeBasis(known), undefined);
});

test('the speed of listening is never taken from a measurement, whatever is passed in: a recording of 11 seconds does not say how long a real video takes', async () => {
  const { book } = bookOver([]);
  book.noteMeasured({ listen: 3.3, render: 3.2 } as unknown as MeasuredSpeeds);
  const known = await book.current();
  assert.deepEqual(known.speeds, { render: 3.2 });
  assert.equal(known.sources.listen, undefined);
  assert.equal(describeBasis(known), undefined);
  assert.equal(describeBasis({ speeds: { listen: 3.4, render: 3.2 }, sources: { listen: { kind: 'measured' }, render: { kind: 'measured' } } }), undefined, 'and a speed of listening that only a measurement stands behind has no basis to give, however it got there');
  // Jobs that finished are another matter.
  const { book: learning } = bookOver([run(), run(), run()]);
  learning.noteMeasured({ listen: 9 } as unknown as MeasuredSpeeds);
  near((await learning.current()).speeds.listen, 3.4);
});

test('what the finished jobs show wins over the measurement, speed by speed', async () => {
  // Three jobs listened and took the sound out, but only two made clips with a centred picture.
  const { book } = bookOver([run(), run(), run({ framing: 'face' })]);
  book.noteMeasured({ extractAudio: 9, render: 3.2 });
  const known = await book.current();
  near(known.speeds.listen, 3.4); near(known.speeds.extractAudio, 0.02);
  assert.equal(known.speeds.render, 3.2, 'two jobs are not enough to learn the speed of making clips, so the measurement stays');
  assert.deepEqual(known.sources, { extractAudio: { kind: 'learned', samples: 3 }, listen: { kind: 'learned', samples: 3 }, render: { kind: 'measured' } });
  assert.equal(describeBasis(known), 'how long this server took for its last 3 videos (and, for making the clips, on a test it made when it started)', 'the part of the estimate that rests on the test says so');
  const { book: everything } = bookOver([run(), run(), run(), run()]);
  everything.noteMeasured({ render: 3.2 });
  assert.equal(describeBasis(await everything.current()), 'how long this server took for its last 4 videos');
});

test('a measurement that is not a positive number is not taken, and an earlier one is not lost to it', async () => {
  const { book } = bookOver([]);
  book.noteMeasured({ render: 3.4 });
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) book.noteMeasured({ extractAudio: bad, render: bad });
  assert.deepEqual((await book.current()).speeds, { render: 3.4 });
});

test('the finished jobs are read once a minute at most, however many ask, and again when told to', async () => {
  const { book, state } = bookOver([run(), run(), run()]);
  await Promise.all([book.current(), book.current(), book.current(), book.current()]);
  assert.equal(state.reads, 1, 'four questions at once are one reading');
  state.now += 59_999; await book.current();
  assert.equal(state.reads, 1, 'a moment short of a minute');
  state.now += 1; await book.current();
  assert.equal(state.reads, 2, 'after a minute');
  book.invalidate(); await book.current();
  assert.equal(state.reads, 3, 'told to look again');
});

test('a shorter or longer wait between readings can be chosen', async () => {
  const { book, state } = bookOver([], { refreshMs: 5_000 });
  await book.current(); state.now += 4_999; await book.current(); assert.equal(state.reads, 1);
  state.now += 1; await book.current(); assert.equal(state.reads, 2);
});

test('new jobs that finished show in the speeds after the next reading', async () => {
  const { book, state } = bookOver([]);
  assert.equal((await book.current()).speeds.listen, undefined);
  state.runs = [run(), run(), run()]; state.now += 60_000;
  near((await book.current()).speeds.listen, 3.4);
});

test('when the finished jobs cannot be read, the speeds known before are used, the failure is told, and the next try waits a minute', async () => {
  const { book, state } = bookOver([run(), run(), run()]);
  near((await book.current()).speeds.listen, 3.4);
  state.failWith = new Error('the database is not there'); state.now += 60_000;
  const during = await book.current();
  near(during.speeds.listen, 3.4);
  assert.equal(state.errors.length, 1); assert.equal((state.errors[0] as Error).message, 'the database is not there');
  state.now += 30_000; await book.current();
  assert.equal(state.reads, 2, 'no new try within the minute');
  state.failWith = undefined; state.now += 30_000; await book.current();
  assert.equal(state.reads, 3, 'and a new one after it');
});

test('a failure at the very first reading leaves the measurement in use and never makes the question fail', async () => {
  const { book, state } = bookOver([]);
  book.noteMeasured({ render: 3.2 });
  state.failWith = new Error('no database');
  assert.deepEqual((await book.current()).speeds, { render: 3.2 });
  assert.equal(state.errors.length, 1);
});

test('a reading that fails at once, before it could wait for anything, does not leave the book stuck', async () => {
  let reads = 0; let now = 0;
  const book = new SpeedBook(() => { reads += 1; if (reads === 1) throw new Error('at once'); return Promise.resolve([run(), run(), run()]); }, { now: () => now, onError: () => undefined });
  assert.deepEqual((await book.current()).speeds, {});
  now += 60_000;
  near((await book.current()).speeds.listen, 3.4);
  assert.equal(reads, 2, 'it reads again when it is time');
});

test('being told about a failure cannot make the failure worse', async () => {
  const book = new SpeedBook(async () => { throw new Error('x'); }, { onError: () => { throw new Error('the one told cannot cope'); } });
  assert.deepEqual((await book.current()).speeds, {});
});
