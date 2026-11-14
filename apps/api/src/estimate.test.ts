import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultJobOptions, type JobOptions } from './domain.js';
import { LISTENING_SHARE_OF_LIMIT, LISTEN_WINDOW_SECONDS, estimateWork, listenedSeconds, listeningVerdict, longestListenable, roughly, startsIn, timeLeft, workFor, type Speeds, type Work } from './estimate.js';
import { stageFraction, stageProgress } from './progress.js';

/** What the live server was seen to do on 10 November 2026 (see the README): about 3.4 seconds to listen to a second of speech, about 3.4 to make a second of clip. */
const slow: Speeds = { extractAudio: 0.02, listen: 3.4, render: 3.4 };
const tenMinutes: Work = { videoSeconds: 600, clipCount: 3, clipSeconds: 45 };
const near = (actual: number | undefined, expected: number, message?: string) => { assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, message ?? `${actual} is not ${expected}`); };

/** A small deterministic source of numbers, so that the checks over many cases are the same on every run. */
function randoms(seed: number) { let state = seed; return () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return state / 4_294_967_296; }; }

test('the work of a video follows what the person chose, and the server\'s defaults for the rest', () => {
  const defaults = { clipCount: 3, clipSeconds: { min: 20, max: 60 } };
  assert.deepEqual(workFor(defaultJobOptions, 600, defaults), { videoSeconds: 600, clipCount: 3, clipSeconds: 40 });
  assert.deepEqual(workFor({ ...defaultJobOptions, clipCount: 5, clipLength: 'short' }, 600, defaults), { videoSeconds: 600, clipCount: 5, clipSeconds: 22.5 });
  assert.equal(workFor({ ...defaultJobOptions, clipLength: 'medium' }, 600, defaults).clipSeconds, 45);
  assert.equal(workFor({ ...defaultJobOptions, clipLength: 'long' }, 600, defaults).clipSeconds, 75);
  const options: JobOptions = { ...defaultJobOptions, clipCount: 1 };
  assert.equal(workFor(options, 600, defaults).clipCount, 1);
});

test('the estimate of a video is the sum of taking the sound out, listening and making the clips', () => {
  const estimate = estimateWork(tenMinutes, slow);
  assert.ok(estimate);
  near(estimate.extractSeconds, 12);
  near(estimate.listenSeconds, 2040);
  near(estimate.renderSeconds, 3.4 * 3 * 45);
  near(estimate.totalSeconds, 12 + 2040 + 459);
});

test('listening is counted in windows of 30 seconds: a video of 45 seconds costs two windows, as one of 60 does, and a tail of less than a second costs none', () => {
  assert.equal(LISTEN_WINDOW_SECONDS, 30);
  for (const [seconds, covered] of [[1, 30], [20, 30], [30, 30], [31, 30], [31.5, 60], [45, 60], [60, 60], [61, 60], [61.5, 90], [600, 600], [600.016, 600], [601.5, 630], [3600, 3600]] as const) assert.equal(listenedSeconds(seconds), covered, `${seconds} s`);
  assert.equal(listenedSeconds(0), 30, 'at least one window'); assert.equal(listenedSeconds(Number.NaN), 30); assert.equal(listenedSeconds(Number.POSITIVE_INFINITY), 30);
  const speeds: Speeds = { listen: 2, render: 1 };
  near(estimateWork({ videoSeconds: 45, clipCount: 1, clipSeconds: 10 }, speeds)?.listenSeconds, 2 * 60);
  near(estimateWork({ videoSeconds: 60, clipCount: 1, clipSeconds: 10 }, speeds)?.listenSeconds, 2 * 60, 'the same as 45 s');
  near(estimateWork({ videoSeconds: 31, clipCount: 1, clipSeconds: 10 }, speeds)?.listenSeconds, 2 * 30, 'a tail of a second is not listened to');
  near(estimateWork({ videoSeconds: 8, clipCount: 1, clipSeconds: 4 }, speeds)?.listenSeconds, 2 * 30, 'a short video costs a whole window');
});

test('no estimate is made without the speed of listening and the speed of making a clip, and a sound that takes no time is not made up', () => {
  assert.equal(estimateWork(tenMinutes, {}), undefined);
  assert.equal(estimateWork(tenMinutes, { listen: 3.4 }), undefined);
  assert.equal(estimateWork(tenMinutes, { render: 3.4 }), undefined);
  assert.equal(estimateWork(tenMinutes, { listen: 0, render: 3.4 }), undefined);
  assert.equal(estimateWork(tenMinutes, { listen: Number.NaN, render: 3.4 }), undefined);
  assert.equal(estimateWork(tenMinutes, { listen: 3.4, render: -1 }), undefined);
  const withoutExtraction = estimateWork(tenMinutes, { listen: 3.4, render: 3.4 });
  near(withoutExtraction?.extractSeconds, 0, 'the taking out of the sound is left out, not guessed');
});

test('work that makes no sense gets no estimate', () => {
  assert.equal(estimateWork({ ...tenMinutes, videoSeconds: 0 }, slow), undefined);
  assert.equal(estimateWork({ ...tenMinutes, videoSeconds: -5 }, slow), undefined);
  assert.equal(estimateWork({ ...tenMinutes, videoSeconds: Number.NaN }, slow), undefined);
  assert.equal(estimateWork({ ...tenMinutes, videoSeconds: Number.POSITIVE_INFINITY }, slow), undefined);
  assert.equal(estimateWork({ ...tenMinutes, clipSeconds: 0 }, slow), undefined);
  assert.equal(estimateWork({ ...tenMinutes, clipCount: 0 }, slow), undefined);
});

test('a video too short for the clips asked for makes fewer, and a clip is never longer than the video', () => {
  // 100 s hold two clips of 45 s, not three.
  near(estimateWork({ videoSeconds: 100, clipCount: 3, clipSeconds: 45 }, slow)?.renderSeconds, 3.4 * 2 * 45);
  // 20 s hold no clip of 45 s: one clip, as long as the video.
  near(estimateWork({ videoSeconds: 20, clipCount: 3, clipSeconds: 45 }, slow)?.renderSeconds, 3.4 * 1 * 20);
  // Asking for fewer clips than the video holds makes that many.
  near(estimateWork({ videoSeconds: 3000, clipCount: 2, clipSeconds: 45 }, slow)?.renderSeconds, 3.4 * 2 * 45);
});

test('a longer video and more clips never take less time (over many made-up cases)', () => {
  const next = randoms(7);
  for (let round = 0; round < 300; round += 1) {
    const speeds: Speeds = { extractAudio: next() * 0.1, listen: 0.01 + next() * 6, render: 0.01 + next() * 6 };
    const work: Work = { videoSeconds: 5 + next() * 7200, clipCount: 1 + Math.floor(next() * 5), clipSeconds: 10 + next() * 80 };
    const base = estimateWork(work, speeds); const longer = estimateWork({ ...work, videoSeconds: work.videoSeconds + 1 + next() * 600 }, speeds); const more = estimateWork({ ...work, clipCount: work.clipCount + 1 }, speeds);
    assert.ok(base && longer && more);
    assert.ok(longer.totalSeconds >= base.totalSeconds, 'a longer video took less time');
    assert.ok(more.totalSeconds >= base.totalSeconds, 'more clips took less time');
    near(base.totalSeconds, base.extractSeconds + base.listenSeconds + base.renderSeconds, 'the parts do not add up to the whole');
    assert.ok(base.extractSeconds >= 0 && base.listenSeconds > 0 && base.renderSeconds > 0);
  }
});

test('how far along a stage is is read back from the overall progress, and only for stages that are stretches of work', () => {
  assert.equal(stageFraction('transcribing', 10), 0);
  assert.equal(stageFraction('transcribing', 40), 0.5);
  assert.equal(stageFraction('transcribing', 70), 1);
  assert.equal(stageFraction('transcribing', 3), 0, 'below the stage counts as its start');
  assert.equal(stageFraction('transcribing', 99), 1, 'above it counts as its end');
  assert.equal(stageFraction('transcribing', Number.NaN), undefined);
  assert.equal(stageFraction('waiting_for_capacity', 4), undefined, 'a stage with no width has no fractions');
  assert.equal(stageFraction('a stage from the future', 50), undefined);
  // One is the opposite of the other (these fractions land on whole percents, so nothing is lost to rounding).
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) near(stageFraction('transcribing', stageProgress('transcribing', fraction)), fraction);
});

test('before any heavy work the whole estimate is ahead, and it shrinks as the stages are passed', () => {
  const whole = estimateWork(tenMinutes, slow); assert.ok(whole);
  for (const stage of ['queued', 'preparing_source', 'saving_source', 'restoring_source', 'waiting_for_capacity', 'waiting_to_retry', 'probing_video']) {
    near(timeLeft({ stage, stageSeconds: 5, percent: 4 }, tenMinutes, slow), whole.totalSeconds, stage);
  }
  const order = ['queued', 'probing_video', 'extracting_audio', 'transcribing', 'reusing_transcript', 'detecting_highlights', 'extracting_clips'];
  const left = order.map((stage) => timeLeft({ stage, stageSeconds: 0, percent: stageProgress(stage) }, tenMinutes, slow));
  assert.ok(left.every((value) => value !== undefined), `${left}`);
  const numbers = left as number[];
  for (let index = 1; index < numbers.length; index += 1) assert.ok(numbers[index]! <= numbers[index - 1]!, `${order[index]} has more left (${numbers[index]}) than ${order[index - 1]} (${numbers[index - 1]})`);
  near(timeLeft({ stage: 'extracting_audio', stageSeconds: 0, percent: 6 }, tenMinutes, slow), whole.totalSeconds);
  near(timeLeft({ stage: 'extracting_audio', stageSeconds: 5, percent: 6 }, tenMinutes, slow), whole.totalSeconds - 5);
  near(timeLeft({ stage: 'extracting_audio', stageSeconds: 500, percent: 6 }, tenMinutes, slow), whole.listenSeconds + whole.renderSeconds, 'a sound that takes longer than expected has nothing of that left');
  near(timeLeft({ stage: 'reusing_transcript', stageSeconds: 1, percent: 10 }, tenMinutes, slow), whole.renderSeconds);
  near(timeLeft({ stage: 'detecting_highlights', stageSeconds: 1, percent: 70 }, tenMinutes, slow), whole.renderSeconds);
});

test('once listening has shown its pace, that pace is what is left, and the clips still to be made are added', () => {
  const whole = estimateWork(tenMinutes, slow); assert.ok(whole);
  // Half way after 1000 s: another 1000 s of listening, whatever the estimate said.
  near(timeLeft({ stage: 'transcribing', stageSeconds: 1000, percent: stageProgress('transcribing', 0.5) }, tenMinutes, slow), 1000 + whole.renderSeconds);
  // A quarter of the way after 100 s: three times as long again.
  near(timeLeft({ stage: 'transcribing', stageSeconds: 100, percent: stageProgress('transcribing', 0.25) }, tenMinutes, slow), 300 + whole.renderSeconds);
  // At the very start the estimate is all there is.
  near(timeLeft({ stage: 'transcribing', stageSeconds: 0, percent: 10 }, tenMinutes, slow), whole.listenSeconds + whole.renderSeconds);
  // Not enough time spent for the pace to mean anything: the estimate, with what was done taken off.
  near(timeLeft({ stage: 'transcribing', stageSeconds: 20, percent: stageProgress('transcribing', 0.5) }, tenMinutes, slow), Math.max(whole.listenSeconds - 20, whole.listenSeconds / 10) * 0.5 + whole.renderSeconds);
  // Not enough done for the pace to mean anything (under 2%: 11.15 is 1.9% of the way from 10 to 70).
  const under = stageFraction('transcribing', 11.15)!; assert.ok(under < 0.02);
  near(timeLeft({ stage: 'transcribing', stageSeconds: 200, percent: 11.15 }, tenMinutes, slow), Math.max(whole.listenSeconds - 200, whole.listenSeconds / 10) * (1 - under) + whole.renderSeconds, 'under 2% the estimate is still used');
  // Just enough: a little over 2% and 30 s.
  const over = stageFraction('transcribing', 11.25)!; assert.ok(over >= 0.02);
  near(timeLeft({ stage: 'transcribing', stageSeconds: 30, percent: 11.25 }, tenMinutes, slow), (30 * (1 - over)) / over + whole.renderSeconds, '30 s are enough');
  near(timeLeft({ stage: 'transcribing', stageSeconds: 29.9, percent: 11.25 }, tenMinutes, slow), Math.max(whole.listenSeconds - 29.9, whole.listenSeconds / 10) * (1 - over) + whole.renderSeconds, 'under 30 s the estimate is still used');
  // A stage that has run much longer than expected without reporting any progress still has a tenth of the estimate to go.
  near(timeLeft({ stage: 'transcribing', stageSeconds: 99_999, percent: 10 }, tenMinutes, slow), whole.listenSeconds / 10 + whole.renderSeconds);
});

test('making the clips is followed clip by clip in the same way', () => {
  const whole = estimateWork(tenMinutes, slow); assert.ok(whole);
  near(timeLeft({ stage: 'extracting_clips', stageSeconds: 0, percent: 72 }, tenMinutes, slow), whole.renderSeconds);
  near(timeLeft({ stage: 'extracting_clips', stageSeconds: 10, percent: 72 }, tenMinutes, slow), whole.renderSeconds - 10);
  // One of three done after 100 s: two more like it.
  near(timeLeft({ stage: 'extracting_clips', stageSeconds: 100, percent: stageProgress('extracting_clips', 1 / 3) }, tenMinutes, slow), 200, 'a whole percent of rounding is allowed') ;
});

test('a video that is over, failed, stopped or in a stage nobody knows has no time left', () => {
  for (const stage of ['clip_extraction_complete', 'failed', 'stopped', 'a stage from the future']) assert.equal(timeLeft({ stage, stageSeconds: 3, percent: 50 }, tenMinutes, slow), undefined, stage);
});

test('no time is left that is not known, and none is negative or not a number', () => {
  assert.equal(timeLeft({ stage: 'transcribing', stageSeconds: 3, percent: 20 }, tenMinutes, {}), undefined);
  assert.equal(timeLeft({ stage: 'transcribing', stageSeconds: 3, percent: 20 }, { ...tenMinutes, videoSeconds: 0 }, slow), undefined);
  assert.ok((timeLeft({ stage: 'transcribing', stageSeconds: -50, percent: 20 }, tenMinutes, slow) ?? -1) >= 0, 'a negative time in the stage counts as none');
  assert.ok((timeLeft({ stage: 'transcribing', stageSeconds: Number.NaN, percent: 20 }, tenMinutes, slow) ?? -1) >= 0);
  assert.ok((timeLeft({ stage: 'transcribing', stageSeconds: 100, percent: Number.NaN }, tenMinutes, slow) ?? -1) >= 0);
  const next = randoms(11);
  const stages = ['queued', 'probing_video', 'extracting_audio', 'transcribing', 'reusing_transcript', 'detecting_highlights', 'extracting_clips'];
  for (let round = 0; round < 500; round += 1) {
    const stage = stages[Math.floor(next() * stages.length)]!;
    const left = timeLeft({ stage, stageSeconds: next() * 20_000 - 100, percent: next() * 120 - 10 }, { videoSeconds: 5 + next() * 7200, clipCount: 1 + Math.floor(next() * 5), clipSeconds: 10 + next() * 80 }, { extractAudio: next() * 0.1, listen: 0.01 + next() * 6, render: 0.01 + next() * 6 });
    assert.ok(left !== undefined && Number.isFinite(left) && left >= 0, `${stage}: ${left}`);
  }
});

test('when a video that waits will start: places in use run out first, the videos in front go one after the other', () => {
  assert.equal(startsIn([], [], 1), 0, 'a free place is a start at once');
  assert.equal(startsIn([100], [], 1), 100);
  assert.equal(startsIn([100], [50, 70], 1), 220);
  assert.equal(startsIn([100, 30], [50], 2), 80, 'with two places the first free one is taken');
  assert.equal(startsIn([100, 30], [50, 70], 2), 100);
  assert.equal(startsIn([], [40], 2), 0, 'a place that is not in use is free');
  assert.equal(startsIn([], [40, 40, 40], 2), 40);
  assert.equal(startsIn([-5], [], 1), 0, 'a time that is already over counts as none');
  assert.equal(startsIn([10, 20, 30], [], 1), 10, 'more places in use than there are is taken as they come');
});

test('nothing is said about the start when a time in front of it is not known', () => {
  assert.equal(startsIn([undefined], [10], 1), undefined);
  assert.equal(startsIn([10], [undefined], 1), undefined);
  assert.equal(startsIn([Number.NaN], [], 1), undefined);
  assert.equal(startsIn([10], [Number.POSITIVE_INFINITY], 1), undefined);
});

test('a time is said roughly, the way a person would, and a time that makes no sense is not turned into a number', () => {
  const cases: Array<[number, string]> = [
    [0, 'less than a minute'], [59, 'less than a minute'], [60, 'about 1 min'], [89, 'about 1 min'], [90, 'about 2 min'], [420, 'about 7 min'], [599, 'about 10 min'], [600, 'about 10 min'],
    [29 * 60, 'about 30 min'], [32 * 60, 'about 30 min'], [33 * 60, 'about 35 min'], [3540, 'about 1 h'], [3600, 'about 1 h'], [3900, 'about 1 h 10 min'], [4500, 'about 1 h 20 min'],
    [8100, 'about 2 h 20 min'], [10_800, 'about 3 h'], [11_600, 'about 3 h'], [16_200, 'about 4 h 30 min'], [86_400, 'about 24 h'],
  ];
  for (const [seconds, expected] of cases) assert.equal(roughly(seconds), expected, `${seconds} s`);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(roughly(bad), 'a while');
});

test('a video fits when listening to it is expected to take at most nine tenths of the time allowed', () => {
  assert.equal(LISTENING_SHARE_OF_LIMIT, 0.9);
  const speeds: Speeds = { listen: 2 };
  assert.deepEqual(listeningVerdict(450, speeds, 1000), { fits: true }, 'exactly nine tenths fits: fifteen windows at 60 s each');
  assert.deepEqual(listeningVerdict(451, speeds, 1000), { fits: true }, 'a tail of one second is not listened to');
  const tooLong = listeningVerdict(452, speeds, 1000);
  assert.ok(tooLong && !tooLong.fits);
  near(tooLong.listenSeconds, 960); near(tooLong.longestSeconds, 450);
  // A server as slow as 3.4 seconds for each second of a window, one hour allowed: 31 windows fit.
  assert.deepEqual(listeningVerdict(930, { listen: 3.4 }, 3600), { fits: true });
  assert.deepEqual(listeningVerdict(931, { listen: 3.4 }, 3600), { fits: true });
  const over = listeningVerdict(932, { listen: 3.4 }, 3600); assert.ok(over && !over.fits); near(over.longestSeconds, 930); near(over.listenSeconds, 3.4 * 960);
});

test('the longest video that can be listened to is a whole number of windows, and never less than one: a server must always be able to finish a short video, or it could never find out that it got quicker', () => {
  assert.equal(longestListenable({ listen: 3.4 }, 3600), 930);
  assert.equal(longestListenable({ listen: 2 }, 1000), 450);
  assert.equal(longestListenable({ listen: 100 }, 3600), 30, 'one window of 30 s costs 3000 s, which is within nine tenths of the hour');
  assert.equal(longestListenable({ listen: 150 }, 3600), 30, 'one window costs 4500 s, more than the time allowed, and one window is still taken');
  assert.deepEqual(listeningVerdict(31, { listen: 150 }, 3600), { fits: true }, 'so a video of one window is never turned away for its length');
  const second = listeningVerdict(32, { listen: 150 }, 3600); assert.ok(second && !second.fits); assert.equal(second.longestSeconds, 30);
  assert.equal(longestListenable({}, 3600), undefined); assert.equal(longestListenable({ listen: 0 }, 3600), undefined);
  assert.equal(longestListenable({ listen: 3.4 }, 0), undefined); assert.equal(longestListenable({ listen: 3.4 }, Number.NaN), undefined);
  for (const limit of [600, 1800, 3600, 7200]) for (const listen of [0.5, 1.2, 3.4, 9]) {
    const longest = longestListenable({ listen }, limit)!;
    assert.equal(longest % 30, 0);
    assert.ok(listen * longest <= limit * LISTENING_SHARE_OF_LIMIT + 1e-9, 'what fits does fit');
    assert.ok(listen * (longest + 30) > limit * LISTENING_SHARE_OF_LIMIT - 1e-9, 'and one window more would not');
  }
});

test('nothing is said against a video when the speed of listening, the limit or the length is not known', () => {
  assert.equal(listeningVerdict(900, {}, 3600), undefined);
  assert.equal(listeningVerdict(900, { listen: 0 }, 3600), undefined);
  assert.equal(listeningVerdict(900, { listen: 3.4 }, 0), undefined);
  assert.equal(listeningVerdict(900, { listen: 3.4 }, Number.NaN), undefined);
  assert.equal(listeningVerdict(0, { listen: 3.4 }, 3600), undefined);
});
