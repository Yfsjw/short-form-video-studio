import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { StudioDatabase } from './database.js';
import type { GeneratedClip, NewVideoJob } from './domain.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';
const schemaName = (label: string) => `test_${label}_${randomUUID().replaceAll('-', '_')}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const makeJob = (id: string, status: NewVideoJob['status'], updatedAt = new Date().toISOString()): NewVideoJob => ({ id, originalFilename: 'v.mp4', storedFilename: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 1, status, stage: status, errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: updatedAt, updatedAt });
const makeClip = (id: string, jobId: string): GeneratedClip => { const now = new Date().toISOString(); return { id, jobId, candidateId: 'c', startSeconds: 0, endSeconds: 5, durationSeconds: 5, outputPath: `${jobId}/${id}.mp4`, outputFilename: `${id}.mp4`, status: 'completed', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now }; };

async function withDatabase(label: string, work: (db: StudioDatabase) => Promise<void>) {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, schemaName(label));
  try { await work(db); } finally { await db.close({ dropSchema: true }); }
}

test('a new job starts with no durable copy of its video and zero attempts; both can be recorded', () => withDatabase('job_fields', async (db) => {
  await db.createJob(makeJob('j1', 'queued'));
  const fresh = await db.getJob('j1');
  assert.equal(fresh?.sourceStorageKey, null);
  assert.equal(fresh?.attempts, 0);

  await db.updateJob('j1', { sourceStorageKey: 'sources/j1/source.mp4' });
  assert.equal((await db.getJob('j1'))?.sourceStorageKey, 'sources/j1/source.mp4');

  assert.equal(await db.beginAttempt('j1'), 1);
  assert.equal(await db.beginAttempt('j1'), 2);
  assert.equal((await db.getJob('j1'))?.attempts, 2);
}));

test('upgrades a database created before durable sources existed, keeping its jobs', async () => {
  const schema = schemaName('migrate');
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    // The table exactly as the first production release created it: no source_storage_key, no attempts.
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".video_jobs (
      id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL, size_bytes BIGINT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
      error_message TEXT, duration_seconds DOUBLE PRECISION, width INTEGER, height INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const now = new Date().toISOString();
    await admin.query(`INSERT INTO "${schema}".video_jobs VALUES ('old','a.mp4','b.mp4','video/mp4',5,'completed','done',NULL,NULL,NULL,NULL,$1,$1)`, [now]);

    for (let boot = 1; boot <= 2; boot += 1) { // booting twice proves the migration is idempotent
      const db = await StudioDatabase.connect(TEST_DATABASE_URL, schema);
      try {
        const job = await db.getJob('old');
        assert.equal(job?.status, 'completed');
        assert.equal(job?.sourceStorageKey, null);
        assert.equal(job?.attempts, 0);
        await db.createJob(makeJob(`new-${boot}`, 'queued'));
        assert.equal((await db.getJob(`new-${boot}`))?.attempts, 0);
      } finally { await db.close(); }
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test('lists only unfinished jobs, oldest first', () => withDatabase('unfinished', async (db) => {
  await db.createJob(makeJob('b-processing', 'processing', minutesAgo(1)));
  await db.createJob(makeJob('a-queued', 'queued', minutesAgo(5)));
  await db.createJob(makeJob('c-completed', 'completed'));
  await db.createJob(makeJob('d-failed', 'failed'));
  assert.deepEqual((await db.listUnfinishedJobs()).map((job) => job.id), ['a-queued', 'b-processing']);
}));

test('the heartbeat refreshes unfinished jobs and leaves finished ones alone', () => withDatabase('heartbeat', async (db) => {
  const tenMinutesAgo = minutesAgo(10);
  await db.createJob(makeJob('running', 'processing', tenMinutesAgo));
  await db.createJob(makeJob('done', 'completed', tenMinutesAgo));
  await db.touchJob('running');
  await db.touchJob('done');
  assert.ok((await db.getJob('running'))!.updatedAt > tenMinutesAgo, 'a running job must get a fresh timestamp');
  assert.equal((await db.getJob('done'))?.updatedAt, tenMinutesAgo, 'a finished job must keep the timestamp it had');
}));

test('only a job nobody has touched since the cut-off can be taken over, and only once', () => withDatabase('claim', async (db) => {
  const staleBefore = minutesAgo(1);
  await db.createJob(makeJob('abandoned', 'processing', minutesAgo(10)));
  await db.createJob(makeJob('abandoned-queued', 'queued', minutesAgo(10)));
  await db.createJob(makeJob('alive', 'processing', new Date().toISOString()));
  await db.createJob(makeJob('finished', 'completed', minutesAgo(10)));

  assert.equal(await db.claimJobForRecovery('abandoned', staleBefore), true);
  assert.equal(await db.claimJobForRecovery('abandoned', staleBefore), false, 'a second server must not take the same job again');
  assert.equal(await db.claimJobForRecovery('abandoned-queued', staleBefore), true);
  assert.equal(await db.claimJobForRecovery('alive', staleBefore), false);
  assert.equal(await db.claimJobForRecovery('finished', staleBefore), false);

  const claimed = await db.getJob('abandoned');
  assert.equal(claimed?.status, 'queued');
  assert.equal(claimed?.errorMessage, null);
  assert.equal((await db.getJob('alive'))?.status, 'processing');
  assert.equal((await db.getJob('finished'))?.status, 'completed');
}));

test('giving up on an abandoned job records the reason, but never touches a live or finished job', () => withDatabase('fail_stale', async (db) => {
  const staleBefore = minutesAgo(1);
  await db.createJob(makeJob('abandoned', 'processing', minutesAgo(10)));
  await db.createJob(makeJob('alive', 'processing', new Date().toISOString()));
  await db.createJob(makeJob('finished', 'completed', minutesAgo(10)));

  assert.equal(await db.failStaleJob('abandoned', staleBefore, 'because reasons'), true);
  assert.equal(await db.failStaleJob('alive', staleBefore, 'because reasons'), false);
  assert.equal(await db.failStaleJob('finished', staleBefore, 'because reasons'), false);

  const failed = await db.getJob('abandoned');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.stage, 'failed');
  assert.equal(failed?.errorMessage, 'because reasons');
  assert.equal((await db.getJob('alive'))?.status, 'processing');
  assert.equal((await db.getJob('finished'))?.status, 'completed');
}));

test('deleting a job\'s clips returns them (so their files can be removed) and spares other jobs', () => withDatabase('delete_clips', async (db) => {
  await db.createJob(makeJob('j1', 'processing'));
  await db.createJob(makeJob('j2', 'processing'));
  await db.createClip(makeClip('c1', 'j1'));
  await db.createClip(makeClip('c2', 'j1'));
  await db.createClip(makeClip('c3', 'j2'));

  const removed = await db.deleteClipsForJob('j1');
  assert.deepEqual(removed.map((clip) => clip.id).sort(), ['c1', 'c2']);
  assert.deepEqual(removed.map((clip) => clip.outputPath).sort(), ['j1/c1.mp4', 'j1/c2.mp4']);
  assert.equal((await db.listClips('j1')).length, 0);
  assert.deepEqual((await db.listClips('j2')).map((clip) => clip.id), ['c3']);
  assert.deepEqual(await db.deleteClipsForJob('j1'), []);
}));
