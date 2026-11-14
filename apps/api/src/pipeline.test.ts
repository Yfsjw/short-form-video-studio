import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Pool } from 'pg';
import { StudioDatabase } from './database.js';
import { defaultJobOptions, type JobOptions, type NewVideoJob } from './domain.js';
import { Semaphore, VideoPipeline, type PipelineRuntimeOptions, type StopOutcome } from './pipeline.js';
import type { FfmpegAdapter } from './ffmpeg.js';
import { NullStorage, type DurableStorage } from './storage.js';
import { MemoryStorage, eventually, sleep } from './test-support.js';
import type { TranscriptInput, TranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector } from './highlights.js';
import type { ClipRenderer, ClipRenderRequest } from './clips.js';
import type { ClipFramer } from './face-track.js';
import type { FramingPlan } from './framing.js';
import { JobStopped, PlainFailure, plainWords } from './failures.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';
const VIDEO = 'pretend these are the bytes of an uploaded video';

const fakeMedia = { probe: async () => ({ durationSeconds: 6, width: 1920, height: 1080 }), extractAudio: async (_input: string, output: string) => { await writeFile(output, 'mock wav'); } };
const speech: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Adapter-provided transcript.' }] };
const writingRenderer: ClipRenderer = { render: async (request) => { await writeFile(request.outputPath, 'rendered clip'); return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13 }; } };
const highlightOptions = { minDurationSeconds: 1, maxDurationSeconds: 10, maxCandidates: 3, overlapThreshold: 0.65, weights: { density: 1 } };
const fastRuntime: PipelineRuntimeOptions = { concurrency: 1, staleAfterMs: 1000, heartbeatMs: 50, recheckMs: 100, watchdogMs: 60_000, maxAttempts: 3 };

type Context = Awaited<ReturnType<typeof setup>>;

/** Whether the log holds an error (or something one was made from) whose words include `text`: what really went wrong is kept for the operator. */
const logged = (ctx: Context, text: string) => ctx.errorFields.some((fields) => {
  for (let error = fields.err as { message?: unknown; cause?: unknown } | undefined, depth = 0; error && depth < 5; error = error.cause as typeof error, depth += 1) if (String(error.message).includes(text)) return true;
  return false;
});
const receivingWords = 'The video could not be received properly by the server. Please upload it again.';
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

async function setup(options: { highlights?: Partial<typeof highlightOptions>; storage?: DurableStorage; transcriber?: TranscriptionEngine; renderer?: ClipRenderer; framer?: ClipFramer; runtime?: Partial<PipelineRuntimeOptions>; database?: (db: StudioDatabase) => StudioDatabase; media?: Pick<FfmpegAdapter, 'probe' | 'extractAudio'> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-pipeline-'));
  const uploadDir = join(root, 'uploads'); const tempDir = join(root, 'tmp'); const outputDir = join(root, 'outputs');
  await Promise.all([mkdir(uploadDir), mkdir(tempDir), mkdir(outputDir)]);
  const schema = `test_pipe_${randomUUID().replaceAll('-', '_')}`;
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, schema);
  const raw = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
  const storage = options.storage ?? new MemoryStorage();
  const errors: string[] = [];
  /** The fields that came with each of those errors (the error itself, as `err`): what really went wrong, which is for the log and not for the person. */
  const errorFields: Array<Record<string, unknown>> = [];
  /** What the pipeline said about itself at the information level (the fields it attached, and the sentence). */
  const infos: Array<{ fields: Record<string, unknown>; message: string }> = [];
  /** What it said as a warning: something an operator should know that is not a failure. */
  const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const logger = { warn: (fields: unknown, message?: string) => { warnings.push({ fields: (fields && typeof fields === 'object' ? fields : {}) as Record<string, unknown>, message: String(message) }); }, info: (fields: unknown, message?: string) => { infos.push({ fields: (fields && typeof fields === 'object' ? fields : {}) as Record<string, unknown>, message: String(message) }); }, error: (fields: unknown, message?: string) => { errors.push(String(message)); errorFields.push((fields && typeof fields === 'object' ? fields : {}) as Record<string, unknown>); } };
  const pipelines: VideoPipeline[] = [];
  const makePipeline = () => {
    const pipeline = new VideoPipeline(options.database ? options.database(db) : db, options.media ?? fakeMedia, options.transcriber ?? speech, new DeterministicHighlightDetector(), { ...highlightOptions, ...options.highlights }, options.renderer ?? writingRenderer, 1, uploadDir, tempDir, outputDir, logger, storage, { ...fastRuntime, ...options.runtime }, options.framer);
    pipelines.push(pipeline);
    return pipeline;
  };
  return {
    root, uploadDir, tempDir, outputDir, db, raw, storage, errors, errorFields, infos, warnings, makePipeline, pipeline: makePipeline(),
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
    assert.equal(job?.errorMessage, receivingWords, 'told in plain words: what the storage service said is not for the person');
    assert.ok(logged(ctx, 'simulated storage outage'), 'but the log has it');
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
    assert.equal(job.errorMessage, receivingWords);
    assert.ok(logged(ctx, 'restored from durable storage has 9 bytes'), 'the log has the sizes');
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
    assert.equal(job.errorMessage, receivingWords);
    assert.ok(logged(ctx, 'could not be read back from durable storage') && logged(ctx, 'simulated storage outage'), 'the reason is in the log');
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
    assert.equal(job.errorMessage, 'The saved copy of this video is gone, so processing could not be resumed. Please upload the video again.');
    assert.ok(logged(ctx, 'no such object sources/j17/source.mp4'), 'the log has what the storage said, as what the failure was made from');
  } finally { await ctx.cleanup(); }
});

test('a failing job reports why and still frees its local copies', async () => {
  const ctx = await setup({ renderer: { render: async () => { throw new Error('ffmpeg exploded'); } } });
  try {
    await addJob(ctx, 'j10');
    await ctx.pipeline.run('j10');
    const job = await ctx.db.getJob('j10');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.errorMessage, 'None of the 1 clip could be made from this video. Please try again, or try another video.');
    assert.deepEqual((await ctx.db.listClips('j10')).map((clip) => clip.errorMessage), [plainWords.oneClip], 'a clip that could not be made says so in general words too');
    assert.ok(logged(ctx, 'ffmpeg exploded'), 'what FFmpeg said is in the log');
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
    const pipeline = new VideoPipeline(brokenDatabase as never, fakeMedia, speech, new DeterministicHighlightDetector(), highlightOptions, writingRenderer, 1, tmpdir(), tmpdir(), tmpdir(), { info: () => undefined, warn: () => undefined, error: (_fields: unknown, message?: string) => { logged.push(String(message)); } }, new MemoryStorage());
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
    assert.equal(job?.errorMessage, 'The speech in this video could not be turned into text. Please try again, or try another video.');
    assert.ok(logged(ctx, 'speech recognition exploded'), 'what the engine said is in the log');
    assert.ok(job.stageTimings.transcribing >= 25, 'the stage that failed must be timed too');
    assert.ok(job.progress < 100);
  } finally { await ctx.cleanup(); }
});

test('a video that is HDR is handed to the renderer as such and stored as nothing but a video, and the log says whether the colours of its clips were converted, warning once when they were not', async () => {
  const requests: ClipRenderRequest[] = [];
  let colours: (call: number) => 'converted' | 'not converted' | undefined = () => undefined;
  const renderer: ClipRenderer = { render: async (request) => {
    requests.push(request); await writeFile(request.outputPath, 'rendered clip');
    const said = colours(requests.length);
    return { durationSeconds: request.endSeconds - request.startSeconds, sizeBytes: 13, ...(said ? { colours: said } : {}) };
  } };
  const talk = Array.from({ length: 36 }, (_, index) => ({ segmentIndex: index, startSeconds: index * 5, endSeconds: index * 5 + 5, text: index % 3 === 2 ? 'Is this the best part of all?' : `Sentence number ${index} makes a point.` }));
  const seen = (hdr?: 'hlg' | 'pq') => ({ ...fakeMedia, probe: async () => ({ durationSeconds: 180, width: 1920, height: 1080, hasAudio: true, ...(hdr ? { hdr } : {}) }) });
  const options: JobOptions = { ...defaultJobOptions, clipCount: 2, clipLength: 'short', captionStyle: 'none' };
  const finishedLine = (ctx: Context, id: string) => ctx.infos.find((entry) => entry.fields.jobId === id && entry.message.startsWith('Video processing'))!;
  const warningsAbout = (ctx: Context, id: string) => ctx.warnings.filter((entry) => entry.fields.jobId === id);
  const run = async (id: string, media: ReturnType<typeof seen>, say: typeof colours) => {
    const ctx = await setup({ transcriber: { transcribe: async () => talk }, renderer, media });
    try {
      colours = say; requests.length = 0;
      await addJob(ctx, id, { options });
      await ctx.pipeline.run(id);
      const job = await ctx.db.getJob(id);
      assert.equal(job?.status, 'completed', job?.errorMessage ?? '');
      assert.equal(requests.length, 2, `${id}: two clips were asked for`);
      return { ctx, job: job!, line: finishedLine(ctx, id), warnings: warningsAbout(ctx, id), requests: [...requests] };
    } finally { await ctx.cleanup(); }
  };

  const converted = await run('j-hdr-converted', seen('hlg'), () => 'converted');
  for (const request of converted.requests) assert.equal(request.hdr, 'hlg', 'every clip is told what kind of HDR the picture is in');
  assert.deepEqual(converted.line.fields.metadata, { durationSeconds: 180, width: 1920, height: 1080 }, 'what is kept of the video is its size and length, nothing of how it is looked at');
  assert.equal(converted.line.fields.hdr, 'hlg');
  assert.equal(converted.line.fields.coloursConverted, true);
  assert.deepEqual(converted.warnings, [], 'nothing to warn about');
  assert.equal(converted.job.durationSeconds, 180); assert.equal(converted.job.width, 1920); assert.equal(converted.job.height, 1080);
  assert.equal('hdr' in converted.job, false, 'the job a person is shown does not carry it');

  const pq = await run('j-hdr-pq', seen('pq'), () => 'converted');
  for (const request of pq.requests) assert.equal(request.hdr, 'pq');
  assert.equal(pq.line.fields.hdr, 'pq');

  const kept = await run('j-hdr-kept', seen('hlg'), () => 'not converted');
  assert.equal(kept.line.fields.coloursConverted, false);
  assert.equal(kept.warnings.length, 1, 'one warning for the video, not one for each clip');
  assert.equal(kept.warnings[0].message, 'This video is HDR but its colours could not be converted to those of an ordinary picture (this machine does not convert them, or the video does not say what its colours are): the clips play everywhere but look flatter than the original');
  assert.deepEqual(kept.warnings[0].fields, { jobId: 'j-hdr-kept', hdr: 'hlg', clipCount: 2 });

  const mixed = await run('j-hdr-mixed', seen('hlg'), (call) => (call === 1 ? 'converted' : 'not converted'));
  assert.equal(mixed.line.fields.coloursConverted, false, 'converted only when every clip was');
  assert.deepEqual(mixed.warnings.map((entry) => entry.fields.clipCount), [1], 'and the warning counts the clips that were not');

  const unsaid = await run('j-hdr-unsaid', seen('hlg'), () => undefined);
  assert.equal(unsaid.line.fields.coloursConverted, false, 'a renderer that does not say is not taken to have converted anything');
  assert.deepEqual(unsaid.warnings, [], 'and is not warned about either: nothing is known to have been left unconverted');

  const ordinary = await run('j-ordinary', seen(), () => 'converted');
  for (const request of ordinary.requests) assert.equal('hdr' in request, false, 'an ordinary video is not told it is HDR, not even with an empty word');
  assert.equal('hdr' in ordinary.line.fields, false);
  assert.equal('coloursConverted' in ordinary.line.fields, false, 'the log says nothing about colours of a video that has no HDR');
  assert.deepEqual(ordinary.warnings, []);
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
  const requests: ClipRenderRequest[] = []; const asked: Array<{ sourcePath: string; startSeconds: number; endSeconds: number }> = []; const signals: Array<AbortSignal | undefined> = [];
  const plan: FramingPlan = { keyframes: [{ seconds: 0, position: 0.2 }, { seconds: 2, position: 0.6 }] };
  const framer: ClipFramer = { frame: async ({ signal, ...request }) => { asked.push(request); signals.push(signal); return { followed: true, plan, seenShare: 0.8, tracksFollowed: 1, note: 'Followed a face, seen in 80% of the moments checked.' }; } };
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, renderer: recordingRenderer(requests), framer, media: threeMinuteVideo });
  try {
    await addJob(ctx, 'j-face', { options: faceOptions });
    await ctx.pipeline.run('j-face');
    assert.equal((await ctx.db.getJob('j-face'))?.status, 'completed');
    assert.equal(requests.length, 2); assert.equal(asked.length, 2, 'one look for a face per clip');
    for (const [index, request] of requests.entries()) {
      assert.deepEqual(asked[index], { sourcePath: request.sourcePath, startSeconds: request.startSeconds, endSeconds: request.endSeconds, outputAspect: 9 / 16 }, 'the face is looked for in exactly the stretch that becomes the clip, for a window of the shape of the clip');
      assert.deepEqual(request.framing, plan, 'the renderer is given the plan');
      assert.ok(signals[index] instanceof AbortSignal && signals[index] === request.signal, 'the look for a face and the rendering are called off by the same signal: the one of the job');
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

test('a job notes which sound it listened to, so that deleting it can forget the transcript kept from that sound, and notes nothing when no transcript is kept', async () => {
  const noted = async (ctx: Context, id: string) => (await ctx.raw.query('SELECT audio_sha256 FROM video_jobs WHERE id = $1', [id])).rows[0]?.audio_sha256 as string | null;
  const engine = listeningEngine({ key: 'test-engine|1' });
  const ctx = await setup({ transcriber: engine, media: hearing, runtime: withCache });
  try {
    await addJob(ctx, 'j1'); await ctx.pipeline.run('j1');
    const sound = await noted(ctx, 'j1');
    assert.match(sound ?? '', /^[0-9a-f]{64}$/, 'the sound is named by its fingerprint');
    assert.equal((await ctx.raw.query('SELECT audio_sha256 FROM transcript_cache')).rows[0].audio_sha256, sound, 'the one the transcript is kept under');
    await addJob(ctx, 'j2'); await ctx.pipeline.run('j2');
    assert.deepEqual(heard(ctx), [false, true]);
    assert.equal(await noted(ctx, 'j2'), sound, 'a job that reused the transcript noted the same sound');
    await addJob(ctx, 'other-sound'); await writeFile(join(ctx.uploadDir, 'other-sound.mp4'), 'a different video, so a different sound');
    await ctx.pipeline.run('other-sound');
    assert.notEqual(await noted(ctx, 'other-sound'), sound, 'another sound, another fingerprint');
    assert.equal(ctx.errors.length, 0);
  } finally { await ctx.cleanup(); }

  for (const [label, key, days] of [['an engine that has no key', undefined, 30], ['keeping nothing (0 days)', 'test-engine|1', 0]] as const) {
    const plain = await setup({ transcriber: listeningEngine(key ? { key } : {}), media: hearing, runtime: { transcriptCacheDays: days } });
    try {
      await addJob(plain, 'a'); await plain.pipeline.run('a');
      assert.equal((await plain.db.getJob('a'))?.status, 'completed');
      assert.equal(await noted(plain, 'a'), null, `${label}: no transcript is kept, so there is no sound to note`);
    } finally { await plain.cleanup(); }
  }
});

test('when the sound of a job cannot be noted the job is done all the same, and the log says what will not be forgotten', async () => {
  const unnoted = (db: StudioDatabase) => new Proxy(db, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (property === 'recordAudioFingerprint') return () => Promise.reject(new Error('the database is out of order'));
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const engine = listeningEngine({ key: 'test-engine|1' });
  const ctx = await setup({ transcriber: engine, media: hearing, runtime: withCache, database: unnoted });
  try {
    await addJob(ctx, 'j1'); await ctx.pipeline.run('j1');
    const job = await ctx.db.getJob('j1');
    assert.equal(job?.status, 'completed', job?.errorMessage ?? '');
    assert.equal((await ctx.db.listClips('j1')).filter((clip) => clip.status === 'completed').length, 1);
    assert.ok(ctx.errors.some((message) => /Could not note which sound this job listened to/.test(message)), 'the log says why');
    assert.equal((await ctx.raw.query('SELECT audio_sha256 FROM video_jobs WHERE id = $1', ['j1'])).rows[0].audio_sha256, null);
    assert.equal((await ctx.raw.query('SELECT count(*)::int AS n FROM transcript_cache')).rows[0].n, 1, 'the transcript is still kept for reuse');
    assert.doesNotMatch(String(job?.errorMessage ?? ''), /out of order/, 'nothing of it reaches the person');
  } finally { await ctx.cleanup(); }
});

// ---- what a person is told when a job fails ---------------------------------------------------------------------------------------

/** Something that goes wrong the way things go wrong on a server: the words carry a folder, a program, an address. */
const SECRET = '/opt/render/project/src/.render/whisper-cli (connect ECONNREFUSED 10.1.2.3:5432, postgres://user:hunter2@db.example.test/prod)';
const noTrace = (message: string | null | undefined) => {
  assert.ok(message, 'there is a message');
  assert.doesNotMatch(message, /\/opt\/|\/tmp\/|whisper-cli|ECONNREFUSED|10\.1\.2\.3|hunter2|postgres:|db\.example|\.mp4|\.wav|ffmpeg|ffprobe|exit code|signal|stderr|stdout|Error:/i, `a person must not read this: ${message}`);
};

test('whatever goes wrong in a stage, the person is told in general words that fit the stage, and the log has the real cause', async () => {
  const cases: Array<{ stage: string; setup: () => Parameters<typeof setup>[0]; words: string }> = [
    { stage: 'probing_video', setup: () => ({ media: { probe: async () => { throw new Error(`spawn ${SECRET} ENOENT`); }, extractAudio: fakeMedia.extractAudio } }), words: plainWords.jobServer },
    { stage: 'extracting_audio', setup: () => ({ media: { probe: fakeMedia.probe, extractAudio: async () => { throw new Error(`spawn ${SECRET} ENOENT`); } } }), words: plainWords.jobServer },
    { stage: 'transcribing', setup: () => ({ transcriber: { transcribe: async () => { throw new Error(SECRET); } } }), words: 'The speech in this video could not be turned into text. Please try again, or try another video.' },
    { stage: 'extracting_clips', setup: () => ({ renderer: { render: async () => { throw new Error(SECRET); } } }), words: 'None of the 1 clip could be made from this video. Please try again, or try another video.' },
  ];
  for (const { stage, setup: options, words } of cases) {
    const ctx = await setup(options());
    try {
      await addJob(ctx, 'plain'); await ctx.pipeline.run('plain');
      const job = await ctx.db.getJob('plain');
      assert.equal(job?.status, 'failed', stage);
      assert.equal(job?.errorMessage, words, stage);
      noTrace(job?.errorMessage);
      assert.ok(logged(ctx, 'ECONNREFUSED'), `${stage}: the log has the real cause`);
      assert.ok(ctx.errorFields.some((fields) => fields.stage === stage || stage === 'extracting_clips'), `${stage}: and says in which stage it happened`);
      for (const clip of await ctx.db.listClips('plain')) noTrace(clip.errorMessage);
    } finally { await ctx.cleanup(); }
  }
});

test('what is wrong with the video itself is told as it was written, the reason behind it kept for the log', async () => {
  const unreadable = new PlainFailure(plainWords.unreadableVideo, { cause: new Error(`${SECRET}: moov atom not found`) });
  const ctx = await setup({ media: { probe: async () => { throw unreadable; }, extractAudio: fakeMedia.extractAudio } });
  try {
    await addJob(ctx, 'bad'); await ctx.pipeline.run('bad');
    const job = await ctx.db.getJob('bad');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.errorMessage, plainWords.unreadableVideo);
    noTrace(job?.errorMessage);
    assert.ok(logged(ctx, 'moov atom not found'), 'the real reason is in the log, as what the failure was made from');
  } finally { await ctx.cleanup(); }
});

test('a video without any sound fails at once, in words that say so, before anything is listened to or made', async () => {
  let listened = 0; let extracted = 0;
  const silent = { probe: async () => ({ durationSeconds: 6, width: 1920, height: 1080, hasAudio: false }), extractAudio: async () => { extracted += 1; } };
  const ctx = await setup({ media: silent, transcriber: { transcribe: async () => { listened += 1; return []; } } });
  try {
    await addJob(ctx, 'quiet'); await ctx.pipeline.run('quiet');
    const job = await ctx.db.getJob('quiet');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.errorMessage, plainWords.noSound);
    assert.match(job?.errorMessage ?? '', /no sound/);
    assert.deepEqual({ listened, extracted }, { listened: 0, extracted: 0 }, 'no time is spent on a video there is nothing to listen to in');
    assert.equal(job?.width, 1920, 'what was learned about the picture is kept');
    assert.deepEqual(await ctx.db.listClips('quiet'), []);
    assert.deepEqual(await readdir(ctx.uploadDir), [], 'and the local copy is freed as for any failed job');

    // A look that does not say either way (a stand-in, an older answer) is not taken for silence.
    const unsure = await setup({ media: { probe: async () => ({ durationSeconds: 6, width: 1920, height: 1080 }), extractAudio: fakeMedia.extractAudio } });
    try {
      await addJob(unsure, 'unsure'); await unsure.pipeline.run('unsure');
      assert.equal((await unsure.db.getJob('unsure'))?.status, 'completed', 'a video that was not said to be silent is tried');
    } finally { await unsure.cleanup(); }
  } finally { await ctx.cleanup(); }
});

test('a video that is no longer on the server, and was not saved anywhere else, is told so in words that say what to do', async () => {
  const cases: Array<{ name: string; options: Parameters<typeof setup>[0]; words: string }> = [
    { name: 'without durable storage', options: { storage: new NullStorage() }, words: 'The uploaded video is no longer on the server. Please upload it again.' },
    { name: 'with durable storage, but the video never reached it', options: {}, words: 'The uploaded video is no longer on the server and was never saved. Please upload it again.' },
  ];
  for (const { name, options, words } of cases) {
    const ctx = await setup(options);
    try {
      await addJob(ctx, 'gone', { local: false }); await ctx.pipeline.run('gone');
      const job = await ctx.db.getJob('gone');
      assert.equal(job?.status, 'failed', name);
      assert.equal(job?.errorMessage, words, name);
      noTrace(job?.errorMessage);
    } finally { await ctx.cleanup(); }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Stopping a job: whatever a job has got to, `VideoPipeline.stop` ends it as stopped and throws away what it made.

const stopWords = 'Video processing was stopped by the person who uploaded it';
const savedFirst = ['preparing_source', 'saving_source'];
const upToTranscribing = [...savedFirst, 'probing_video', 'extracting_audio', 'transcribing'];
const upToClips = [...upToTranscribing, 'detecting_highlights', 'extracting_clips'];
const killed = new Error('ffmpeg was ended by the signal SIGKILL');
const twoClips: JobOptions = { ...defaultJobOptions, clipCount: 2, clipLength: 'short' };

/** Work that listens for a stop like the real engines do: it never ends by itself and fails the moment its job is stopped (with the reason of the stop, or with `failure` when an engine fails in a way of its own). `entered` says that the job has got to it. */
function untilStopped(signal: AbortSignal | undefined, entered: () => void, failure?: Error): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const end = () => reject(failure ?? signal?.reason);
    entered();
    if (signal?.aborted) end(); else signal?.addEventListener('abort', end, { once: true });
  });
}

/** Wraps the database so that `before` runs, and is waited for, ahead of every call of the method `name` (it is given the arguments of the call): a way of making something happen at an exact moment of a job. */
function beforeCall(name: string, before: (args: unknown[]) => Promise<void> | void) {
  return (db: StudioDatabase): StudioDatabase => new Proxy(db, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    if (property !== name) return (...args: unknown[]) => value.apply(target, args);
    return async (...args: unknown[]) => { await before(args); return value.apply(target, args); };
  } });
}

/** What a job that was stopped has come to once everything is over: it ended as stopped, nothing it made is kept (on disk or in storage), its video is released, and the stop was told as information and not as a failure. */
async function assertEndedAsStopped(ctx: Context, jobId: string, options: { stage: string | undefined; stages: string[]; discarded?: number }) {
  const job = await ctx.db.getJob(jobId);
  assert.deepEqual({ status: job?.status, stage: job?.stage, errorMessage: job?.errorMessage, sourceStorageKey: job?.sourceStorageKey }, { status: 'failed', stage: 'stopped', errorMessage: plainWords.stopped, sourceStorageKey: null });
  assert.deepEqual(Object.keys(job?.stageTimings ?? {}), options.stages, 'the stages the job had entered when it was stopped, and no others');
  assert.deepEqual(await ctx.db.listClips(jobId), [], 'a stopped job keeps no clips');
  assert.deepEqual([...(ctx.storage as MemoryStorage).objects.keys()].filter((key) => key.includes(jobId)), [], 'nothing of a stopped job is left in storage, its video included');
  assert.equal(existsSync(join(ctx.outputDir, jobId)), false, 'no clips are left on disk');
  assert.equal(existsSync(join(ctx.uploadDir, `${jobId}.mp4`)), false, 'the video is not kept on the server');
  assert.deepEqual(ctx.errors, [], 'a stop is not an error');
  assert.deepEqual(ctx.infos.filter((entry) => entry.message === stopWords).map((entry) => ({ jobId: entry.fields.jobId, stage: entry.fields.stage })), [{ jobId, stage: options.stage }], 'the stop is told once, with the stage it came in');
  assert.deepEqual(ctx.infos.filter((entry) => entry.message === 'Discarded the clips of a video that was stopped').map((entry) => ({ jobId: entry.fields.jobId, discardedClipCount: entry.fields.discardedClipCount })), options.discarded ? [{ jobId, discardedClipCount: options.discarded }] : [], 'what was thrown away is told, with how many clips it was');
  assert.equal(ctx.pipeline.isStopping(jobId), false, 'nothing keeps stopping once the job is over');
}

/** What each kind of work does when its job is stopped. */
type StopScenario = { name: string; stage: string; stages: string[]; options?: JobOptions; rendered: number; madeClips: boolean; discarded: number; engines: (entered: () => void, calls: { rendered: number }) => NonNullable<Parameters<typeof setup>[0]> };
const stopScenarios: StopScenario[] = [
  { name: 'FFmpeg is reading the video', stage: 'probing_video', stages: [...savedFirst, 'probing_video'], rendered: 0, madeClips: false, discarded: 0,
    engines: (entered) => ({ media: { ...fakeMedia, probe: (_input, signal) => untilStopped(signal, entered) } }) },
  { name: 'the sound is being taken out of the video (the program fails in a way of its own when it is ended)', stage: 'extracting_audio', stages: [...savedFirst, 'probing_video', 'extracting_audio'], rendered: 0, madeClips: false, discarded: 0,
    engines: (entered) => ({ media: { ...fakeMedia, extractAudio: (_input, _output, signal) => untilStopped(signal, entered, killed) } }) },
  { name: 'the speech is being recognised', stage: 'transcribing', stages: upToTranscribing, rendered: 0, madeClips: false, discarded: 0,
    engines: (entered) => ({ transcriber: { transcribe: (_audio, _dir, _progress, signal) => untilStopped(signal, entered) } }) },
  { name: 'a face is being looked for', stage: 'extracting_clips', stages: upToClips, options: faceOptions, rendered: 0, madeClips: false, discarded: 0,
    engines: (entered, calls) => ({ transcriber: { transcribe: async () => threeMinutes }, media: threeMinuteVideo, framer: { frame: ({ signal }) => untilStopped(signal, entered) }, renderer: { render: (request) => { calls.rendered += 1; return writingRenderer.render(request); } } }) },
  { name: 'the first clip is being made (the program fails in a way of its own when it is ended)', stage: 'extracting_clips', stages: upToClips, rendered: 1, madeClips: false, discarded: 1,
    engines: (entered, calls) => ({ renderer: { render: (request) => { calls.rendered += 1; return untilStopped(request.signal, entered, killed); } } }) },
  { name: 'a later clip is being made, after one was finished and saved', stage: 'extracting_clips', stages: upToClips, options: twoClips, rendered: 2, madeClips: true, discarded: 2,
    engines: (entered, calls) => ({ transcriber: { transcribe: async () => threeMinutes }, media: threeMinuteVideo, renderer: { render: (request) => { calls.rendered += 1; return calls.rendered === 1 ? writingRenderer.render(request) : untilStopped(request.signal, entered, killed); } } }) },
];

for (const scenario of stopScenarios) {
  test(`a stop while ${scenario.name} ends the job as stopped: what runs is called off, what was made is thrown away, and nothing is told as a failure`, async () => {
    let entered = false; const calls = { rendered: 0 };
    const ctx = await setup(scenario.engines(() => { entered = true; }, calls));
    try {
      await addJob(ctx, 'j-stop', scenario.options ? { options: scenario.options } : {});
      const running = ctx.pipeline.run('j-stop');
      await waitUntil(`the job to be at the point where ${scenario.name}`, () => entered);
      if (scenario.madeClips) assert.ok([...(ctx.storage as MemoryStorage).uploaded.keys()].some((key) => key.startsWith('j-stop/')), 'a clip was made and saved before the stop');
      assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
      assert.equal(ctx.pipeline.isStopping('j-stop'), true, 'the job is being stopped, which is what its page says');
      await within(running, 8000, 'the job did not end after it was stopped');
      await assertEndedAsStopped(ctx, 'j-stop', { stage: scenario.stage, stages: scenario.stages, discarded: scenario.discarded });
      assert.equal(calls.rendered, scenario.rendered, 'no clip was started after the stop');
    } finally { await ctx.cleanup(); }
  });
}

test('a stop that arrives before the job has begun any work ends it at once: nothing is saved, nothing is run, and nothing of it is left', async () => {
  let ctx!: Context; let probed = 0; let outcome: StopOutcome | undefined;
  ctx = await setup({ media: { ...fakeMedia, probe: async () => { probed += 1; return fakeMedia.probe(); } }, database: beforeCall('beginAttempt', async ([id]) => { outcome = await ctx.pipeline.stop(String(id)); }) });
  try {
    await addJob(ctx, 'j-stop');
    await within(ctx.pipeline.run('j-stop'), 8000, 'the job did not end after it was stopped');
    assert.equal(outcome, 'stopping');
    await assertEndedAsStopped(ctx, 'j-stop', { stage: undefined, stages: [] });
    assert.equal(probed, 0, 'the video was read although the job was stopped');
    assert.deepEqual((ctx.storage as MemoryStorage).log.filter((entry) => entry.startsWith('upload:')), [], 'the video was saved although the job was stopped');
  } finally { await ctx.cleanup(); }
});

test('a stop that arrives while the pipeline itself is at work (not an engine) is seen at the next change of stage: no clip is started', async () => {
  let ctx!: Context; const calls = { rendered: 0 };
  ctx = await setup({ renderer: { render: (request) => { calls.rendered += 1; return writingRenderer.render(request); } }, database: beforeCall('replaceHighlights', async ([id]) => { await ctx.pipeline.stop(String(id)); }) });
  try {
    await addJob(ctx, 'j-stop');
    await within(ctx.pipeline.run('j-stop'), 8000, 'the job did not end after it was stopped');
    await assertEndedAsStopped(ctx, 'j-stop', { stage: 'detecting_highlights', stages: [...upToTranscribing, 'detecting_highlights'] });
    assert.equal(calls.rendered, 0, 'a clip was started after the stop');
  } finally { await ctx.cleanup(); }
});

test('stopping a job that reuses a transcript harms nothing that is kept for reuse: the next job still reuses it', async () => {
  let ctx!: Context; const engine = listeningEngine({ key: 'test-engine|1' });
  ctx = await setup({ transcriber: engine, media: hearing, runtime: withCache, database: beforeCall('replaceTranscript', async ([id]) => { if (id === 'jb') await ctx.pipeline.stop('jb'); }) });
  try {
    await addJob(ctx, 'ja'); await ctx.pipeline.run('ja');
    assert.equal(engine.calls, 1);
    await addJob(ctx, 'jb'); await within(ctx.pipeline.run('jb'), 8000, 'the job did not end after it was stopped');
    await assertEndedAsStopped(ctx, 'jb', { stage: 'reusing_transcript', stages: [...savedFirst, 'probing_video', 'extracting_audio', 'reusing_transcript'] });
    await addJob(ctx, 'jc'); await ctx.pipeline.run('jc');
    assert.equal((await ctx.db.getJob('jc'))?.status, 'completed');
    assert.equal(engine.calls, 1, 'the speech was listened to again although its transcript was kept');
  } finally { await ctx.cleanup(); }
});

/** Storage whose uploads wait for `gate` before they do anything: a transfer of a big video that takes a while. */
class SlowUploads extends MemoryStorage {
  gate: Promise<void> = Promise.resolve();
  override async upload(localPath: string, key: string) { this.log.push(`reached:${key}`); await this.gate; return super.upload(localPath, key); }
}
/** Storage that cannot be read for as long as `gate` is closed, and then fails, like a storage service having a bad minute. */
class BrokenReads extends MemoryStorage {
  constructor(private readonly gate: Promise<void>) { super(); }
  override async download(key: string, _localPath: string) { this.log.push(`download:${key}`); await this.gate; throw new Error('simulated storage outage'); }
}

test('a stop while the uploaded video is being saved does not break the transfer off: it is finished, and the job then ends as stopped without any work', async () => {
  let release!: () => void; const storage = new SlowUploads(); storage.gate = new Promise<void>((resolve) => { release = resolve; });
  let probed = 0;
  const ctx = await setup({ storage, media: { ...fakeMedia, probe: async () => { probed += 1; return fakeMedia.probe(); } } });
  try {
    await addJob(ctx, 'j-stop');
    const running = ctx.pipeline.run('j-stop');
    await waitUntil('the video to be on its way to storage', () => storage.log.includes('reached:sources/j-stop/source.mp4'));
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
    await sleep(100);
    assert.equal((await ctx.db.getJob('j-stop'))?.stage, 'saving_source', 'the transfer was broken off');
    release();
    await within(running, 8000, 'the job did not end after it was stopped');
    assert.ok(storage.uploaded.has('sources/j-stop/source.mp4'), 'the transfer was not finished');
    assert.equal(probed, 0, 'the video was read although the job was stopped');
    await assertEndedAsStopped(ctx, 'j-stop', { stage: 'saving_source', stages: savedFirst });
  } finally { await ctx.cleanup(); }
});

test('a stop wins over a video that could not be read back at that moment: the job ends as stopped and is not left to be tried again, its stored video is released, and nothing is resumed', async () => {
  let release!: () => void; const storage = new BrokenReads(new Promise<void>((resolve) => { release = resolve; }));
  const ctx = await setup({ storage });
  try {
    await addJob(ctx, 'j-stop', { status: 'processing', local: false, durable: true, attempts: 1 });
    const running = ctx.pipeline.run('j-stop');
    await waitUntil('the video to be read back', () => storage.log.includes('download:sources/j-stop/source.mp4'));
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
    release();
    await within(running, 8000, 'the job did not end after it was stopped');
    await assertEndedAsStopped(ctx, 'j-stop', { stage: 'restoring_source', stages: ['preparing_source', 'restoring_source'] });
    assert.deepEqual(await ctx.pipeline.recoverInterruptedJobs(), { resumed: [], failed: [], waiting: 0 }, 'a stopped job is over: nothing is resumed');
  } finally { await ctx.cleanup(); }
});

/** An engine that holds the place for the heavy stages (its job is "listening") until `release` is called, and lets every other job through. */
function holdingTheFirst(release: Promise<void>, listened: string[]): TranscriptionEngine {
  return { transcribe: async (_audio: string, workDir: string) => {
    const who = basename(workDir).split('-')[0]!;
    listened.push(who);
    if (who === 'ja') await release;
    return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'words' }];
  } };
}

test('a job that is waiting for its turn is stopped at once: it gives up its place without disturbing the job in front of it, and the job behind it still gets its turn', async () => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const listened: string[] = [];
  const ctx = await setup({ transcriber: holdingTheFirst(blocked, listened) });
  try {
    await addJob(ctx, 'ja'); await addJob(ctx, 'jb'); await addJob(ctx, 'jc');
    const first = ctx.pipeline.run('ja');
    await waitUntil('the first job to be listening', () => listened.includes('ja'));
    const second = ctx.pipeline.run('jb');
    await eventually('the second job to wait for a place', async () => (await ctx.db.getJob('jb'))?.stage, (stage) => stage === 'waiting_for_capacity');
    const third = ctx.pipeline.run('jc');
    await eventually('the third job to wait for a place', async () => (await ctx.db.getJob('jc'))?.stage, (stage) => stage === 'waiting_for_capacity');
    assert.equal(await ctx.pipeline.stop('jb'), 'stopping');
    await within(second, 8000, 'the stopped job went on waiting for a place');
    await assertEndedAsStopped(ctx, 'jb', { stage: 'waiting_for_capacity', stages: [...savedFirst, 'waiting_for_capacity'] });
    const [front, behind] = await Promise.all([ctx.db.getJob('ja'), ctx.db.getJob('jc')]);
    assert.equal(front?.stage, 'transcribing', 'the job that had the place was disturbed');
    assert.deepEqual({ status: behind?.status, stage: behind?.stage }, { status: 'queued', stage: 'waiting_for_capacity' }, 'the job behind was moved');
    release();
    await within(Promise.all([first, third]), 8000, 'the jobs that were not stopped did not finish');
    assert.deepEqual(listened, ['ja', 'jc'], 'the stopped job took a turn, or the job behind it lost its turn');
    assert.deepEqual([(await ctx.db.getJob('ja'))?.status, (await ctx.db.getJob('jc'))?.status], ['completed', 'completed']);
  } finally { await ctx.cleanup(); }
});

test('a stop that arrives while the job is saying that it is waiting for a place is not missed: the job ends at once, although the place is still held', async () => {
  let ctx!: Context; let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const listened: string[] = [];
  ctx = await setup({ transcriber: holdingTheFirst(blocked, listened), database: beforeCall('updateJob', async ([id, fields]) => { if (id === 'jb' && (fields as { stage?: string }).stage === 'waiting_for_capacity') await ctx.pipeline.stop('jb'); }) });
  try {
    await addJob(ctx, 'ja'); await addJob(ctx, 'jb');
    const first = ctx.pipeline.run('ja');
    await waitUntil('the first job to be listening', () => listened.includes('ja'));
    await within(ctx.pipeline.run('jb'), 8000, 'the job stayed in line although it was stopped: it only ended once the place was free');
    await assertEndedAsStopped(ctx, 'jb', { stage: 'waiting_for_capacity', stages: [...savedFirst, 'waiting_for_capacity'] });
    assert.equal((await ctx.db.getJob('ja'))?.stage, 'transcribing', 'the job that had the place was disturbed');
    release();
    await within(first, 8000, 'the job that was not stopped did not finish');
    assert.equal((await ctx.db.getJob('ja'))?.status, 'completed');
    assert.deepEqual(listened, ['ja']);
  } finally { await ctx.cleanup(); }
});

test('stopping tells a person what is true of their video: it does not exist, it is over already, or this server is not working on it', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx, 'j-done', { status: 'completed' }); await addJob(ctx, 'j-failed', { status: 'failed' });
    await addJob(ctx, 'j-waiting');                          // saved, and nobody is working on it
    await addJob(ctx, 'j-elsewhere', { status: 'processing' }); // being worked on, but not by this process (another server, or it died)
    assert.deepEqual(await Promise.all(['nothing-like-it', 'j-done', 'j-failed', 'j-waiting', 'j-elsewhere'].map((id) => ctx.pipeline.stop(id))), ['missing', 'already over', 'already over', 'not running here', 'not running here']);
    assert.deepEqual(await Promise.all(['j-done', 'j-failed', 'j-waiting', 'j-elsewhere'].map(async (id) => (await ctx.db.getJob(id))?.status)), ['completed', 'failed', 'queued', 'processing'], 'asking for a stop changed a job that was not being worked on');
    assert.deepEqual(['j-done', 'j-waiting', 'nothing-like-it'].map((id) => ctx.pipeline.isStopping(id)), [false, false, false]);
  } finally { await ctx.cleanup(); }
});

test('a job that is being stopped says so until its clean-up is over; stopping it again is harmless, and afterwards it is over', async () => {
  let ctx!: Context; let cleanUp!: () => void; const held = new Promise<void>((resolve) => { cleanUp = resolve; }); let entered = false;
  ctx = await setup({ transcriber: { transcribe: (_audio, _dir, _progress, signal) => untilStopped(signal, () => { entered = true; }) }, database: beforeCall('deleteClipsForJob', async ([id]) => { if (ctx.pipeline.isStopping(String(id))) await held; }) });
  try {
    await addJob(ctx, 'j-stop');
    assert.equal(ctx.pipeline.isStopping('j-stop'), false, 'a job nobody works on is not being stopped');
    const running = ctx.pipeline.run('j-stop');
    await waitUntil('the job to be listening', () => entered);
    assert.equal(ctx.pipeline.isStopping('j-stop'), false, 'a job that is being worked on is not being stopped');
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
    assert.equal(ctx.pipeline.isStopping('j-stop'), true);
    await sleep(100);
    assert.deepEqual({ status: (await ctx.db.getJob('j-stop'))?.status, stopping: ctx.pipeline.isStopping('j-stop') }, { status: 'processing', stopping: true }, 'the job reads as over before its clean-up is');
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping', 'asking again for a stop that is under way');
    cleanUp();
    await within(running, 8000, 'the job did not end after it was stopped');
    assert.equal(await ctx.pipeline.stop('j-stop'), 'already over');
    await assertEndedAsStopped(ctx, 'j-stop', { stage: 'transcribing', stages: upToTranscribing });
  } finally { await ctx.cleanup(); }
});

test('an engine that does not listen for the stop gets the job no further: its transcript arrives and the next stage is never started', async () => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; }); let entered = false; const calls = { rendered: 0 };
  const deaf: TranscriptionEngine = { transcribe: async () => { entered = true; await blocked; return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'words' }]; } };
  const ctx = await setup({ transcriber: deaf, renderer: { render: (request) => { calls.rendered += 1; return writingRenderer.render(request); } } });
  try {
    await addJob(ctx, 'j-stop');
    const running = ctx.pipeline.run('j-stop');
    await waitUntil('the job to be listening', () => entered);
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
    release();
    await within(running, 8000, 'the job did not end after it was stopped');
    await assertEndedAsStopped(ctx, 'j-stop', { stage: 'transcribing', stages: upToTranscribing });
    assert.equal(calls.rendered, 0, 'a clip was made after the stop');
  } finally { await ctx.cleanup(); }
});

test('a renderer that does not listen for the stop makes its clips, and the job still ends as stopped with none of them kept', async () => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; }); let entered = false; const calls = { rendered: 0 };
  const deaf: ClipRenderer = { render: async (request) => { calls.rendered += 1; if (calls.rendered === 1) { entered = true; await blocked; } return writingRenderer.render(request); } };
  const ctx = await setup({ transcriber: { transcribe: async () => threeMinutes }, media: threeMinuteVideo, renderer: deaf });
  try {
    await addJob(ctx, 'j-stop', { options: twoClips });
    const running = ctx.pipeline.run('j-stop');
    await waitUntil('the first clip to be made', () => entered);
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
    release();
    await within(running, 8000, 'the job did not end after it was stopped');
    assert.equal(calls.rendered, 2, 'an engine that does not listen does all its work');
    assert.ok([...(ctx.storage as MemoryStorage).uploaded.keys()].some((key) => key.startsWith('j-stop/')), 'its clips were saved');
    await assertEndedAsStopped(ctx, 'j-stop', { stage: 'extracting_clips', stages: upToClips, discarded: 2 });
  } finally { await ctx.cleanup(); }
});

/** The engines of a job that has finished one clip when the second is being made (the second ends when the job is stopped). */
const afterOneClip = (entered: () => void, calls: { rendered: number }): NonNullable<Parameters<typeof setup>[0]> => ({ transcriber: { transcribe: async () => threeMinutes }, media: threeMinuteVideo, renderer: { render: (request) => { calls.rendered += 1; return calls.rendered === 1 ? writingRenderer.render(request) : untilStopped(request.signal, entered, killed); } } });

test('when what a stopped job made cannot be thrown away, the job still ends as stopped and the operator is told what went wrong', async () => {
  let ctx!: Context; let entered = false;
  ctx = await setup({ ...afterOneClip(() => { entered = true; }, { rendered: 0 }), database: beforeCall('deleteClipsForJob', ([id]) => { if (ctx.pipeline.isStopping(String(id))) throw new Error('the database refused'); }) });
  try {
    await addJob(ctx, 'j-stop', { options: twoClips });
    const running = ctx.pipeline.run('j-stop');
    await waitUntil('the second clip to be made', () => entered);
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
    await within(running, 8000, 'the job did not end after it was stopped');
    const job = await ctx.db.getJob('j-stop');
    assert.deepEqual({ status: job?.status, stage: job?.stage, errorMessage: job?.errorMessage }, { status: 'failed', stage: 'stopped', errorMessage: plainWords.stopped });
    assert.deepEqual(ctx.errors, ['Could not discard the clips of a video that was stopped']);
    assert.ok(logged(ctx, 'the database refused'), 'what really went wrong is kept for the operator');
  } finally { await ctx.cleanup(); }
});

test('objects of a stopped job that cannot be deleted from storage are told one by one in the words of a stop, and the job still ends as stopped', async () => {
  let entered = false; const storage = new MemoryStorage();
  const ctx = await setup({ ...afterOneClip(() => { entered = true; }, { rendered: 0 }), storage });
  try {
    await addJob(ctx, 'j-stop', { options: twoClips });
    const running = ctx.pipeline.run('j-stop');
    await waitUntil('the second clip to be made', () => entered);
    storage.failDeletes = true;
    assert.equal(await ctx.pipeline.stop('j-stop'), 'stopping');
    await within(running, 8000, 'the job did not end after it was stopped');
    const job = await ctx.db.getJob('j-stop');
    assert.deepEqual({ status: job?.status, stage: job?.stage, errorMessage: job?.errorMessage }, { status: 'failed', stage: 'stopped', errorMessage: plainWords.stopped });
    const ofClips: string[] = ctx.errors.filter((message) => message === 'Could not delete an object of a clip of a video that was stopped');
    assert.equal(ofClips.length, 4, 'each of the two clips has a video and captions to delete');
    assert.deepEqual(ctx.errors.filter((message) => !ofClips.includes(message)), ['Could not delete the stored copy of the uploaded video']);
    assert.deepEqual(await ctx.db.listClips('j-stop'), [], 'the clips are forgotten even when their objects could not be deleted');
  } finally { await ctx.cleanup(); }
});

test('everything a job runs is given one and the same signal, a job that is left alone is never told to stop, and every job has a signal of its own', async () => {
  const seen = new Map<string, Array<AbortSignal | undefined>>();
  const note = (path: string, signal: AbortSignal | undefined) => { const job = basename(path).split(/[-.]/)[0]!; seen.set(job, [...(seen.get(job) ?? []), signal]); };
  const plan: FramingPlan = { keyframes: [{ seconds: 0, position: 0.5 }] };
  const ctx = await setup({
    media: { probe: async (input, signal) => { note(input, signal); return threeMinuteVideo.probe(); }, extractAudio: async (input, output, signal) => { note(input, signal); await writeFile(output, 'mock wav'); } },
    transcriber: { transcribe: async (_audio, workDir, _progress, signal) => { note(workDir, signal); return threeMinutes; } },
    framer: { frame: async ({ sourcePath, signal }) => { note(sourcePath, signal); return { followed: true, plan, seenShare: 1, tracksFollowed: 1, note: 'Followed a face.' }; } },
    renderer: { render: async (request) => { note(request.sourcePath, request.signal); return writingRenderer.render(request); } },
  });
  try {
    await addJob(ctx, 'ja', { options: faceOptions }); await addJob(ctx, 'jb', { options: faceOptions });
    await ctx.pipeline.run('ja'); await ctx.pipeline.run('jb');
    for (const job of ['ja', 'jb']) {
      const signals = seen.get(job) ?? [];
      assert.equal(signals.length, 7, 'the video was read, its sound taken out and listened to, and two clips looked at and made');
      assert.ok(signals[0] instanceof AbortSignal, 'the work was given a signal');
      assert.ok(signals.every((signal) => signal === signals[0]), 'each piece of work of a job has its own signal, so that a stop does not reach all of them');
      assert.equal(signals[0]?.aborted, false, 'a job that was left alone was told to stop');
    }
    assert.notEqual(seen.get('ja')?.[0], seen.get('jb')?.[0], 'two jobs share one signal: stopping one would stop the other');
    assert.deepEqual([(await ctx.db.getJob('ja'))?.status, (await ctx.db.getJob('jb'))?.status], ['completed', 'completed']);
  } finally { await ctx.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------------
// The places for the heavy stages, and what a stop does to a job that waits for one.

test('a place is not taken by a job that was stopped already, and a free place is taken at once', async () => {
  const slots = new Semaphore(1);
  const stopped = new AbortController(); stopped.abort(new JobStopped());
  await assert.rejects(slots.acquire(stopped.signal), (error) => error === stopped.signal.reason);
  assert.equal(slots.isFull, false, 'a job that was stopped took a place');
  const live = new AbortController();
  await slots.acquire(live.signal);
  assert.equal(slots.isFull, true);
  assert.equal(getEventListeners(live.signal, 'abort').length, 0, 'taking a free place leaves something waiting for a stop');
  live.abort(new JobStopped());
  assert.equal(slots.isFull, true, 'a stop after the place was taken gave it back (the job gives it back when it ends)');
  slots.release();
  assert.equal(slots.isFull, false);
});

test('a job that is stopped while it waits gives up its place in line: it fails with the reason of the stop, the place stays with whoever holds it, and the others keep their order', async () => {
  const slots = new Semaphore(1); await slots.acquire();
  const stop = new AbortController(); const order: string[] = [];
  const first = slots.acquire().then(() => { order.push('first'); });
  const middle = slots.acquire(stop.signal).then(() => { order.push('middle took a place'); }, (reason: unknown) => { order.push(reason instanceof JobStopped ? 'middle gave up' : 'middle failed in another way'); });
  const last = slots.acquire().then(() => { order.push('last'); });
  stop.abort(new JobStopped());
  await within(middle, 1000, 'a job that was stopped went on waiting');
  assert.deepEqual(order, ['middle gave up']);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0, 'a job that gave up leaves something waiting for a stop');
  assert.equal(slots.isFull, true, 'giving up a place in line freed the place that someone holds');
  slots.release(); await within(first, 1000, 'the job in front of the one that gave up was not served');
  slots.release(); await within(last, 1000, 'the job behind the one that gave up was not served');
  assert.deepEqual(order, ['middle gave up', 'first', 'last']);
  slots.release();
  assert.equal(slots.isFull, false);
});

test('a job that was handed the place in the very moment it is stopped keeps it until it gives it back, and the job behind it is not lost', async () => {
  const slots = new Semaphore(1); await slots.acquire();
  const stop = new AbortController();
  const handedOver = slots.acquire(stop.signal);
  const behind = slots.acquire(); const served = behind.then(() => 'served');
  slots.release();                     // the place is handed to the first in line...
  stop.abort(new JobStopped());        // ...and in the same moment, before its job has even got going, that job is stopped
  await within(handedOver, 1000, 'the job that was handed the place never got it');
  assert.equal(slots.isFull, true);
  slots.release();                     // the stopped job gives the place back, as it does when a job ends
  assert.equal(await within(served, 1000, 'the job behind a stopped one was lost: it is still waiting although the place is free'), 'served');
  slots.release();
  assert.equal(slots.isFull, false);
});

// ---- Who works and who waits (the line a person is shown) ----

test('the places for the heavy stages say how many there are, and who waits for one, in the order they will be let in', async () => {
  const slots = new Semaphore(2);
  assert.equal(slots.places, 2);
  assert.deepEqual(slots.waitingLabels(), []);
  await slots.acquire(); await slots.acquire();
  const stop = new AbortController();
  const order: string[] = [];
  const wait = (label: string | undefined, signal?: AbortSignal) => slots.acquire(signal, label).then(() => { order.push(label ?? '(no label)'); }, () => { order.push(`${label} gave up`); });
  const a = wait('a'); const b = wait('b', stop.signal); const anonymous = wait(undefined); const c = wait('c');
  assert.deepEqual(slots.waitingLabels(), ['a', 'b', 'c'], 'in arrival order, and one that gave no label is not listed');
  stop.abort(new JobStopped());
  await within(b, 1000, 'a job that was stopped went on waiting');
  assert.deepEqual(slots.waitingLabels(), ['a', 'c'], 'a job that gave up its place in line is no longer in the line');
  slots.release(); await within(a, 1000, 'the first in line was not served');
  assert.deepEqual(slots.waitingLabels(), ['c'], 'a job that was let in is no longer waiting');
  slots.release(); await within(anonymous, 1000, 'the one without a label was not served');
  slots.release(); await within(c, 1000, 'the last in line was not served');
  assert.deepEqual(slots.waitingLabels(), []);
  assert.deepEqual(order, ['b gave up', 'a', '(no label)', 'c']);
});

test('the pipeline says who has the place, who waits in what order, and where the job that is working has got to', async () => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const listened: string[] = [];
  const ctx = await setup({ transcriber: { transcribe: async (_audio: string, workDir: string, onProgress?: (fraction: number) => void) => {
    const who = basename(workDir).split('-')[0]!; listened.push(who);
    if (who === 'ja') { onProgress?.(0.5); await blocked; }
    return [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'words' }];
  } } });
  try {
    assert.deepEqual(ctx.pipeline.queueView(), { places: 1, running: [], waiting: [], other: 0 });
    assert.equal(ctx.pipeline.backlog, 0);
    assert.equal(ctx.pipeline.runState('ja'), undefined, 'a job that is not being worked on has no state');
    await addJob(ctx, 'ja'); await addJob(ctx, 'jb'); await addJob(ctx, 'jc');
    const first = ctx.pipeline.run('ja');
    await waitUntil('the first job to be listening', () => listened.includes('ja'));
    const second = ctx.pipeline.run('jb');
    await eventually('the second job to wait for a place', async () => (await ctx.db.getJob('jb'))?.stage, (stage) => stage === 'waiting_for_capacity');
    const third = ctx.pipeline.run('jc');
    await eventually('the third job to wait for a place', async () => (await ctx.db.getJob('jc'))?.stage, (stage) => stage === 'waiting_for_capacity');
    assert.deepEqual(ctx.pipeline.queueView(), { places: 1, running: ['ja'], waiting: ['jb', 'jc'], other: 0 });
    assert.equal(ctx.pipeline.backlog, 2, 'the jobs that do not have a place yet');

    await sleep(120);
    const working = ctx.pipeline.runState('ja');
    assert.equal(working?.stage, 'transcribing');
    assert.equal(working?.percent, 40, 'the progress the engine reported: half way through the 10 to 70 of listening');
    assert.ok(working!.stageSeconds >= 0.1 && working!.stageSeconds < 5, `${working?.stageSeconds} s in the stage`);
    const waiting = ctx.pipeline.runState('jb');
    assert.equal(waiting?.stage, 'waiting_for_capacity');
    assert.equal(waiting?.percent, 4);

    assert.equal(await ctx.pipeline.stop('jb'), 'stopping');
    await within(second, 8000, 'the stopped job went on waiting');
    assert.deepEqual(ctx.pipeline.queueView().waiting, ['jc'], 'a job that was stopped while it waited has left the line');
    release();
    await within(Promise.all([first, third]), 8000, 'the jobs that were not stopped did not finish');
    await untilSettled(ctx);
    assert.deepEqual(ctx.pipeline.queueView(), { places: 1, running: [], waiting: [], other: 0 }, 'nobody works and nobody waits when everything is over');
    assert.equal(ctx.pipeline.runState('ja'), undefined, 'a job that is over has no state');
    assert.equal(ctx.pipeline.backlog, 0);
  } finally { await ctx.cleanup(); }
});

test('a job that is still getting its video ready is neither working nor waiting for a place, but it is in the backlog', async () => {
  let release!: () => void; const storage = new SlowUploads(); storage.gate = new Promise<void>((resolve) => { release = resolve; });
  const ctx = await setup({ storage });
  try {
    await addJob(ctx, 'jp', { durable: false });
    const preparing = ctx.pipeline.run('jp');
    await waitUntil('the video to be on its way to storage', () => storage.log.some((entry) => entry.startsWith('reached:')));
    assert.deepEqual(ctx.pipeline.queueView(), { places: 1, running: [], waiting: [], other: 1 });
    assert.equal(ctx.pipeline.backlog, 1);
    assert.equal(ctx.pipeline.runState('jp')?.stage, 'saving_source');
    release();
    await within(preparing, 8000, 'the job did not finish');
    await untilSettled(ctx);
    assert.equal(ctx.pipeline.backlog, 0);
  } finally { await ctx.cleanup(); }
});

test('the number of places the pipeline says it has is the number of videos it works on at once', async () => {
  const ctx = await setup({ runtime: { ...fastRuntime, concurrency: 3 } });
  try { assert.equal(ctx.pipeline.queueView().places, 3); } finally { await ctx.cleanup(); }
});
