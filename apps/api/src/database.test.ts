import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { StudioDatabase } from './database.js';
import type { VideoJob } from './domain.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';

test('reapStuckJobs marks queued/processing jobs failed with a clear reason, leaves completed/failed alone', async () => {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, `test_reap_${randomUUID().replaceAll('-', '_')}`);
  try {
    const now = new Date().toISOString();
    const make = (id: string, status: VideoJob['status']): VideoJob => ({ id, originalFilename: 'v.mp4', storedFilename: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 1, status, stage: status, errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now });
    await db.createJob(make('j-queued', 'queued'));
    await db.createJob(make('j-processing', 'processing'));
    await db.createJob(make('j-completed', 'completed'));
    await db.createJob(make('j-failed', 'failed'));

    const reapedCount = await db.reapStuckJobs();
    assert.equal(reapedCount, 2);

    assert.equal((await db.getJob('j-queued'))?.status, 'failed');
    assert.equal((await db.getJob('j-processing'))?.status, 'failed');
    assert.match((await db.getJob('j-processing'))?.errorMessage ?? '', /interrupted by a server restart/);
    assert.equal((await db.getJob('j-completed'))?.status, 'completed');
    assert.equal((await db.getJob('j-failed'))?.status, 'failed');
  } finally { await db.close({ dropSchema: true }); }
});
