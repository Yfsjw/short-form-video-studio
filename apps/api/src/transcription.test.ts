import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioDatabase } from './database.js';
import type { VideoJob } from './domain.js';
import { VideoPipeline } from './pipeline.js';
import { NullStorage } from './storage.js';
import { parseWhisperCppJson, type TranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector } from './highlights.js';
import type { ClipRenderer } from './clips.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';

test('parses timestamped whisper.cpp JSON output', () => {
  const segments = parseWhisperCppJson(JSON.stringify({ transcription: [{ offsets: { from: 1250, to: 3750 }, text: ' A real timestamped segment. ' }] }));
  assert.deepEqual(segments, [{ segmentIndex: 0, startSeconds: 1.25, endSeconds: 3.75, text: 'A real timestamped segment.' }]);
});

test('stores and returns transcript segments in segment order', async () => {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, `test_transcript_${randomUUID().replaceAll('-', '_')}`);
  try {
    const now = new Date().toISOString(); const job: VideoJob = { id: 'job-1', originalFilename: 'source.mp4', storedFilename: 'source.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'processing', stage: 'transcribing', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
    await db.createJob(job); await db.replaceTranscript(job.id, [{ segmentIndex: 1, startSeconds: 2, endSeconds: 3, text: 'second' }, { segmentIndex: 0, startSeconds: 0, endSeconds: 1, text: 'first' }]);
    assert.deepEqual((await db.listTranscript(job.id)).map(({ segmentIndex, startSeconds, endSeconds, text }) => ({ segmentIndex, startSeconds, endSeconds, text })), [{ segmentIndex: 0, startSeconds: 0, endSeconds: 1, text: 'first' }, { segmentIndex: 1, startSeconds: 2, endSeconds: 3, text: 'second' }]);
  } finally { await db.close({ dropSchema: true }); }
});

test('pipeline integration persists mock-engine segments and cleans temporary audio', async () => {
  // This is intentionally a mocked adapter integration test, not an actual Whisper execution test.
  const root = await mkdtemp(join(tmpdir(), 'studio-pipeline-'));
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, `test_pipeline_${randomUUID().replaceAll('-', '_')}`);
  try {
    const now = new Date().toISOString(); const job: VideoJob = { id: 'job-2', originalFilename: 'source.mp4', storedFilename: 'source.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'queued', stage: 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now }; await db.createJob(job);
    const fakeMedia = { probe: async () => ({ durationSeconds: 6, width: 1920, height: 1080 }), extractAudio: async (_input: string, output: string) => { await writeFile(output, 'mock wav'); } };
    const mockTranscriber: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Adapter-provided transcript.' }] };
    const mockRenderer: ClipRenderer = { render: async () => ({ durationSeconds: 2, sizeBytes: 1 }) };
    const logger = { info: () => undefined, error: () => undefined };
    await new VideoPipeline(db, fakeMedia, mockTranscriber, new DeterministicHighlightDetector(), { minDurationSeconds: 1, maxDurationSeconds: 10, maxCandidates: 3, overlapThreshold: 0.65, weights: { density: 1 } }, mockRenderer, 1, root, root, root, logger, new NullStorage()).run(job.id);
    assert.equal((await db.getJob(job.id))?.status, 'completed'); assert.equal((await db.listTranscript(job.id))[0]?.text, 'Adapter-provided transcript.');
    assert.equal((await db.listClips(job.id))[0]?.candidateId.length, 36);
    assert.ok(!(await readdir(root)).some((entry) => entry.startsWith('job-2-')));
  } finally { await db.close({ dropSchema: true }); await rm(root, { recursive: true, force: true }); }
});
