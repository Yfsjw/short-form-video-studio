import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Pool } from 'pg';
import { StudioDatabase } from './database.js';
import type { NewVideoJob } from './domain.js';
import { VideoPipeline, type PipelineRuntimeOptions } from './pipeline.js';
import { NullStorage, type DurableStorage } from './storage.js';
import { MemoryStorage, eventually, sleep } from './test-support.js';
import type { TranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector } from './highlights.js';
import type { ClipRenderer } from './clips.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';
const VIDEO = 'pretend these are the bytes of an uploaded video';

const fakeMedia = { probe: async () => ({ durationSeconds: 6, width: 1920, height: 1080 }), extractAudio: async (_input: string, output: string) => { await writeFile(output, 'mock wav'); } };
const speech: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Adapter-provided transcript.' }] };
const writingRenderer: ClipRenderer = { render: async (request) => { await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
const highlightOptions = { minDurationSeconds: 1, maxDurationSeconds: 10, maxCandidates: 3, overlapThreshold: 0.65, weights: { density: 1 } };
const fastRuntime: PipelineRuntimeOptions = { concurrency: 1, staleAfterMs: 1000, heartbeatMs: 50, recheckMs: 100, maxAttempts: 3 };

type Context = Awaited<ReturnType<typeof setup>>;

/** Wraps the database so that every call fails for as long as `isDown()` says so, like a real outage. */
function unreachableWhile(isDown: () => boolean, db: StudioDatabase): StudioDatabase {
  return new Proxy(db, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => (isDown() ? Promise.reject(new Error('database is down')) : value.apply(target, args));
  } });
}

async function setup(options: { storage?: DurableStorage; transcriber?: TranscriptionEngine; renderer?: ClipRenderer; runtime?: Partial<PipelineRuntimeOptions>; database?: (db: StudioDatabase) => StudioDatabase } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-pipeline-'));
  const uploadDir = join(root, 'uploads'); const tempDir = join(root, 'tmp'); const outputDir = join(root, 'outputs');
  await Promise.all([mkdir(uploadDir), mkdir(tempDir), mkdir(outputDir)]);
  const schema = `test_pipe_${randomUUID().replaceAll('-', '_')}`;
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, schema);
  const raw = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
  const storage = options.storage ?? new MemoryStorage();
  const errors: string[] = [];
  const logger = { info: () => undefined, error: (_fields: unknown, message?: string) => { errors.push(String(message)); } };
  const pipelines: VideoPipeline[] = [];
  const makePipeline = () => {
    const pipeline = new VideoPipeline(options.database ? options.database(db) : db, fakeMedia, options.transcriber ?? speech, new DeterministicHighlightDetector(), highlightOptions, options.renderer ?? writingRenderer, 1, uploadDir, tempDir, outputDir, logger, storage, { ...fastRuntime, ...options.runtime });
    pipelines.push(pipeline);
    return pipeline;
  };
  return {
    root, uploadDir, tempDir, outputDir, db, storage, errors, makePipeline, pipeline: makePipeline(),
    /** Pretend nothing has touched this job for a while, as if the process working on it had died. */
    backdate: async (id: string, minutes: number) => { await raw.query('UPDATE video_jobs SET updated_at = $1 WHERE id = $2', [new Date(Date.now() - minutes * 60_000).toISOString(), id]); },
    cleanup: async () => { for (const pipeline of pipelines) pipeline.close(); await raw.end(); await db.close({ dropSchema: true }); await rm(root, { recursive: true, force: true }); },
  };
}

async function addJob(ctx: Context, id: string, overrides: { status?: NewVideoJob['status']; local?: boolean; durable?: boolean; attempts?: number } = {}) {
  const now = new Date().toISOString();
  const storedFilename = `${id}.mp4`;
  await ctx.db.createJob({ id, originalFilename: 'talk.mp4', storedFilename, mimeType: 'video/mp4', sizeBytes: Buffer.byteLength(VIDEO), status: overrides.status ?? 'queued', stage: overrides.status ?? 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now });
  if (overrides.local ?? true) await writeFile(join(ctx.uploadDir, storedFilename), VIDEO);
  if (overrides.durable) {
    const key = `sources/${id}/source.mp4`;
    (ctx.storage as MemoryStorage).objects.set(key, Buffer.from(VIDEO));
    await ctx.db.updateJob(id, { sourceStorageKey: key });
  }
  for (let attempt = 0; attempt < (overrides.attempts ?? 0); attempt += 1) await ctx.db.beginAttempt(id);
}

async function waitUntil(description: string, condition: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${description}`);
    await sleep(10);
  }
}

/** A job's status reads "completed" a moment before its clean-up has finished; this waits for everything. */
const untilSettled = (ctx: Context) => eventually('the pipeline to finish with the job, clean-up included', () => ctx.pipeline.activeJobCount, (count) => count === 0);

async function waitForStatus(ctx: Context, id: string, statuses: string[], timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await ctx.db.getJob(id);
    if (job && statuses.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} never reached ${statuses.join(' or ')} (last seen: ${job?.status} / ${job?.stage})`);
    await sleep(25);
  }
}

test('saves the uploaded video to durable storage first, then frees the local copies once the job is done', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j1');
    await ctx.pipeline.run('j1');

    const job = await ctx.db.getJob('j1');
    assert.equal(job?.status, 'completed');
    assert.equal(job?.attempts, 1);
    const storage = ctx.storage as MemoryStorage;
    assert.equal(storage.uploaded.get('sources/j1/source.mp4')?.toString(), VIDEO, 'the video must have been saved to durable storage, complete');

    const clips = await ctx.db.listClips('j1');
    assert.equal(clips.length, 1);
    assert.equal(clips[0].status, 'completed');
    assert.ok(storage.objects.has(clips[0].outputPath), 'the finished clip must be in durable storage');

    const uploads = storage.log.filter((entry) => entry.startsWith('upload:'));
    assert.equal(uploads[0], 'upload:sources/j1/source.mp4', 'the source must be saved before anything is rendered');
    assert.ok(storage.log.indexOf('delete:sources/j1/source.mp4') > storage.log.lastIndexOf(`upload:${clips[0].outputPath}`), 'the stored video is deleted only after the clips are safe');
    assert.equal(storage.objects.has('sources/j1/source.mp4'), false, 'a finished job no longer needs the stored copy of its video');
    assert.equal(job?.sourceStorageKey, null, 'nothing may point at the deleted copy');
    assert.deepEqual(await readdir(ctx.uploadDir), [], 'local copy of the upload should be gone');
    assert.deepEqual(await readdir(ctx.outputDir), [], 'local copies of the clips should be gone');
  } finally { await ctx.cleanup(); }
});

test('without durable storage (local development) the job still completes and keeps its local files', async () => {
  const ctx = await setup({ storage: new NullStorage() });
  try {
    await addJob(ctx, 'j1');
    await ctx.pipeline.run('j1');
    const job = await ctx.db.getJob('j1');
    assert.equal(job?.status, 'completed');
    assert.equal(job?.sourceStorageKey, null);
    assert.deepEqual(await readdir(ctx.uploadDir), ['j1.mp4']);
    assert.deepEqual(await readdir(ctx.outputDir), ['j1']);
  } finally { await ctx.cleanup(); }
});

test('fails the job immediately, with the reason, when the video cannot be saved durably', async () => {
  let transcribed = false;
  const ctx = await setup({ transcriber: { transcribe: async () => { transcribed = true; return []; } } });
  try {
    (ctx.storage as MemoryStorage).failUploads = true;
    await addJob(ctx, 'j1');
    await ctx.pipeline.run('j1');
    const job = await ctx.db.getJob('j1');
    assert.equal(job?.status, 'failed');
    assert.match(job?.errorMessage ?? '', /simulated storage outage/);
    assert.equal(job?.sourceStorageKey, null);
    assert.equal(transcribed, false, 'no CPU should be spent on a video that is not safe');
    assert.equal((await ctx.db.listClips('j1')).length, 0);
  } finally { await ctx.cleanup(); }
});

test('after a restart the job resumes from the durable copy even though the disk is empty, and replaces the old half-made clips', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j2', { status: 'processing', local: false, durable: true, attempts: 1 });
    const now = new Date().toISOString();
    await ctx.db.createClip({ id: 'old-clip', jobId: 'j2', candidateId: 'c', startSeconds: 0, endSeconds: 2, durationSeconds: 2, outputPath: 'j2/old-clip.mp4', outputFilename: 'old-clip.mp4', status: 'processing', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now });
    const storage = ctx.storage as MemoryStorage;
    storage.objects.set('j2/old-clip.mp4', Buffer.from('half-made'));
    storage.objects.set('j2/old-clip.srt', Buffer.from('half-made captions'));
    await ctx.backdate('j2', 10); // the process that was working on it died ten minutes ago

    const summary = await ctx.pipeline.recoverInterruptedJobs();
    assert.deepEqual(summary, { resumed: ['j2'], failed: [], waiting: 0 });

    const job = await waitForStatus(ctx, 'j2', ['completed', 'failed']);
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal(job.attempts, 2);
    await untilSettled(ctx);
    assert.ok(storage.log.includes('download:sources/j2/source.mp4'), 'the video must have been restored from durable storage');
    assert.equal(storage.objects.has('sources/j2/source.mp4'), false, 'the resumed job is over, so its stored video is deleted');
    assert.deepEqual(await readdir(ctx.uploadDir), [], 'the video restored to the disk is scratch space and must be cleaned up');
    const clips = await ctx.db.listClips('j2');
    assert.equal(clips.length, 1);
    assert.notEqual(clips[0].id, 'old-clip');
    assert.equal(clips[0].status, 'completed');
    assert.ok(storage.log.includes('delete:j2/old-clip.mp4') && storage.log.includes('delete:j2/old-clip.srt'), 'leftovers of the interrupted attempt must be deleted from storage');
    assert.equal(storage.objects.has('j2/old-clip.mp4'), false);
  } finally { await ctx.cleanup(); }
});

test('does not pretend to resume a job whose video was never saved: it fails with an honest reason', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j3', { status: 'processing', local: false, attempts: 1 });
    await ctx.backdate('j3', 10);
    const summary = await ctx.pipeline.recoverInterruptedJobs();
    assert.deepEqual(summary, { resumed: [], failed: ['j3'], waiting: 0 });
    const job = await ctx.db.getJob('j3');
    assert.equal(job?.status, 'failed');
    assert.match(job?.errorMessage ?? '', /before the uploaded video was saved to durable storage/);
    assert.equal((ctx.storage as MemoryStorage).log.some((entry) => entry.startsWith('download:')), false);
  } finally { await ctx.cleanup(); }
});

test('gives up on a job that keeps being interrupted instead of crash-looping forever', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j4', { status: 'processing', local: false, durable: true, attempts: 3 });
    await ctx.backdate('j4', 10);
    const summary = await ctx.pipeline.recoverInterruptedJobs();
    assert.deepEqual(summary, { resumed: [], failed: ['j4'], waiting: 0 });
    const job = await ctx.db.getJob('j4');
    assert.equal(job?.status, 'failed');
    assert.match(job?.errorMessage ?? '', /interrupted 3 times/);
  } finally { await ctx.cleanup(); }
});

test('leaves a job alone while it still seems to be owned by a live process, and picks it up once that process goes quiet', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j5', { status: 'processing', local: false, durable: true, attempts: 1 }); // touched just now
    const summary = await ctx.pipeline.recoverInterruptedJobs();
    assert.deepEqual(summary, { resumed: [], failed: [], waiting: 1 });
    assert.equal((await ctx.db.getJob('j5'))?.status, 'processing');

    // Nobody refreshes the job any more (its owner died), so the periodic re-check takes it over after the staleness window.
    const job = await waitForStatus(ctx, 'j5', ['completed', 'failed'], 10_000);
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal(job.attempts, 2);
  } finally { await ctx.cleanup(); }
});

test('a running job keeps refreshing its heartbeat, so it is never mistaken for an abandoned one', async () => {
  let before = ''; let during = '';
  // eslint-disable-next-line prefer-const
  let ctx: Context;
  const slow: TranscriptionEngine = { transcribe: async () => {
    before = (await ctx.db.getJob('j6'))!.updatedAt;
    await sleep(400); // no stage changes happen meanwhile; only the heartbeat can move the timestamp
    during = (await ctx.db.getJob('j6'))!.updatedAt;
    return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'slow words' }];
  } };
  ctx = await setup({ transcriber: slow });
  try {
    await addJob(ctx, 'j6');
    await ctx.pipeline.run('j6');
    assert.ok(during > before, `heartbeat did not advance updatedAt (${before} -> ${during})`);
    assert.equal((await ctx.db.getJob('j6'))?.status, 'completed');
  } finally { await ctx.cleanup(); }
});

test('runs only as many jobs at once as allowed, yet every video is already safe while it waits its turn', async () => {
  let running = 0; let mostAtOnce = 0; let snapshot: { status?: string; stage?: string; saved: boolean } | undefined;
  // eslint-disable-next-line prefer-const
  let ctx: Context;
  const watching: TranscriptionEngine = { transcribe: async (_audio, workDir) => {
    running += 1; mostAtOnce = Math.max(mostAtOnce, running);
    if (!snapshot) {
      const other = basename(workDir).startsWith('j-a-') ? 'j-b' : 'j-a';
      await sleep(200);
      const waiting = await ctx.db.getJob(other);
      snapshot = { status: waiting?.status, stage: waiting?.stage, saved: (ctx.storage as MemoryStorage).objects.has(`sources/${other}/source.mp4`) };
    } else await sleep(20);
    running -= 1;
    return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'words' }];
  } };
  ctx = await setup({ transcriber: watching });
  try {
    await addJob(ctx, 'j-a');
    await addJob(ctx, 'j-b');
    await Promise.all([ctx.pipeline.run('j-a'), ctx.pipeline.run('j-b')]);
    assert.equal(mostAtOnce, 1, 'two jobs were in the heavy stages at the same time');
    assert.deepEqual(snapshot, { status: 'queued', stage: 'waiting_for_capacity', saved: true });
    assert.equal((await ctx.db.getJob('j-a'))?.status, 'completed');
    assert.equal((await ctx.db.getJob('j-b'))?.status, 'completed');
  } finally { await ctx.cleanup(); }
});

test('two servers looking for abandoned jobs at the same moment resume each job only once', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j7', { status: 'processing', local: false, durable: true, attempts: 1 });
    await ctx.backdate('j7', 10);
    const [first, second] = await Promise.all([ctx.pipeline.recoverInterruptedJobs(), ctx.makePipeline().recoverInterruptedJobs()]);
    assert.equal(first.resumed.length + second.resumed.length, 1);
    const job = await waitForStatus(ctx, 'j7', ['completed', 'failed']);
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal(job.attempts, 2, 'the job must have been started exactly once more');
  } finally { await ctx.cleanup(); }
});

test('in local development a stale job is resumed from the file still on disk', async () => {
  const ctx = await setup({ storage: new NullStorage() });
  try {
    await addJob(ctx, 'j8', { status: 'queued', local: true });
    await ctx.backdate('j8', 10);
    const summary = await ctx.pipeline.recoverInterruptedJobs();
    assert.deepEqual(summary, { resumed: ['j8'], failed: [], waiting: 0 });
    assert.equal((await waitForStatus(ctx, 'j8', ['completed', 'failed'])).status, 'completed');
  } finally { await ctx.cleanup(); }
});

test('a video restored with the wrong size is rejected rather than processed', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j9', { status: 'processing', local: false, durable: true, attempts: 1 });
    (ctx.storage as MemoryStorage).objects.set('sources/j9/source.mp4', Buffer.from('truncated'));
    await ctx.backdate('j9', 10);
    await ctx.pipeline.recoverInterruptedJobs();
    const job = await waitForStatus(ctx, 'j9', ['completed', 'failed']);
    assert.equal(job.status, 'failed');
    assert.match(job.errorMessage ?? '', /restored from durable storage has 9 bytes/);
  } finally { await ctx.cleanup(); }
});

test('a failing job reports why and still frees its local copies', async () => {
  const ctx = await setup({ renderer: { render: async () => { throw new Error('ffmpeg exploded'); } } });
  try {
    await addJob(ctx, 'j10');
    await ctx.pipeline.run('j10');
    const job = await ctx.db.getJob('j10');
    assert.equal(job?.status, 'failed');
    assert.match(job?.errorMessage ?? '', /Clip extraction failed for all 1/);
    assert.deepEqual(await readdir(ctx.uploadDir), []);
  } finally { await ctx.cleanup(); }
});

test('enqueue never lets a database failure escape as an unhandled rejection (which would crash the whole server)', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  const logged: string[] = [];
  try {
    const brokenDatabase = new Proxy({}, { get: () => async () => { throw new Error('database is down'); } });
    const pipeline = new VideoPipeline(brokenDatabase as never, fakeMedia, speech, new DeterministicHighlightDetector(), highlightOptions, writingRenderer, 1, tmpdir(), tmpdir(), tmpdir(), { info: () => undefined, error: (_fields: unknown, message?: string) => { logged.push(String(message)); } }, new MemoryStorage());
    pipeline.enqueue('whatever');
    await sleep(100);
    pipeline.close();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(logged, ['Unexpected error while processing job']);
  } finally { process.off('unhandledRejection', record); }
});

test('a job whose failure could not even be written down (database outage) is picked up again instead of staying stuck forever', async () => {
  let outage = false; let calls = 0;
  const unlucky: TranscriptionEngine = { transcribe: async () => {
    calls += 1;
    if (calls === 1) { outage = true; throw new Error('the server ran into trouble'); } // fails at the very moment the database goes away
    return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'second time lucky' }];
  } };
  const ctx = await setup({ transcriber: unlucky, database: (db) => unreachableWhile(() => outage, db) });
  try {
    await addJob(ctx, 'j11');
    ctx.pipeline.enqueue('j11');
    await waitUntil('the first attempt has ended without being able to record why', () => ctx.errors.includes('Unexpected error while processing job'));
    outage = false; // the database is back
    assert.equal((await ctx.db.getJob('j11'))?.status, 'processing', 'the failure could not be recorded, so the job still looks unfinished');
    assert.ok((ctx.storage as MemoryStorage).objects.has('sources/j11/source.mp4'), 'a job that will be resumed must keep its stored video');

    const job = await waitForStatus(ctx, 'j11', ['completed', 'failed'], 10_000);
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal(job.attempts, 2);
  } finally { await ctx.cleanup(); }
});

test('a job that fails for good no longer needs its stored video either, so that is deleted too', async () => {
  const ctx = await setup({ renderer: { render: async () => { throw new Error('ffmpeg exploded'); } } });
  try {
    await addJob(ctx, 'j12');
    await ctx.pipeline.run('j12');
    const job = await ctx.db.getJob('j12');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.sourceStorageKey, null);
    const storage = ctx.storage as MemoryStorage;
    assert.ok(storage.uploaded.has('sources/j12/source.mp4'), 'the video had been saved before the failure');
    assert.equal(storage.objects.has('sources/j12/source.mp4'), false);
  } finally { await ctx.cleanup(); }
});

test('when recovery gives up on a job it deletes the stored video as well', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j13', { status: 'processing', local: false, durable: true, attempts: 3 });
    await ctx.backdate('j13', 10);
    assert.deepEqual((await ctx.pipeline.recoverInterruptedJobs()).failed, ['j13']);
    assert.equal((await ctx.db.getJob('j13'))?.sourceStorageKey, null);
    assert.equal((ctx.storage as MemoryStorage).objects.has('sources/j13/source.mp4'), false);
  } finally { await ctx.cleanup(); }
});

test('being unable to delete the stored video never changes the outcome of a job', async () => {
  const ctx = await setup();
  try {
    (ctx.storage as MemoryStorage).failDeletes = true;
    await addJob(ctx, 'j14');
    await ctx.pipeline.run('j14');
    assert.equal((await ctx.db.getJob('j14'))?.status, 'completed');
    assert.ok(ctx.errors.includes('Could not delete the stored copy of the uploaded video'), 'the problem must be logged so it can be noticed');
  } finally { await ctx.cleanup(); }
});

test('a stored video that outlived its finished job is swept up the next time the server looks for interrupted jobs', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'done', { status: 'completed', local: false, durable: true });
    await addJob(ctx, 'gave-up', { status: 'failed', local: false, durable: true });
    await addJob(ctx, 'busy', { status: 'processing', local: false, durable: true, attempts: 1 }); // unfinished and recently touched: still someone's work
    const storage = ctx.storage as MemoryStorage;
    const summary = await ctx.pipeline.recoverInterruptedJobs();
    assert.deepEqual(summary, { resumed: [], failed: [], waiting: 1 });
    assert.equal(storage.objects.has('sources/done/source.mp4'), false);
    assert.equal(storage.objects.has('sources/gave-up/source.mp4'), false);
    assert.equal((await ctx.db.getJob('done'))?.sourceStorageKey, null);
    assert.equal((await ctx.db.getJob('gave-up'))?.sourceStorageKey, null);
    assert.equal(storage.objects.has('sources/busy/source.mp4'), true, 'the video of a job that is still being worked on must never be swept');
    assert.equal((await ctx.db.getJob('busy'))?.sourceStorageKey, 'sources/busy/source.mp4');
  } finally { await ctx.cleanup(); }
});

test('a storage outage while sweeping neither breaks recovery nor loses track of the leftover video', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'done', { status: 'completed', local: false, durable: true });
    (ctx.storage as MemoryStorage).failDeletes = true;
    await ctx.pipeline.recoverInterruptedJobs();
    assert.ok(ctx.errors.includes('Could not delete the stored copy of the uploaded video'));
    assert.equal((await ctx.db.getJob('done'))?.sourceStorageKey, 'sources/done/source.mp4', 'the job must still point at the video so the next sweep can retry');

    (ctx.storage as MemoryStorage).failDeletes = false;
    await ctx.pipeline.recoverInterruptedJobs();
    assert.equal((ctx.storage as MemoryStorage).objects.has('sources/done/source.mp4'), false);
    assert.equal((await ctx.db.getJob('done'))?.sourceStorageKey, null);
  } finally { await ctx.cleanup(); }
});

test('a video that was uploaded but never recorded on its job is deleted when that job is given up on', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'orphan', { status: 'processing', local: false, attempts: 1 }); // the key was never recorded and the disk is gone
    (ctx.storage as MemoryStorage).objects.set('sources/orphan/source.mp4', Buffer.from(VIDEO)); // ...but the upload itself had finished
    await ctx.backdate('orphan', 10);
    assert.deepEqual((await ctx.pipeline.recoverInterruptedJobs()).failed, ['orphan']);
    assert.equal((ctx.storage as MemoryStorage).objects.has('sources/orphan/source.mp4'), false);
  } finally { await ctx.cleanup(); }
});

test('when neither the failure nor the durable copy could be saved, the only copy of the video stays on the disk and the job is resumed from it', async () => {
  let outage = false; let uploads = 0;
  class FlakyStorage extends MemoryStorage {
    override async upload(localPath: string, key: string) {
      uploads += 1;
      if (uploads === 1) { outage = true; throw new Error('storage and database fail at the same moment'); }
      await super.upload(localPath, key);
    }
  }
  const ctx = await setup({ storage: new FlakyStorage(), database: (db) => unreachableWhile(() => outage, db) });
  try {
    await addJob(ctx, 'precious');
    ctx.pipeline.enqueue('precious');
    await waitUntil('the first attempt has ended without being able to record why', () => ctx.errors.includes('Unexpected error while processing job'));
    outage = false;
    assert.deepEqual(await readdir(ctx.uploadDir), ['precious.mp4'], 'the local file is the only copy of this video; it must not be deleted');

    const job = await waitForStatus(ctx, 'precious', ['completed', 'failed'], 10_000);
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal(job.attempts, 2);
    await untilSettled(ctx);
    assert.deepEqual(await readdir(ctx.uploadDir), [], 'once it is safe or finished, the scratch copy goes');
  } finally { await ctx.cleanup(); }
});

test('the pipeline can say how many jobs it is still working on, clean-up included', async () => {
  let during = -1;
  // eslint-disable-next-line prefer-const
  let ctx: Context;
  const peeking: TranscriptionEngine = { transcribe: async () => { during = ctx.pipeline.activeJobCount; return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'words' }]; } };
  ctx = await setup({ transcriber: peeking });
  try {
    await addJob(ctx, 'counted');
    assert.equal(ctx.pipeline.activeJobCount, 0);
    await ctx.pipeline.run('counted');
    assert.equal(during, 1, 'a job being transcribed is active');
    assert.equal(ctx.pipeline.activeJobCount, 0, 'a finished job is not');
  } finally { await ctx.cleanup(); }
});
