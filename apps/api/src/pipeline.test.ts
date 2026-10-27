import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Pool } from 'pg';
import { StudioDatabase } from './database.js';
import { defaultJobOptions, type JobOptions, type NewVideoJob } from './domain.js';
import { VideoPipeline, type PipelineRuntimeOptions } from './pipeline.js';
import { NullStorage, type DurableStorage } from './storage.js';
import { MemoryStorage, eventually, sleep } from './test-support.js';
import type { TranscriptInput, TranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector } from './highlights.js';
import type { ClipRenderer, ClipRenderRequest } from './clips.js';
import type { ClipFramer } from './face-track.js';
import type { FramingPlan } from './framing.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';
const VIDEO = 'pretend these are the bytes of an uploaded video';

const fakeMedia = { probe: async () => ({ durationSeconds: 6, width: 1920, height: 1080 }), extractAudio: async (_input: string, output: string) => { await writeFile(output, 'mock wav'); } };
const speech: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Adapter-provided transcript.' }] };
const writingRenderer: ClipRenderer = { render: async (request) => { await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
const highlightOptions = { minDurationSeconds: 1, maxDurationSeconds: 10, maxCandidates: 3, overlapThreshold: 0.65, weights: { density: 1 } };
const fastRuntime: PipelineRuntimeOptions = { concurrency: 1, staleAfterMs: 1000, heartbeatMs: 50, recheckMs: 100, watchdogMs: 60_000, maxAttempts: 3 };

type Context = Awaited<ReturnType<typeof setup>>;
/** Waits for `promise`, but not for ever: a test of a lock that is never given back must fail, not hang. */
const within = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([promise, sleep(ms).then((): never => { throw new Error(what); })]);

/** Wraps the database so that every call fails for as long as `isDown()` says so, like a real outage. */
function unreachableWhile(isDown: () => boolean, db: StudioDatabase): StudioDatabase {
  return new Proxy(db, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => (isDown() ? Promise.reject(new Error('database is down')) : value.apply(target, args));
  } });
}

async function setup(options: { highlights?: Partial<typeof highlightOptions>; storage?: DurableStorage; transcriber?: TranscriptionEngine; renderer?: ClipRenderer; framer?: ClipFramer; runtime?: Partial<PipelineRuntimeOptions>; database?: (db: StudioDatabase) => StudioDatabase; media?: typeof fakeMedia } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-pipeline-'));
  const uploadDir = join(root, 'uploads'); const tempDir = join(root, 'tmp'); const outputDir = join(root, 'outputs');
  await Promise.all([mkdir(uploadDir), mkdir(tempDir), mkdir(outputDir)]);
  const schema = `test_pipe_${randomUUID().replaceAll('-', '_')}`;
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, schema);
  const raw = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
  const storage = options.storage ?? new MemoryStorage();
  const errors: string[] = [];
  /** What the pipeline said about itself at the information level (the fields it attached, and the sentence). */
  const infos: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const logger = { info: (fields: unknown, message?: string) => { infos.push({ fields: (fields && typeof fields === 'object' ? fields : {}) as Record<string, unknown>, message: String(message) }); }, error: (_fields: unknown, message?: string) => { errors.push(String(message)); } };
  const pipelines: VideoPipeline[] = [];
  const makePipeline = () => {
    const pipeline = new VideoPipeline(options.database ? options.database(db) : db, options.media ?? fakeMedia, options.transcriber ?? speech, new DeterministicHighlightDetector(), { ...highlightOptions, ...options.highlights }, options.renderer ?? writingRenderer, 1, uploadDir, tempDir, outputDir, logger, storage, { ...fastRuntime, ...options.runtime }, options.framer);
    pipelines.push(pipeline);
    return pipeline;
  };
  return {
    root, uploadDir, tempDir, outputDir, db, raw, storage, errors, infos, makePipeline, pipeline: makePipeline(),
    /** Pretend nothing has touched this job for a while, as if the process working on it had died. */
    backdate: async (id: string, minutes: number) => { await raw.query('UPDATE video_jobs SET updated_at = $1 WHERE id = $2', [new Date(Date.now() - minutes * 60_000).toISOString(), id]); },
    cleanup: async () => { for (const pipeline of pipelines) pipeline.close(); await raw.end(); await db.close({ dropSchema: true }); await rm(root, { recursive: true, force: true }); },
  };
}

async function addJob(ctx: Context, id: string, overrides: { status?: NewVideoJob['status']; local?: boolean; durable?: boolean; attempts?: number; options?: JobOptions } = {}) {
  const now = new Date().toISOString();
  const storedFilename = `${id}.mp4`;
  await ctx.db.createJob({ id, originalFilename: 'talk.mp4', storedFilename, mimeType: 'video/mp4', sizeBytes: Buffer.byteLength(VIDEO), status: overrides.status ?? 'queued', stage: overrides.status ?? 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now, options: overrides.options });
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
    await ctx.db.createClip({ id: 'old-clip', jobId: 'j2', candidateId: 'c', startSeconds: 0, endSeconds: 2, durationSeconds: 2, outputPath: 'j2/old-clip.mp4', outputFilename: 'old-clip.mp4', status: 'processing', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now, title: null, score: null, reasons: [], framing: null });
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

test('keeps looking even when nothing was waiting, so a job orphaned after the start-up check (the old instance of a redeploy) is still found', async () => {
  const ctx = await setup({ runtime: { watchdogMs: 100 } });
  try {
    assert.deepEqual(await ctx.pipeline.recoverInterruptedJobs(), { resumed: [], failed: [], waiting: 0 }, 'the start-up check finds nothing to do');
    // Afterwards another process accepts a job and is shut down before it can finish it.
    await addJob(ctx, 'late', { status: 'processing', local: false, durable: true, attempts: 1 });
    await ctx.backdate('late', 10);
    const job = await waitForStatus(ctx, 'late', ['completed', 'failed'], 10_000);
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal(job.attempts, 2);
  } finally { await ctx.cleanup(); }
});

test('the slow watchdog stops when the pipeline is closed, so nothing keeps polling a database that is shutting down', async () => {
  const ctx = await setup({ runtime: { watchdogMs: 50 } });
  try {
    await ctx.pipeline.recoverInterruptedJobs();
    ctx.pipeline.close();
    await addJob(ctx, 'ignored', { status: 'processing', local: false, durable: true, attempts: 1 });
    await ctx.backdate('ignored', 10);
    await sleep(400); // several watchdog periods
    assert.equal((await ctx.db.getJob('ignored'))?.status, 'processing', 'a closed pipeline must not take jobs over');
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

test('work that holds a place for the heavy stages (a check of the machine) is never done at the same time as a job: the job waits for it, its video already safe, and goes on when the work is over', async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const listening: TranscriptionEngine = { transcribe: async () => { order.push('the job is listened to'); return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'words' }]; } };
  const ctx = await setup({ transcriber: listening });
  try {
    await addJob(ctx, 'j-held');
    const work = ctx.pipeline.withCapacity(async () => { order.push('the work begins'); await held; order.push('the work ends'); return 'what the work found'; });
    const running = ctx.pipeline.run('j-held');
    await eventually('the job to say it is waiting for a place', async () => (await ctx.db.getJob('j-held'))?.stage, (stage) => stage === 'waiting_for_capacity');
    await sleep(150);
    const waiting = await ctx.db.getJob('j-held');
    assert.deepEqual({ status: waiting?.status, stage: waiting?.stage, saved: (ctx.storage as MemoryStorage).objects.has('sources/j-held/source.mp4') }, { status: 'queued', stage: 'waiting_for_capacity', saved: true });
    assert.deepEqual(order, ['the work begins'], 'the job was worked on while the place was held');
    release();
    assert.equal(await within(work, 5000, 'the work did not finish'), 'what the work found', 'what the work returns is passed on');
    await within(running, 5000, 'the job never got the place after the work');
    assert.deepEqual(order, ['the work begins', 'the work ends', 'the job is listened to']);
    assert.equal((await ctx.db.getJob('j-held'))?.status, 'completed');
  } finally { await ctx.cleanup(); }
});

test('work that needs a place waits for the job that has it, and a failure of the work is passed on and gives the place back', async () => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  let listening = false; const order: string[] = [];
  const slow: TranscriptionEngine = { transcribe: async () => { listening = true; await blocked; order.push('the job has listened'); return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'words' }]; } };
  const ctx = await setup({ transcriber: slow });
  try {
    await addJob(ctx, 'j-first'); await addJob(ctx, 'j-second');
    const running = ctx.pipeline.run('j-first');
    await eventually('the job to be listening', () => listening, (value) => value);
    const work = ctx.pipeline.withCapacity(async () => { order.push('the work begins'); throw new Error('the check broke'); });
    const outcome = assert.rejects(work, /the check broke/);
    await sleep(150);
    assert.deepEqual(order, [], 'the work began while a job had the place');
    release();
    await within(running, 5000, 'the job did not finish'); await within(outcome, 5000, 'the work never got the place after the job');
    assert.deepEqual(order, ['the job has listened', 'the work begins']);
    // The place was given back although the work failed: the next job is not kept waiting for ever.
    await within(ctx.pipeline.run('j-second'), 5000, 'the place was never given back');
    assert.equal((await ctx.db.getJob('j-second'))?.status, 'completed');
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

test('a stored video that cannot be read back right now neither fails the job nor costs the customer their only copy: the job is tried again later', async () => {
  // Found by the independent review: a restart that coincided with a bad minute at the storage service failed the job for good and
  // then deleted the stored video (a delete can work while reads do not), although attempts were left.
  const ctx = await setup({ runtime: { watchdogMs: 100, staleAfterMs: 2000 } });
  try {
    const storage = ctx.storage as MemoryStorage;
    storage.failDownloads = true;
    await addJob(ctx, 'j15', { status: 'processing', local: false, durable: true, attempts: 1 });
    await ctx.backdate('j15', 10);
    assert.deepEqual(await ctx.pipeline.recoverInterruptedJobs(), { resumed: ['j15'], failed: [], waiting: 0 });
    await untilSettled(ctx);

    const waiting = await ctx.db.getJob('j15');
    assert.equal(waiting?.status, 'processing', 'trouble with storage is no verdict on the job');
    assert.equal(waiting?.stage, 'waiting_to_retry');
    assert.equal(waiting?.attempts, 2);
    assert.equal(waiting?.sourceStorageKey, 'sources/j15/source.mp4', 'the job must still point at its video');
    assert.equal(storage.objects.has('sources/j15/source.mp4'), true, 'the stored video is the only copy there is; it must not be deleted');
    assert.equal(storage.log.includes('delete:sources/j15/source.mp4'), false);

    storage.failDownloads = false; // storage is back; once the job has been quiet for the staleness window it is started again
    const job = await waitForStatus(ctx, 'j15', ['completed', 'failed'], 10_000);
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal(job.attempts, 3);
  } finally { await ctx.cleanup(); }
});

test('when storage stays unreadable the job is given up on after its last attempt, with the reason, and only then is the stored video deleted', async () => {
  const ctx = await setup({ runtime: { watchdogMs: 100, maxAttempts: 2 } });
  try {
    const storage = ctx.storage as MemoryStorage;
    assert.deepEqual(await ctx.pipeline.recoverInterruptedJobs(), { resumed: [], failed: [], waiting: 0 }); // the start-up check, which also starts the watchdog
    storage.failDownloads = true;
    await addJob(ctx, 'j16', { status: 'queued', local: false, durable: true });
    ctx.pipeline.enqueue('j16');
    await untilSettled(ctx);
    assert.equal((await ctx.db.getJob('j16'))?.status, 'processing', 'the first failure is not the end');
    assert.equal(storage.objects.has('sources/j16/source.mp4'), true);

    const job = await waitForStatus(ctx, 'j16', ['completed', 'failed'], 10_000);
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 2);
    assert.match(job.errorMessage ?? '', /could not be read back from durable storage/);
    assert.match(job.errorMessage ?? '', /simulated storage outage/, 'the reason must be given');
    await untilSettled(ctx);
    assert.equal(storage.objects.has('sources/j16/source.mp4'), false, 'once the job is over for good its stored video goes');
    assert.equal((await ctx.db.getJob('j16'))?.sourceStorageKey, null);
  } finally { await ctx.cleanup(); }
});

test('a stored video that no longer exists fails the job at once, because trying again cannot bring it back', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j17', { status: 'processing', local: false, durable: true, attempts: 1 });
    (ctx.storage as MemoryStorage).objects.delete('sources/j17/source.mp4'); // gone, as opposed to unreadable
    await ctx.backdate('j17', 10);
    await ctx.pipeline.recoverInterruptedJobs();
    const job = await waitForStatus(ctx, 'j17', ['completed', 'failed']);
    assert.equal(job.status, 'failed');
    assert.match(job.errorMessage ?? '', /no longer exists in durable storage/);
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

test('a storage outage makes the sweep give up after a few failures in a row, instead of start-up waiting for every leftover to fail', async () => {
  const ctx = await setup();
  try {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) await addJob(ctx, id, { status: 'completed', local: false, durable: true });
    const storage = ctx.storage as MemoryStorage;
    storage.failDeletes = true;
    await ctx.pipeline.recoverInterruptedJobs();
    assert.equal(storage.log.filter((entry) => entry.startsWith('delete:')).length, 3, 'the sweep must stop after three failures in a row');

    storage.failDeletes = false; // storage is back: the next pass finds every leftover, none was forgotten
    await ctx.pipeline.recoverInterruptedJobs();
    for (const id of ids) {
      assert.equal(storage.objects.has(`sources/${id}/source.mp4`), false, `${id}: the leftover must be swept once storage works again`);
      assert.equal((await ctx.db.getJob(id))?.sourceStorageKey, null);
    }
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

test('a storage service that stops answering while recovery clears up after a job it gave up on does not hold up the jobs that are to be resumed', async () => {
  const storage = new MemoryStorage();
  let letStorageAnswer!: () => void;
  storage.holdDeletes = new Promise<void>((resolve) => { letStorageAnswer = resolve; });
  const ctx = await setup({ storage });
  try {
    await addJob(ctx, 'gave-up', { status: 'processing', local: false, durable: true, attempts: 3 }); // created first, so recovery looks at it first
    await addJob(ctx, 'resumable', { status: 'processing', local: false, durable: true, attempts: 1 });
    await ctx.backdate('gave-up', 10);
    await ctx.backdate('resumable', 10);

    let recoveryReturned = false;
    const recovery = ctx.pipeline.recoverInterruptedJobs().then((summary) => { recoveryReturned = true; return summary; });
    const finished = await waitForStatus(ctx, 'resumable', ['completed', 'failed']);
    assert.equal(finished.status, 'completed', finished.errorMessage ?? '');
    await eventually('recovery to have asked storage to delete the video of the job it gave up on', () => storage.log, (log) => log.includes('delete:sources/gave-up/source.mp4'));
    assert.equal(recoveryReturned, false, 'storage has not answered, so the call that clears up is still waiting; this test means nothing unless that is so');
    assert.equal((await ctx.db.getJob('gave-up'))?.status, 'failed', 'the job was given up on without waiting for storage');

    letStorageAnswer();
    assert.deepEqual(await recovery, { resumed: ['resumable'], failed: ['gave-up'], waiting: 0 });
    await untilSettled(ctx);
    assert.equal(storage.objects.has('sources/gave-up/source.mp4'), false, 'once storage answers, the video of the job given up on is deleted');
    assert.equal((await ctx.db.getJob('gave-up'))?.sourceStorageKey, null);
  } finally { letStorageAnswer(); await ctx.cleanup(); }
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


test('records how long each stage took and moves the progress from 0 to 100, following the speech recognition as it goes', async () => {
  const transcriber: TranscriptionEngine = { transcribe: async (_audio, _dir, onProgress) => {
    for (const fraction of [0.25, 0.5, 1]) { await sleep(20); onProgress?.(fraction); }
    return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Adapter-provided transcript.' }];
  } };
  const ctx = await setup({ transcriber });
  try {
    const written: number[] = [];
    const original = ctx.db.updateJob.bind(ctx.db);
    ctx.db.updateJob = async (id, fields) => { if (fields.progress !== undefined) written.push(fields.progress); await original(id, fields); };
    await addJob(ctx, 'j-progress');
    await ctx.pipeline.run('j-progress');

    const job = await ctx.db.getJob('j-progress');
    assert.equal(job?.status, 'completed');
    assert.equal(job?.progress, 100);
    for (const stage of ['preparing_source', 'saving_source', 'probing_video', 'extracting_audio', 'transcribing', 'detecting_highlights', 'extracting_clips']) {
      assert.equal(typeof job?.stageTimings[stage], 'number', `no timing for ${stage}`);
      assert.ok(job.stageTimings[stage] >= 0);
    }
    assert.ok(job.stageTimings.transcribing >= 50, `transcribing took ${job.stageTimings.transcribing} ms but the engine alone waited 60 ms`);
    assert.deepEqual(written, [...written].sort((a, b) => a - b), `progress went backwards: ${written}`);
    for (const percent of [25, 40, 70]) assert.ok(written.includes(percent), `the engine's progress (${percent}%) never reached the job: ${written}`);
    assert.equal(written.at(-1), 100);
  } finally { await ctx.cleanup(); }
});

test('a job that fails keeps the timings of the stages it went through and does not pretend to be nearly done', async () => {
  const ctx = await setup({ transcriber: { transcribe: async () => { await sleep(30); throw new Error('speech recognition exploded'); } } });
  try {
    await addJob(ctx, 'j-broken');
    await ctx.pipeline.run('j-broken');
    const job = await ctx.db.getJob('j-broken');
    assert.equal(job?.status, 'failed');
    assert.match(job?.errorMessage ?? '', /speech recognition exploded/);
    assert.ok(job.stageTimings.transcribing >= 25, 'the stage that failed must be timed too');
    assert.ok(job.progress < 100);
  } finally { await ctx.cleanup(); }
});

test('makes the clips the way the person asked: how many, how long, with or without captions, at which quality', async () => {
  const requests: ClipRenderRequest[] = [];
  const renderer: ClipRenderer = { render: async (request) => { requests.push(request); await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
  // Three minutes of talk in sentences of five seconds, so there are plenty of places to cut.
  const talk = Array.from({ length: 36 }, (_, index) => ({ segmentIndex: index, startSeconds: index * 5, endSeconds: index * 5 + 5, text: index % 3 === 2 ? 'Is this the best part of all?' : `Sentence number ${index} makes a point.` }));
  const ctx = await setup({ transcriber: { transcribe: async () => talk }, renderer, media: { ...fakeMedia, probe: async () => ({ durationSeconds: 180, width: 1920, height: 1080 }) } });
  try {
    await addJob(ctx, 'j-chosen', { options: { clipCount: 2, clipLength: 'short', quality: 'standard', captionStyle: 'none', captionAccent: 'gold', captionPosition: 'lower', captionSize: 'medium', framing: 'center', aspect: 'vertical' } });
    await ctx.pipeline.run('j-chosen');
    assert.equal((await ctx.db.getJob('j-chosen'))?.status, 'completed');
    assert.equal(requests.length, 2, 'two clips were asked for');
    for (const request of requests) {
      const length = request.endSeconds - request.startSeconds;
      assert.ok(length >= 15 && length <= 30, `a short clip must last 15 to 30 s, not ${length}`);
      assert.equal(request.captionPath, null, 'captions were switched off');
      assert.equal(request.quality, 'standard');
    }

    requests.length = 0;
    await addJob(ctx, 'j-plain');
    await ctx.pipeline.run('j-plain');
    assert.equal(requests.length, 1, 'without a choice the server default (one clip in this test setup) applies');
    assert.ok(requests[0].captionPath, 'captions are on by default');
    assert.equal(requests[0].quality, 'hd');
    const length = requests[0].endSeconds - requests[0].startSeconds;
    assert.ok(length >= 1 && length <= 10, 'the default clip length comes from the server settings');
  } finally { await ctx.cleanup(); }
});

test('the shape the person chose reaches the caption file, the renderer and the face follower, and without a choice the clips are the vertical ones they always were', async () => {
  const seen: Array<{ aspect: string | undefined; canvas: string | null; layout: string | undefined }> = [];
  const renderer: ClipRenderer = { render: async (request) => {
    const ass = request.captionPath ? await readFile(request.captionPath, 'utf8') : '';
    seen.push({ aspect: request.aspect, canvas: /PlayResX: (\d+)\nPlayResY: (\d+)/.exec(ass)?.slice(1).join('x') ?? null, layout: request.layout });
    await writeFile(request.outputPath, 'rendered clip');
    return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 };
  } };
  const asked: Array<number | undefined> = [];
  const framer: ClipFramer = { frame: async (request) => { asked.push(request.outputAspect); return { followed: false, note: 'Centred: a test.' }; } };
  const ctx = await setup({ renderer, framer });
  try {
    await addJob(ctx, 'j-square', { options: { ...defaultJobOptions, aspect: 'square', framing: 'face' } });
    await ctx.pipeline.run('j-square');
    assert.equal((await ctx.db.getJob('j-square'))?.status, 'completed');
    assert.deepEqual(seen, [{ aspect: 'square', canvas: '1080x1080', layout: 'fill' }], 'the captions are laid out for a square picture and the renderer cuts a square one');
    assert.deepEqual(asked, [1], 'the follower plans a window of the shape of the clip');

    seen.length = 0; asked.length = 0;
    await addJob(ctx, 'j-landscape', { options: { ...defaultJobOptions, aspect: 'landscape', framing: 'fit' } });
    await ctx.pipeline.run('j-landscape');
    assert.deepEqual(seen, [{ aspect: 'landscape', canvas: '1920x1080', layout: 'fit' }]);
    assert.deepEqual(asked, [], 'nobody looks for a face unless asked to');

    seen.length = 0;
    await addJob(ctx, 'j-default');
    await ctx.pipeline.run('j-default');
    assert.deepEqual(seen, [{ aspect: 'vertical', canvas: '1080x1920', layout: 'fill' }]);
  } finally { await ctx.cleanup(); }
});

test('burns the styled captions the person chose into each clip (with the spoken words timed), keeps the plain .srt with the clip, and leaves no scratch file behind', async () => {
  const seen: Array<{ path: string; text: string }> = [];
  const renderer: ClipRenderer = { render: async (request) => {
    assert.ok(request.captionPath, 'captions were asked for');
    seen.push({ path: request.captionPath, text: await readFile(request.captionPath, 'utf8') });
    await writeFile(request.outputPath, 'rendered clip');
    return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 };
  } };
  const word = (text: string, startSeconds: number, endSeconds: number) => ({ text, startSeconds, endSeconds });
  const transcriber: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 4, text: 'Nobody tells you this.', words: [word('Nobody', 0.2, 1), word('tells', 1, 1.8), word('you', 1.8, 2.5), word('this.', 2.5, 3.6)] }] };
  const ctx = await setup({ transcriber, renderer });
  try {
    await addJob(ctx, 'j-styled', { options: { ...defaultJobOptions, captionStyle: 'highlight' } });
    await ctx.pipeline.run('j-styled');
    assert.equal((await ctx.db.getJob('j-styled'))?.status, 'completed');
    assert.equal(seen.length, 1);
    assert.match(seen[0].path, /\.ass$/, 'the styled file is what gets burned in');
    assert.match(seen[0].text, /Style: Caption,Inter ExtraBold,/);
    assert.equal([...seen[0].text.matchAll(/\\1c&H0000D7FF&/g)].length, 4, 'one lit word per spoken word: the stored word timing was used');
    assert.ok(!existsSync(seen[0].path), 'the styled file is scratch and is removed once the clip is made');

    const [clip] = await ctx.db.listClips('j-styled');
    const stored = (ctx.storage as MemoryStorage).objects;
    assert.equal(stored.get(`j-styled/${clip.id}.srt`)?.toString('utf8').includes('Nobody tells you this.'), true, 'the plain phrases are kept with the clip');
    assert.ok(![...stored.keys()].some((key) => key.endsWith('.ass')), 'the styled file is not stored');

    seen.length = 0;
    await addJob(ctx, 'j-default');
    await ctx.pipeline.run('j-default');
    assert.doesNotMatch(seen[0].text, /\\1c&H/, 'the default style does not light words');
  } finally { await ctx.cleanup(); }
});

test('the look the person chose for the captions (colour of the spoken word, place and size) reaches the caption file, and without a choice the file is the one it always was', async () => {
  const seen: string[] = [];
  const renderer: ClipRenderer = { render: async (request) => { seen.push(request.captionPath ? await readFile(request.captionPath, 'utf8') : ''); await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
  const word = (text: string, startSeconds: number, endSeconds: number) => ({ text, startSeconds, endSeconds });
  const transcriber: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 4, text: 'Nobody tells you this.', words: [word('Nobody', 0.2, 1), word('tells', 1, 1.8), word('you', 1.8, 2.5), word('this.', 2.5, 3.6)] }] };
  const ctx = await setup({ transcriber, renderer });
  try {
    await addJob(ctx, 'j-look', { options: { ...defaultJobOptions, captionStyle: 'highlight', captionAccent: 'green', captionPosition: 'top', captionSize: 'small' } });
    await ctx.pipeline.run('j-look');
    assert.equal((await ctx.db.getJob('j-look'))?.status, 'completed');
    const fields = /^Style: (.*)$/m.exec(seen[0])![1].split(',');
    assert.deepEqual({ fontSize: Number(fields[2]), alignment: Number(fields[18]), marginV: Number(fields[21]) }, { fontSize: 77, alignment: 8, marginV: 300 }, 'small letters, set from the top');
    assert.equal([...seen[0].matchAll(/\\1c&H0050F032&/g)].length, 4, 'every lit word is green');
    assert.doesNotMatch(seen[0], /\\1c&H0000D7FF&/, 'and none is gold');

    seen.length = 0;
    await addJob(ctx, 'j-plain-look', { options: { ...defaultJobOptions, captionStyle: 'highlight' } });
    await ctx.pipeline.run('j-plain-look');
    const plain = /^Style: (.*)$/m.exec(seen[0])![1].split(',');
    assert.deepEqual({ fontSize: Number(plain[2]), alignment: Number(plain[18]), marginV: Number(plain[21]) }, { fontSize: 96, alignment: 2, marginV: 560 }, 'the look it always had');
    assert.equal([...seen[0].matchAll(/\\1c&H0000D7FF&/g)].length, 4, 'gold');

    // The look is stored with the job, so a job that is resumed is finished the way it was started.
    assert.deepEqual({ accent: (await ctx.db.getJob('j-look'))?.options.captionAccent, position: (await ctx.db.getJob('j-look'))?.options.captionPosition, size: (await ctx.db.getJob('j-look'))?.options.captionSize }, { accent: 'green', position: 'top', size: 'small' });
  } finally { await ctx.cleanup(); }
});

test('a transcript that was stored without word timing (made before words were kept) still gets captions', async () => {
  const seen: string[] = [];
  const renderer: ClipRenderer = { render: async (request) => { seen.push(request.captionPath ? await readFile(request.captionPath, 'utf8') : ''); await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: 2, sizeBytes: 13 }; } };
  const ctx = await setup({ renderer });
  try {
    await addJob(ctx, 'j-old', { options: { ...defaultJobOptions, captionStyle: 'pop' } });
    await ctx.pipeline.run('j-old');
    assert.equal((await ctx.db.getJob('j-old'))?.status, 'completed');
    assert.match(seen[0], /ADAPTER-PROVIDED/, 'the text of a segment with no word timing is spread over its time and shown');
  } finally { await ctx.cleanup(); }
});

test('a clip is cut with a little room around its speech but never into the words next to it, and keeps the title, score and reasons of its passage', async () => {
  const requests: ClipRenderRequest[] = [];
  const renderer: ClipRenderer = { render: async (request) => { requests.push(request); await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
  const word = (text: string, startSeconds: number, endSeconds: number) => ({ text, startSeconds, endSeconds });
  const transcriber: TranscriptionEngine = { transcribe: async () => [
    { segmentIndex: 0, startSeconds: 1, endSeconds: 2, text: 'First thought here.', words: [word('First', 1, 1.3), word('thought', 1.3, 1.7), word('here.', 1.7, 2)] },
    { segmentIndex: 1, startSeconds: 2.1, endSeconds: 4.5, text: 'Then a slower sentence.', words: [word('Then', 2.1, 2.5), word('a', 2.5, 2.7), word('slower', 2.7, 3.5), word('sentence.', 3.5, 4.5)] },
  ] };
  const ctx = await setup({ transcriber, renderer });
  try {
    await addJob(ctx, 'j-padded');
    await ctx.pipeline.run('j-padded');
    assert.equal((await ctx.db.getJob('j-padded'))?.status, 'completed');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].startSeconds, 0.75, 'a quarter of a second before the first word');
    assert.equal(requests[0].endSeconds, 2.08, 'the next word starts at 2.1 s, so the clip stops just before it rather than 0.4 s after the last word');

    const [clip] = await ctx.db.listClips('j-padded');
    assert.deepEqual([clip.startSeconds, clip.endSeconds], [0.75, 2.08], 'the clip record is the range that was really cut');
    assert.ok(Math.abs(clip.durationSeconds - 1.33) < 1e-9);
    assert.equal(clip.title, 'First thought here');
    assert.equal(clip.score, 100);
    assert.deepEqual(clip.reasons, ['high transcript density']);
  } finally { await ctx.cleanup(); }
});

test('a video with no speech fails with a message that says so, and one with only a blink of speech says that instead', async () => {
  const ctx = await setup({ transcriber: { transcribe: async () => [] } });
  try {
    await addJob(ctx, 'j-silent');
    await ctx.pipeline.run('j-silent');
    const job = await ctx.db.getJob('j-silent');
    assert.equal(job?.status, 'failed');
    assert.match(job?.errorMessage ?? '', /No speech was recognised/);
    assert.equal((await ctx.db.listClips('j-silent')).length, 0);
  } finally { await ctx.cleanup(); }

  const blink = await setup({ transcriber: { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 0.5, text: 'Hi.' }] } });
  try {
    await addJob(blink, 'j-blink');
    await blink.pipeline.run('j-blink');
    const job = await blink.db.getJob('j-blink');
    assert.equal(job?.status, 'failed');
    assert.match(job?.errorMessage ?? '', /No stretch of the speech was long enough/);
  } finally { await blink.cleanup(); }
});

test('a video shorter than the shortest clip still completes, with all of its speech as one clip', async () => {
  const requests: ClipRenderRequest[] = [];
  const renderer: ClipRenderer = { render: async (request) => { requests.push(request); await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
  const transcriber: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0.5, endSeconds: 3.5, text: 'A short video with a few words.' }] };
  const ctx = await setup({ transcriber, renderer, highlights: { minDurationSeconds: 20, maxDurationSeconds: 60 } });
  try {
    await addJob(ctx, 'j-short');
    await ctx.pipeline.run('j-short');
    assert.equal((await ctx.db.getJob('j-short'))?.status, 'completed');
    const clips = await ctx.db.listClips('j-short');
    assert.equal(clips.length, 1);
    assert.equal(clips[0].status, 'completed');
    assert.deepEqual([requests[0].startSeconds, requests[0].endSeconds], [0.25, 3.9], 'all of the speech, with the usual room around it');
    assert.ok(clips[0].reasons.some((reason) => /shorter than the shortest clip length/.test(reason)), 'the clip says why it is shorter than asked for');
  } finally { await ctx.cleanup(); }
});

/** Three minutes of talk in sentences of five seconds, so there are plenty of places to cut. */
const threeMinutes = Array.from({ length: 36 }, (_, index) => ({ segmentIndex: index, startSeconds: index * 5, endSeconds: index * 5 + 5, text: index % 3 === 2 ? 'Is this the best part of all?' : `Sentence number ${index} makes a point.` }));
const threeMinuteVideo = { ...fakeMedia, probe: async () => ({ durationSeconds: 180, width: 1920, height: 1080 }) };
const faceOptions: JobOptions = { ...defaultJobOptions, clipCount: 2, clipLength: 'short', captionStyle: 'none', framing: 'face' };
const recordingRenderer = (requests: ClipRenderRequest[]): ClipRenderer => ({ render: async (request) => { requests.push(request); await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } });

test('following a face: only when asked for, each clip is checked on its own stretch of the video, the plan goes to the renderer, and the clip says what was done', async () => {
  const requests: ClipRenderRequest[] = []; const asked: Array<{ sourcePath: string; startSeconds: number; endSeconds: number }> = [];
  const plan: FramingPlan = { keyframes: [{ seconds: 0, position: 0.2 }, { seconds: 2, position: 0.6 }] };
  const framer: ClipFramer = { frame: async (request) => { asked.push(request); return { followed: true, plan, seenShare: 0.8, tracksFollowed: 1, note: 'Followed a face, seen in 80% of the moments checked.' }; } };
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, renderer: recordingRenderer(requests), framer, media: threeMinuteVideo });
  try {
    await addJob(ctx, 'j-face', { options: faceOptions });
    await ctx.pipeline.run('j-face');
    assert.equal((await ctx.db.getJob('j-face'))?.status, 'completed');
    assert.equal(requests.length, 2); assert.equal(asked.length, 2, 'one look for a face per clip');
    for (const [index, request] of requests.entries()) {
      assert.deepEqual(asked[index], { sourcePath: request.sourcePath, startSeconds: request.startSeconds, endSeconds: request.endSeconds, outputAspect: 9 / 16 }, 'the face is looked for in exactly the stretch that becomes the clip, for a window of the shape of the clip');
      assert.deepEqual(request.framing, plan, 'the renderer is given the plan');
    }
    const clips = await ctx.db.listClips('j-face');
    assert.deepEqual(clips.map((clip) => clip.framing), ['Followed a face, seen in 80% of the moments checked.', 'Followed a face, seen in 80% of the moments checked.']);
    assert.deepEqual(ctx.errors, [], 'nothing went wrong');
  } finally { await ctx.cleanup(); }
});

test('the middle of the picture, the default, never asks for a face and stores no note', async () => {
  const requests: ClipRenderRequest[] = []; let asked = 0;
  const framer: ClipFramer = { frame: async () => { asked += 1; throw new Error('must not be called'); } };
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, renderer: recordingRenderer(requests), framer, media: threeMinuteVideo });
  try {
    await addJob(ctx, 'j-middle', { options: { ...faceOptions, framing: 'center' } });
    await ctx.pipeline.run('j-middle');
    await addJob(ctx, 'j-default');
    await ctx.pipeline.run('j-default');
    assert.equal(asked, 0, 'a framer that is there is not used unless the person chose to follow a face');
    assert.equal(requests.length, 3);
    for (const request of requests) assert.equal(request.framing, null);
    for (const id of ['j-middle', 'j-default']) for (const clip of await ctx.db.listClips(id)) assert.equal(clip.framing, null);
    assert.deepEqual(ctx.errors, []);
  } finally { await ctx.cleanup(); }
});

test('when no face can be followed the clip is cut from the middle, and the clip says why', async () => {
  const requests: ClipRenderRequest[] = [];
  const framer: ClipFramer = { frame: async () => ({ followed: false, note: 'Centred: no face was found in the video.' }) };
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, renderer: recordingRenderer(requests), framer, media: threeMinuteVideo });
  try {
    await addJob(ctx, 'j-noface', { options: faceOptions });
    await ctx.pipeline.run('j-noface');
    assert.equal((await ctx.db.getJob('j-noface'))?.status, 'completed');
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(request.framing, null, 'no plan, so the plain centred cut');
    assert.deepEqual((await ctx.db.listClips('j-noface')).map((clip) => clip.framing), ['Centred: no face was found in the video.', 'Centred: no face was found in the video.']);
  } finally { await ctx.cleanup(); }
});

test('if looking for a face fails, the clip is still made from the middle, the failure is logged, and the person is told in plain words', async () => {
  const requests: ClipRenderRequest[] = [];
  const framer: ClipFramer = { frame: async () => { throw new Error('FFmpeg could not take pictures from the video (exit code 1).'); } };
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, renderer: recordingRenderer(requests), framer, media: threeMinuteVideo });
  try {
    await addJob(ctx, 'j-broken-framer', { options: faceOptions });
    await ctx.pipeline.run('j-broken-framer');
    const job = await ctx.db.getJob('j-broken-framer');
    assert.equal(job?.status, 'completed', job?.errorMessage ?? '');
    assert.equal(requests.length, 2); for (const request of requests) assert.equal(request.framing, null);
    const clips = await ctx.db.listClips('j-broken-framer');
    assert.ok(clips.every((clip) => clip.status === 'completed'), 'a problem with framing never costs the person the clip');
    assert.deepEqual(clips.map((clip) => clip.framing), ['Centred: the video could not be checked for a face.', 'Centred: the video could not be checked for a face.']);
    assert.deepEqual(ctx.errors, ['Looking for a face to follow failed; the clip is cut from the middle instead', 'Looking for a face to follow failed; the clip is cut from the middle instead']);
  } finally { await ctx.cleanup(); }
});

test('on a server where following a face is switched off, asking for it still gives the clips, from the middle, with a note saying so', async () => {
  const requests: ClipRenderRequest[] = [];
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, renderer: recordingRenderer(requests), media: threeMinuteVideo });
  try {
    await addJob(ctx, 'j-off', { options: faceOptions });
    await ctx.pipeline.run('j-off');
    assert.equal((await ctx.db.getJob('j-off'))?.status, 'completed');
    for (const request of requests) assert.equal(request.framing, null);
    assert.deepEqual((await ctx.db.listClips('j-off')).map((clip) => clip.framing), ['Centred: following a face is switched off on this server.', 'Centred: following a face is switched off on this server.']);
    assert.deepEqual(ctx.errors, [], 'switched off is not an error');
  } finally { await ctx.cleanup(); }
});

test('the whole picture over a blurred copy: every clip is rendered that way, nothing looks for a face, and the other choices keep cutting from the middle', async () => {
  const requests: ClipRenderRequest[] = []; let asked = 0;
  const framer: ClipFramer = { frame: async () => { asked += 1; throw new Error('must not be called'); } };
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, renderer: recordingRenderer(requests), framer, media: threeMinuteVideo });
  try {
    await addJob(ctx, 'j-fit', { options: { ...faceOptions, framing: 'fit' } });
    await ctx.pipeline.run('j-fit');
    assert.equal((await ctx.db.getJob('j-fit'))?.status, 'completed');
    assert.equal(requests.length, 2);
    for (const request of requests) { assert.equal(request.layout, 'fit'); assert.equal(request.framing, null, 'no path to follow'); }
    assert.equal(asked, 0, 'a framer that is there is not used for this choice');
    assert.deepEqual((await ctx.db.listClips('j-fit')).map((clip) => clip.framing), [null, null], 'nothing needs explaining');

    requests.length = 0;
    await addJob(ctx, 'j-middle-layout', { options: { ...faceOptions, framing: 'center' } });
    await ctx.pipeline.run('j-middle-layout');
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(request.layout, 'fill', 'the middle of the picture is cut out, as before');
    assert.deepEqual(ctx.errors, []);
  } finally { await ctx.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------------
// The same sound is not recognised twice.

/** An engine that counts how often it is asked to listen, and whose cache key (what its transcripts depend on besides the sound) can be changed between runs. */
function listeningEngine(options: { key?: string; segments?: TranscriptInput } = {}) {
  const engine: TranscriptionEngine & { calls: number; key: string | undefined } = {
    calls: 0, key: options.key,
    get cacheKey() { return engine.key; },
    transcribe: async () => {
      engine.calls += 1;
      return options.segments ?? [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Said once, heard once.', words: [{ text: 'Said', startSeconds: 0, endSeconds: 0.5 }, { text: 'once,', startSeconds: 0.5, endSeconds: 1 }, { text: 'heard', startSeconds: 1, endSeconds: 1.5 }, { text: 'once.', startSeconds: 1.5, endSeconds: 2 }] }];
    },
  };
  return engine;
}
/** The database, noting which of the cache's methods are called. */
function watched(db: StudioDatabase, calls: string[]) {
  return new Proxy(db, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    if (typeof property === 'string' && /CachedTranscript$/.test(property)) return (...args: unknown[]) => { calls.push(property); return value.apply(target, args); };
    return value.bind(target);
  } });
}
/** The sound of a video here is the bytes of the video file itself, so two uploads of the same bytes have the same sound. */
const hearing = { ...fakeMedia, extractAudio: async (input: string, output: string) => { await writeFile(output, await readFile(input)); } };
const withCache = { transcriptCacheDays: 30 };
const heard = (ctx: Context) => ctx.infos.filter((entry) => entry.message.includes('caption burn-in completed')).map((entry) => entry.fields.transcriptReused);

test('the same sound is recognised once: a video uploaded again reuses the transcript and says so, and its clips are made as usual', async () => {
  const engine = listeningEngine({ key: 'test-engine|1' });
  const ctx = await setup({ transcriber: engine, media: hearing, runtime: withCache });
  try {
    await addJob(ctx, 'j1'); await ctx.pipeline.run('j1');
    assert.equal(engine.calls, 1);
    const first = await ctx.db.getJob('j1');
    assert.equal(first?.status, 'completed');
    assert.ok('transcribing' in first!.stageTimings && !('reusing_transcript' in first!.stageTimings), 'the first time the speech is listened to');

    await addJob(ctx, 'j2'); await ctx.pipeline.run('j2');
    assert.equal(engine.calls, 1, 'the second video had the same sound: nobody listened again');
    const second = await ctx.db.getJob('j2');
    assert.equal(second?.status, 'completed', second?.errorMessage ?? '');
    assert.ok('reusing_transcript' in second!.stageTimings && !('transcribing' in second!.stageTimings), 'and the job says it did not');
    const shape = async (id: string) => (await ctx.db.listTranscript(id)).map(({ segmentIndex, startSeconds, endSeconds, text, words }) => ({ segmentIndex, startSeconds, endSeconds, text, words }));
    assert.deepEqual(await shape('j2'), await shape('j1'), 'the transcript, words and their timing included, is the same');
    assert.equal((await shape('j2'))[0].words?.length, 4);
    assert.equal((await ctx.db.listClips('j2')).filter((clip) => clip.status === 'completed').length, 1, 'the clips are made from it as usual');
    assert.deepEqual(heard(ctx), [false, true], 'the log says which time the speech was reused');
    assert.equal(ctx.errors.length, 0);
  } finally { await ctx.cleanup(); }
});

test('what is reused is the transcript of the same sound by the same engine: another sound, another engine, language or model, or no cache at all, means listening again', async () => {
  const engine = listeningEngine({ key: 'test-engine|1' });
  const ctx = await setup({ transcriber: engine, media: hearing, runtime: withCache });
  try {
    await addJob(ctx, 'j1'); await ctx.pipeline.run('j1');
    assert.equal(engine.calls, 1);

    await addJob(ctx, 'other-sound'); await writeFile(join(ctx.uploadDir, 'other-sound.mp4'), 'a different video, so a different sound');
    await ctx.pipeline.run('other-sound');
    assert.equal(engine.calls, 2, 'another sound is listened to');

    engine.key = 'test-engine|2';
    await addJob(ctx, 'other-engine'); await ctx.pipeline.run('other-engine');
    assert.equal(engine.calls, 3, 'the same sound, but another model or language: listened to again');

    engine.key = 'test-engine|1';
    await addJob(ctx, 'back-again'); await ctx.pipeline.run('back-again');
    assert.equal(engine.calls, 3, 'and with the first engine back, the first transcript is still there');
    assert.deepEqual(heard(ctx), [false, false, false, true]);
  } finally { await ctx.cleanup(); }

  for (const [label, key, days] of [['an engine that has no key', undefined, 30], ['keeping nothing (0 days)', 'test-engine|1', 0]] as const) {
    const silent = listeningEngine(key ? { key } : {}); const asked: string[] = [];
    const plain = await setup({ transcriber: silent, media: hearing, runtime: { transcriptCacheDays: days }, database: (db) => watched(db, asked) });
    try {
      await addJob(plain, 'a'); await plain.pipeline.run('a'); await addJob(plain, 'b'); await plain.pipeline.run('b');
      assert.equal(silent.calls, 2, `${label}: the same sound is listened to each time`);
      assert.deepEqual(asked, [], `${label}: the cache is not even asked, let alone filled`);
      assert.equal((await plain.raw.query('SELECT count(*)::int AS n FROM transcript_cache')).rows[0].n, 0, `${label}: nothing is kept`);
    } finally { await plain.cleanup(); }
  }
});

test('a transcript is kept even when the job that made it failed afterwards, so the next try does not listen again', async () => {
  const engine = listeningEngine({ key: 'test-engine|1' });
  let breaking = true;
  const renderer: ClipRenderer = { render: async (request) => { if (breaking) throw new Error('the renderer broke'); await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
  const ctx = await setup({ transcriber: engine, media: hearing, renderer, runtime: withCache });
  try {
    await addJob(ctx, 'j1'); await ctx.pipeline.run('j1');
    assert.equal((await ctx.db.getJob('j1'))?.status, 'failed');
    assert.equal(engine.calls, 1);
    breaking = false;
    await addJob(ctx, 'j2'); await ctx.pipeline.run('j2');
    assert.equal((await ctx.db.getJob('j2'))?.status, 'completed');
    assert.equal(engine.calls, 1, 'the speech was already written down, so nobody listens again');
  } finally { await ctx.cleanup(); }
});

test('a transcript of nothing is not kept, and a damaged one is not trusted: the speech is listened to again', async () => {
  const quiet = listeningEngine({ key: 'test-engine|1', segments: [] });
  const ctx = await setup({ transcriber: quiet, media: hearing, runtime: withCache });
  try {
    await addJob(ctx, 'q1'); await ctx.pipeline.run('q1');
    assert.equal((await ctx.db.getJob('q1'))?.status, 'failed');
    assert.match((await ctx.db.getJob('q1'))?.errorMessage ?? '', /No speech was recognised/);
    await addJob(ctx, 'q2'); await ctx.pipeline.run('q2');
    assert.equal(quiet.calls, 2, 'nothing was said last time, which says nothing about this time');
    assert.equal((await ctx.raw.query('SELECT count(*)::int AS n FROM transcript_cache')).rows[0].n, 0, 'not even a row of it is kept');
  } finally { await ctx.cleanup(); }

  const engine = listeningEngine({ key: 'test-engine|1' });
  const damaged = await setup({ transcriber: engine, media: hearing, runtime: withCache });
  try {
    await addJob(damaged, 'j1'); await damaged.pipeline.run('j1');
    await damaged.raw.query(`UPDATE transcript_cache SET segments_json = '[{"segmentIndex":0,"startSeconds":0,"endSeconds":2,"text":"cut off'`);
    await addJob(damaged, 'j2'); await damaged.pipeline.run('j2');
    assert.equal((await damaged.db.getJob('j2'))?.status, 'completed');
    assert.equal(engine.calls, 2, 'the damaged transcript was not used');
    await addJob(damaged, 'j3'); await damaged.pipeline.run('j3');
    assert.equal(engine.calls, 2, 'and the one made instead of it is good');
  } finally { await damaged.cleanup(); }
});

test('transcripts nobody has needed for as many days as are kept are forgotten as a new one is made, and the ones still in use are not', async () => {
  const engine = listeningEngine({ key: 'test-engine|1' });
  const ctx = await setup({ transcriber: engine, media: hearing, runtime: { transcriptCacheDays: 30 } });
  try {
    const transcript = '[{"segmentIndex":0,"startSeconds":0,"endSeconds":1,"text":"Said before."}]';
    const keep = (sound: string, daysAgo: number) => ctx.raw.query(
      `INSERT INTO transcript_cache (audio_sha256, engine_key, segments_json, created_at, last_used_at, uses) VALUES ($1, 'test-engine|1', $2, $3, $3, 0)`,
      [sound, transcript, new Date(Date.now() - daysAgo * 86_400_000).toISOString()]);
    await keep('unused-for-31-days', 31); await keep('unused-for-29-days', 29); await keep('unused-for-a-day', 1);
    await addJob(ctx, 'j1'); await ctx.pipeline.run('j1');
    assert.equal((await ctx.db.getJob('j1'))?.status, 'completed');
    const left = (await ctx.raw.query('SELECT audio_sha256 FROM transcript_cache')).rows.map((row) => String(row.audio_sha256));
    assert.ok(!left.includes('unused-for-31-days'), 'a transcript nobody needed for 31 days (30 are kept) is forgotten');
    assert.ok(left.includes('unused-for-29-days') && left.includes('unused-for-a-day'), 'the ones used within the last 30 days stay');
    assert.equal(left.length, 3, 'and the one just made is kept with them');
  } finally { await ctx.cleanup(); }
});

test('whatever goes wrong with the cache, the job is done: a cache that cannot be read or written costs time, never the job', async () => {
  const failing = (db: StudioDatabase, methods: string[]) => new Proxy(db, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof property === 'string' && methods.includes(property)) return () => Promise.reject(new Error('the cache is out of order'));
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const engine = listeningEngine({ key: 'test-engine|1' });
  const unreadable = await setup({ transcriber: engine, media: hearing, runtime: withCache, database: (db) => failing(db, ['findCachedTranscript']) });
  try {
    await addJob(unreadable, 'j1'); await unreadable.pipeline.run('j1');
    assert.equal((await unreadable.db.getJob('j1'))?.status, 'completed', 'the speech was listened to instead');
    assert.equal(engine.calls, 1);
    assert.ok(unreadable.errors.some((message) => /Could not look for an earlier transcript/.test(message)), 'and the log says why');
  } finally { await unreadable.cleanup(); }

  const writeEngine = listeningEngine({ key: 'test-engine|1' });
  const unwritable = await setup({ transcriber: writeEngine, media: hearing, runtime: withCache, database: (db) => failing(db, ['storeCachedTranscript']) });
  try {
    await addJob(unwritable, 'j1'); await unwritable.pipeline.run('j1');
    assert.equal((await unwritable.db.getJob('j1'))?.status, 'completed');
    assert.ok(unwritable.errors.some((message) => /Could not keep the transcript for next time/.test(message)));
    assert.equal((await unwritable.db.listClips('j1')).filter((clip) => clip.status === 'completed').length, 1);
  } finally { await unwritable.cleanup(); }
});
