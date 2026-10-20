import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { StudioDatabase } from './database.js';
import type { TranscriptSegment, NewVideoJob } from './domain.js';
import { DeterministicHighlightDetector, type HighlightOptions } from './highlights.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';

// Deterministic fixture data representing timestamped local-transcription output; not AI output.
const segments = (items: Array<[number, number, string]>): TranscriptSegment[] => items.map(([startSeconds, endSeconds, text], segmentIndex) => ({ id: `s-${segmentIndex}`, jobId: 'job', segmentIndex, startSeconds, endSeconds, text, createdAt: '2026-01-01T00:00:00.000Z' }));
const options: HighlightOptions = { minDurationSeconds: 15, maxDurationSeconds: 40, maxCandidates: 3, overlapThreshold: 0.65, weights: { density: 0.25, emphasis: 0.2, question: 0.1, number: 0.1, contrast: 0.15, hook: 0.1, completeness: 0.1 } };

test('generates scored windows from actual contiguous transcript segments', () => {
  const candidates = new DeterministicHighlightDetector().detect({ segments: segments([[0, 8, 'Here is the surprising result: retention rose by 42 percent.'], [8, 18, 'But the key was changing the first three seconds.'], [18, 28, 'That simple change made the launch much more effective.']]), durationSeconds: 30, metadata: { width: 1920, height: 1080 }, options });
  const derivedWindow = candidates.find((candidate) => candidate.sourceSegmentIndexes.includes(0) && candidate.sourceSegmentIndexes.includes(1));
  assert.ok(candidates.length > 0); assert.ok(derivedWindow);
  if (!derivedWindow) return;
  assert.ok(derivedWindow.score > 0); assert.equal(derivedWindow.signals.number.value, 1); assert.equal(derivedWindow.signals.number.contribution, options.weights.number); assert.ok(derivedWindow.reasons.includes('numeric detail')); assert.ok(derivedWindow.reasons.includes('contrast or turning-point language'));
});

test('honors duration bounds and clamps source timestamps to video duration', () => {
  const candidates = new DeterministicHighlightDetector().detect({ segments: segments([[-2, 10, 'This opening has a complete thought.'], [10, 25, 'It closes at the real end of the video.']]), durationSeconds: 20, metadata: { width: null, height: null }, options: { ...options, minDurationSeconds: 10, maxDurationSeconds: 25 } });
  assert.ok(candidates.every((candidate) => candidate.startSeconds >= 0 && candidate.endSeconds <= 20));
  assert.ok(candidates.every((candidate) => candidate.endSeconds - candidate.startSeconds >= 10));
});

test('suppresses heavily overlapping windows while retaining ranked candidates', () => {
  const candidates = new DeterministicHighlightDetector().detect({ segments: segments([[0, 10, 'Here is an amazing first result with 10 percent growth.'], [10, 20, 'But the key is a surprising change in approach.'], [20, 30, 'This is an essential conclusion for every team.'], [30, 40, 'What if you repeated this process next week?']]), durationSeconds: 42, metadata: { width: null, height: null }, options: { ...options, minDurationSeconds: 15, maxDurationSeconds: 30, overlapThreshold: 0.5 } });
  for (let index = 0; index < candidates.length; index += 1) for (let other = index + 1; other < candidates.length; other += 1) { const a = candidates[index]; const b = candidates[other]; const overlap = Math.max(0, Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds)); assert.ok(overlap / Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds) < 0.5); }
});

test('persists highlight candidates in ranking order', async () => {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, `test_highlights_${randomUUID().replaceAll('-', '_')}`);
  try {
    const now = new Date().toISOString(); const job: NewVideoJob = { id: 'job', originalFilename: 'video.mp4', storedFilename: 'video.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'processing', stage: 'detecting_highlights', errorMessage: null, durationSeconds: 30, width: null, height: null, createdAt: now, updatedAt: now }; await db.createJob(job);
    await db.replaceHighlights(job.id, [{ startSeconds: 10, endSeconds: 20, score: 90, quality: 'high', reasons: ['numeric detail'], signals: {}, sourceSegmentIndexes: [1], title: null }, { startSeconds: 0, endSeconds: 10, score: 50, quality: 'medium', reasons: [], signals: {}, sourceSegmentIndexes: [0], title: null }]);
    assert.deepEqual((await db.listHighlights(job.id)).map((candidate) => candidate.score), [90, 50]);
  } finally { await db.close({ dropSchema: true }); }
});

const richWeights = { ...options.weights, standalone: 0.1, continuity: 0.1, length: 0.1 };
const detect = (items: Array<[number, number, string]>, overrides: Partial<HighlightOptions> = {}, durationSeconds = Math.max(...items.map((item) => item[1]))) =>
  new DeterministicHighlightDetector().detect({ segments: segments(items), durationSeconds, metadata: { width: null, height: null }, options: { ...options, weights: richWeights, ...overrides } });

test('a video shorter than the shortest clip still gets one clip made of all of its speech', () => {
  const found = detect([[1, 5, 'Quick question for you today.'], [5, 11, 'Does this tiny video still get a clip?']], { minDurationSeconds: 20 });
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].startSeconds, found[0].endSeconds], [1, 11]);
  assert.ok(found[0].reasons.some((reason) => /shorter than the shortest clip length/.test(reason)), 'it says why this clip is short');
  assert.deepEqual(detect([[0, 1.2, 'Hi.']], { minDurationSeconds: 20 }), [], 'a blink of speech is not a clip');
  assert.deepEqual(detect([], {}, 60), [], 'no speech, no clips');
});

test('speech that never reaches a sentence end is still cut into clips, and says the cut may fall mid-sentence', () => {
  const run = detect([[0, 10, 'we just keep talking without any full stop'], [10, 20, 'and the words keep coming and coming'], [20, 30, 'so there is never a place to stop'], [30, 42, 'until the very end of the recording']]);
  assert.ok(run.length >= 2, `only ${run.length} clip(s) from speech that could be cut in several places`);
  for (const candidate of run) {
    const length = candidate.endSeconds - candidate.startSeconds;
    assert.ok(length >= options.minDurationSeconds && length <= options.maxDurationSeconds, `${length} s is outside the allowed clip length`);
    // The end of the recording is a real end; any other cut was made without a sentence end to go by, and the clip says so.
    assert.equal(candidate.endSeconds === 42, !candidate.reasons.some((reason) => /middle of a sentence/.test(reason)));
  }
  for (let index = 0; index < run.length; index += 1) for (let other = index + 1; other < run.length; other += 1) {
    const overlap = Math.max(0, Math.min(run[index].endSeconds, run[other].endSeconds) - Math.max(run[index].startSeconds, run[other].startSeconds));
    assert.ok(overlap / Math.min(run[index].endSeconds - run[index].startSeconds, run[other].endSeconds - run[other].startSeconds) < options.overlapThreshold, 'top-up passages still obey the overlap limit');
  }
});

test('passages that end at a sentence end come first, and only the missing ones are filled in with passages that may end mid-sentence', () => {
  const unpunctuated = Array.from({ length: 9 }, (_, index): [number, number, string] => [index * 10, index * 10 + 10, `and the talk goes on through part ${index} without stopping`]);
  unpunctuated[8][2] += '.'; // the only sentence end is the last one
  const found = detect(unpunctuated, { maxCandidates: 3, overlapThreshold: 0.4 });
  assert.equal(found.length, 3, 'as many clips as asked for, since the recording is long enough');
  const flagged = found.map((candidate) => candidate.reasons.some((reason) => /middle of a sentence/.test(reason)));
  assert.deepEqual(flagged, [false, true, true], 'the one clip that ends at the sentence end comes first; the others say they may not');
  assert.equal(found[0].endSeconds, 90);
  const plenty = detect([[0, 9, 'One thought here.'], [9, 18, 'Another thought here.'], [18, 27, 'A third thought here.'], [27, 36, 'A fourth thought here.'], [36, 45, 'A fifth thought here.']], { maxCandidates: 2, overlapThreshold: 0.4 });
  assert.equal(plenty.length, 2);
  assert.ok(plenty.every((candidate) => candidate.reasons.every((reason) => !/middle of a sentence/.test(reason))), 'nothing is filled in when enough clean passages exist');
  const tooShortForMore = detect([[0, 40, 'A single long stretch of talk with no end in sight']], { maxCandidates: 3, overlapThreshold: 0.4 });
  assert.equal(tooShortForMore.length, 1, 'a clip is not repeated just to reach the number asked for');
});

test('each clip comes with a suggested title made of its own words', () => {
  const [best] = detect([[0, 9, 'So today I want to talk about something.'], [9, 20, 'Why do most channels stop growing after a year?'], [20, 31, 'The answer is consistency, plain and simple.']]);
  assert.ok(best.title);
  assert.equal(best.title, 'Why do most channels stop growing after a year?', 'the question reads most like a title');
});

test('a passage that starts with a lead-in such as "and so" scores lower on starting cleanly than one that starts a thought', () => {
  const clean = detect([[0, 16, 'Here is the whole story of the launch.'], [16, 30, 'It took three weeks.']]).find((candidate) => candidate.startSeconds === 0);
  const leadIn = detect([[0, 16, 'And so that is what happened then.'], [16, 30, 'It took three weeks.']]).find((candidate) => candidate.startSeconds === 0);
  assert.equal(clean?.signals.standalone.value, 1);
  assert.equal(leadIn?.signals.standalone.value, 0);
  assert.ok(clean && leadIn && clean.score > leadIn.score);
});

test('long silences inside a passage count against it', () => {
  const every = { overlapThreshold: 2, maxCandidates: 50 }; // no passage is dropped for resembling another: the two are compared as they are
  const talk = detect([[0, 9, 'Here is the first part of it.'], [9.2, 18, 'And here comes the second part.'], [18.2, 30, 'Then the third part follows.']], every).find((candidate) => candidate.startSeconds === 0 && candidate.endSeconds === 30);
  const gaps = detect([[0, 9, 'Here is the first part of it.'], [16, 24, 'And here comes the second part.'], [30, 37, 'Then the third part follows.']], every).find((candidate) => candidate.startSeconds === 0 && candidate.endSeconds === 37);
  assert.ok(talk && gaps);
  assert.ok(talk.signals.continuity.value > 0.9);
  assert.ok(gaps.signals.continuity.value < talk.signals.continuity.value / 2, 'a long silence between the parts');
});

test('with nothing else to tell passages apart, the length that suits short video wins over the very shortest and the very longest', () => {
  const even = Array.from({ length: 24 }, (_, index): [number, number, string] => [index * 5, index * 5 + 5, `Sentence number ${index} says one plain thing.`]);
  const [best] = detect(even, { minDurationSeconds: 20, maxDurationSeconds: 60, maxCandidates: 1 });
  assert.ok(best.endSeconds - best.startSeconds >= 40 && best.endSeconds - best.startSeconds <= 50, `expected about 44 s, got ${best.endSeconds - best.startSeconds}`);
});

test('passages that mostly repeat each other are not both offered', () => {
  const even = Array.from({ length: 24 }, (_, index): [number, number, string] => [index * 5, index * 5 + 5, `Sentence number ${index} says one plain thing.`]);
  const found = detect(even, { minDurationSeconds: 20, maxDurationSeconds: 40, maxCandidates: 4, overlapThreshold: 0.3 });
  for (let index = 0; index < found.length; index += 1) for (let other = index + 1; other < found.length; other += 1) {
    const overlap = Math.max(0, Math.min(found[index].endSeconds, found[other].endSeconds) - Math.max(found[index].startSeconds, found[other].startSeconds));
    assert.ok(overlap / Math.min(found[index].endSeconds - found[index].startSeconds, found[other].endSeconds - found[other].startSeconds) < 0.3);
  }
});
