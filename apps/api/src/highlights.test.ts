import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { StudioDatabase } from './database.js';
import type { TranscriptSegment, VideoJob } from './domain.js';
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
    const now = new Date().toISOString(); const job: VideoJob = { id: 'job', originalFilename: 'video.mp4', storedFilename: 'video.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'processing', stage: 'detecting_highlights', errorMessage: null, durationSeconds: 30, width: null, height: null, createdAt: now, updatedAt: now }; await db.createJob(job);
    await db.replaceHighlights(job.id, [{ startSeconds: 10, endSeconds: 20, score: 90, quality: 'high', reasons: ['numeric detail'], signals: {}, sourceSegmentIndexes: [1] }, { startSeconds: 0, endSeconds: 10, score: 50, quality: 'medium', reasons: [], signals: {}, sourceSegmentIndexes: [0] }]);
    assert.deepEqual((await db.listHighlights(job.id)).map((candidate) => candidate.score), [90, 50]);
  } finally { await db.close({ dropSchema: true }); }
});
