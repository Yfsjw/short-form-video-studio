import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegClipRenderer, isSafeClipIdentifier, resolveClipOutputPath } from './clips.js';
import { StudioDatabase } from './database.js';
import type { GeneratedClip, VideoJob } from './domain.js';

test('persists candidate-to-clip mapping and lifecycle fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-clips-db-')); const db = new StudioDatabase(join(root, 'studio.db'));
  try {
    const now = new Date().toISOString(); const job: VideoJob = { id: 'job', originalFilename: 'source.mp4', storedFilename: 'source.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'processing', stage: 'extracting_clips', errorMessage: null, durationSeconds: 20, width: 1, height: 1, createdAt: now, updatedAt: now }; db.createJob(job);
    const clip: GeneratedClip = { id: 'clip', jobId: job.id, candidateId: 'candidate', startSeconds: 2, endSeconds: 8, durationSeconds: 6, outputPath: 'job/clip.mp4', outputFilename: 'clip.mp4', status: 'queued', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now }; db.createClip(clip); db.updateClip(clip.id, { status: 'processing' }); db.updateClip(clip.id, { status: 'completed' });
    const stored = db.getClip(job.id, clip.id); assert.equal(stored?.candidateId, 'candidate'); assert.equal(stored?.status, 'completed'); assert.equal(stored?.durationSeconds, 6);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('accepts only UUID clip and job identifiers for clip paths', () => {
  const id = '1bb34c49-c6eb-4a0c-b286-2cd154e34290';
  assert.ok(isSafeClipIdentifier(id)); assert.equal(isSafeClipIdentifier('../escape'), false); assert.equal(isSafeClipIdentifier('clip.mp4'), false);
  assert.equal(resolveClipOutputPath('/outputs', id, id, `${id}.mp4`), `/outputs/${id}/${id}.mp4`); assert.equal(resolveClipOutputPath('/outputs', id, id, '../escape.mp4'), undefined);
});

test('FFmpeg renderer builds a timestamped MP4 command with a mocked process', async () => {
  // This tests adapter command/validation behavior with a mocked process; it does not prove real FFmpeg extraction.
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-')); const outputPath = join(root, 'clip.mp4'); let arguments_: string[] = [];
  try {
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', async (_binary, args) => { arguments_ = args; await writeFile(outputPath, 'mock mp4 bytes'); });
    const rendered = await renderer.render({ sourcePath: join(root, 'source.mp4'), startSeconds: 12.5, endSeconds: 18.25, outputPath });
    assert.equal(rendered.durationSeconds, 5.75); assert.ok(rendered.sizeBytes > 0); assert.deepEqual(arguments_.slice(0, 8), ['-nostdin', '-y', '-i', join(root, 'source.mp4'), '-ss', '12.500', '-t', '5.750']); assert.ok(arguments_.includes('-movflags'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
