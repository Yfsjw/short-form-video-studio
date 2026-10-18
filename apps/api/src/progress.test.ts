import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration, StageClock, stageLabel, stageProgress, totalMilliseconds } from './progress.js';

test('progress only ever moves forward through the stages of a job, ending at 100 when it is done', () => {
  const order = ['queued', 'preparing_source', 'probing_video', 'extracting_audio', 'transcribing', 'detecting_highlights', 'extracting_clips', 'clip_extraction_complete'];
  const values = order.map((stage) => stageProgress(stage));
  assert.deepEqual(values, [...values].sort((a, b) => a - b), `not increasing: ${values}`);
  assert.equal(values[0], 0); assert.equal(values.at(-1), 100);
});

test('progress inside a long stage is spread over its range and kept inside it', () => {
  assert.equal(stageProgress('transcribing', 0), 10);
  assert.equal(stageProgress('transcribing', 0.5), 40);
  assert.equal(stageProgress('transcribing', 1), 70);
  assert.equal(stageProgress('transcribing', 7), 70, 'more than 100% counts as 100%');
  assert.equal(stageProgress('transcribing', -1), 10);
  assert.equal(stageProgress('transcribing', Number.NaN), 10);
  assert.equal(stageProgress('a stage from the future'), 0);
});

test('every stage has a readable name, and an unknown one is shown rather than hidden', () => {
  assert.equal(stageLabel('transcribing'), 'Listening to the speech');
  assert.equal(stageLabel('some_new_stage'), 'some new stage');
});

test('durations read like a person would say them', () => {
  assert.equal(formatDuration(400), '0 s');
  assert.equal(formatDuration(3_000), '3 s');
  assert.equal(formatDuration(252_000), '4 min 12 s');
  assert.equal(formatDuration(65_000), '1 min 05 s');
  assert.equal(formatDuration(3_900_000), '1 h 05 min');
  assert.equal(formatDuration(-5), '0 s');
});

test('the stage clock records every stage once it ends, and a stage entered twice adds up', () => {
  let now = 1_000;
  const clock = new StageClock(() => now);
  clock.enter('a'); now += 300;
  clock.enter('b'); now += 500;
  assert.deepEqual(clock.snapshot(), { a: 300 }, 'a stage that is still running is not in the snapshot');
  clock.enter('a'); now += 100;
  assert.deepEqual(clock.finish(), { a: 400, b: 500 });
  assert.equal(totalMilliseconds(clock.finish()), 900);
  assert.equal(totalMilliseconds({ a: Number.NaN, b: 5 }), 5);
});
