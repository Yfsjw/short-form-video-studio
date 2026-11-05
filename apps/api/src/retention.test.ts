import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { StudioDatabase } from './database.js';
import type { GeneratedClip, NewVideoJob, VideoJob } from './domain.js';
import { JobEraser, RetentionSweeper, type RetentionLog } from './retention.js';
import type { DurableStorage } from './storage.js';
import { MemoryStorage, eventually, sleep } from './test-support.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';
const schemaName = (label: string) => `test_${label}_${randomUUID().replaceAll('-', '_')}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const workspace = await mkdtemp(join(tmpdir(), 'studio-retention-'));
after(async () => { await rm(workspace, { recursive: true, force: true }); });

const exists = (path: string) => access(path).then(() => true, () => false);

/** What the program says in its log, kept so that tests can read it. */
function recordingLog() {
  const lines: Array<{ level: 'info' | 'error'; fields: Record<string, unknown>; message: string }> = [];
  const log: RetentionLog = {
    info: (fields, message) => { lines.push({ level: 'info', fields: fields as Record<string, unknown>, message }); },
    error: (fields, message) => { lines.push({ level: 'error', fields: fields as Record<string, unknown>, message }); },
  };
  return { log, lines };
}

/** A real database in its own schema, a storage in memory, and folders for the server's own disk, as a server has them. */
async function withWorld(label: string, work: (world: World) => Promise<void>, storage: DurableStorage = new MemoryStorage()) {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, schemaName(label));
  const root = await mkdtemp(join(workspace, 'world-'));
  const dirs = { uploadDir: join(root, 'uploads'), outputDir: join(root, 'outputs') };
  await mkdir(dirs.uploadDir, { recursive: true }); await mkdir(dirs.outputDir, { recursive: true });
  const { log, lines } = recordingLog();
  const world: World = { db, storage, ...dirs, log, lines, eraser: new JobEraser({ db, storage, ...dirs, logger: log }) };
  try { await work(world); } finally { await db.close({ dropSchema: true }); }
}
interface World { db: StudioDatabase; storage: DurableStorage; uploadDir: string; outputDir: string; log: RetentionLog; lines: ReturnType<typeof recordingLog>['lines']; eraser: JobEraser }

interface Made { id: string; clipIds: string[]; keys: string[]; outputDirectory: string; uploadedFile: string }

/** A job that is over (or not, by `status`), with `clipCount` clips and their caption files in storage and on the server's disk, and the video it was made from. */
async function makeJob(world: World, status: NewVideoJob['status'], options: { age?: number; clipCount?: number; id?: string; storedFilename?: string; sourceKey?: string } = {}): Promise<Made> {
  const id = options.id ?? randomUUID();
  const storedFilename = options.storedFilename ?? `${randomUUID()}.mp4`;
  const updatedAt = daysAgo(options.age ?? 0);
  await world.db.createJob({ id, originalFilename: 'match.mp4', storedFilename, mimeType: 'video/mp4', sizeBytes: 1, status, stage: status, errorMessage: null, durationSeconds: 10, width: 160, height: 120, createdAt: updatedAt, updatedAt });
  const outputDirectory = join(world.outputDir, id); await mkdir(outputDirectory, { recursive: true });
  const uploadedFile = join(world.uploadDir, storedFilename); await writeFile(uploadedFile, 'the uploaded video');
  const keys: string[] = []; const clipIds: string[] = [];
  const put = async (key: string) => { keys.push(key); (world.storage as MemoryStorage).objects.set(key, Buffer.from(key)); };
  for (let index = 0; index < (options.clipCount ?? 2); index += 1) {
    const clipId = randomUUID(); clipIds.push(clipId);
    const clip: GeneratedClip = { id: clipId, jobId: id, candidateId: 'c', startSeconds: 0, endSeconds: 5, durationSeconds: 5, outputPath: `${id}/${clipId}.mp4`, outputFilename: `${clipId}.mp4`, status: 'completed', errorMessage: null, captionPath: `${id}/${clipId}.srt`, createdAt: updatedAt, updatedAt, title: null, score: null, reasons: [], framing: null };
    await world.db.createClip(clip);
    await put(clip.outputPath); await put(`${id}/${clipId}.srt`);
    await writeFile(join(outputDirectory, clip.outputFilename), 'a clip');
  }
  if (options.sourceKey) {
    await put(options.sourceKey); await world.db.updateJob(id, { sourceStorageKey: options.sourceKey });
    await rewind(world, id, updatedAt); // recording the key changed the job just now; its age is what the test says it is
  }
  return { id, clipIds, keys, outputDirectory, uploadedFile };
}

/** Sets the moment a job last changed (the database does not offer that, on purpose). */
async function rewind(world: World, id: string, updatedAt: string) {
  const schema = (world.db as unknown as { schema?: string }).schema as string;
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
  try { await pool.query('UPDATE video_jobs SET updated_at = $1 WHERE id = $2', [updatedAt, id]); } finally { await pool.end(); }
}

const stored = (world: World) => [...(world.storage as MemoryStorage).objects.keys()].sort();

test('deleting a finished job removes its clips and caption files from storage, its rows from the database and its files from the server\'s disk, and nothing of any other job', () => withWorld('erase_all', async (world) => {
  const gone = await makeJob(world, 'completed');
  const kept = await makeJob(world, 'completed');
  assert.equal(await world.eraser.erase(gone.id, 'requested'), 'erased');

  assert.deepEqual(stored(world), [...kept.keys].sort(), 'every object of the job is gone from storage, and every object of the other job is still there');
  assert.equal(await world.db.getJob(gone.id), undefined);
  assert.deepEqual((await world.db.listClips(gone.id)).length, 0);
  assert.equal((await world.db.listClips(kept.id)).length, 2);
  assert.ok(await world.db.getJob(kept.id));
  assert.equal(await exists(gone.outputDirectory), false, 'its folder of clips on the server\'s disk is gone');
  assert.equal(await exists(gone.uploadedFile), false, 'and so is the video that was uploaded');
  assert.ok(await exists(kept.outputDirectory) && await exists(kept.uploadedFile), 'the other job keeps its files');
  const told = world.lines.find((line) => line.level === 'info');
  assert.deepEqual([told?.fields.jobId, told?.fields.reason, told?.fields.clipCount], [gone.id, 'requested', 2]);
}));

test('a job that failed is deleted like one that finished, and the reason that is logged is who asked', () => withWorld('erase_failed', async (world) => {
  const failed = await makeJob(world, 'failed', { clipCount: 0 });
  assert.equal(await world.eraser.erase(failed.id, 'expired'), 'erased');
  assert.equal(await world.db.getJob(failed.id), undefined);
  assert.equal(world.lines.find((line) => line.level === 'info')?.fields.reason, 'expired');
  assert.notEqual(world.lines.find((line) => line.level === 'info')?.message, 'Deleted a job at the request of the person who made it', 'the words differ by who asked');
}));

test('a job that is not there is said not to be, and nothing is touched', () => withWorld('erase_missing', async (world) => {
  const other = await makeJob(world, 'completed');
  const deletesBefore = (world.storage as MemoryStorage).log.filter((entry) => entry.startsWith('delete:')).length;
  assert.equal(await world.eraser.erase(randomUUID(), 'requested'), 'missing');
  assert.equal((world.storage as MemoryStorage).log.filter((entry) => entry.startsWith('delete:')).length, deletesBefore, 'nothing was deleted in storage');
  assert.deepEqual(stored(world), [...other.keys].sort());
}));

test('a job that is still queued or being worked on is never deleted, and nothing of it is removed', () => withWorld('erase_running', async (world) => {
  for (const status of ['queued', 'processing'] as const) {
    const running = await makeJob(world, status);
    assert.equal(await world.eraser.erase(running.id, 'requested'), 'not finished', status);
    assert.ok(await world.db.getJob(running.id), status);
    assert.equal((await world.db.listClips(running.id)).length, 2, status);
    assert.ok(running.keys.every((key) => (world.storage as MemoryStorage).objects.has(key)), `${status}: its files in storage are all still there`);
    assert.ok(await exists(running.outputDirectory) && await exists(running.uploadedFile), `${status}: and on the disk`);
  }
  assert.equal((world.storage as MemoryStorage).log.filter((entry) => entry.startsWith('delete:')).length, 0, 'not one delete was even asked of storage');
}));

test('when storage cannot delete, the job stays on the list with everything it had, every file is still tried, and asking again once storage works deletes it', () => withWorld('erase_storage_down', async (world) => {
  const memory = world.storage as MemoryStorage;
  const job = await makeJob(world, 'completed');
  memory.failDeletes = true;
  assert.equal(await world.eraser.erase(job.id, 'requested'), 'storage failed');
  assert.ok(await world.db.getJob(job.id), 'the job is still listed: with the rows gone nothing would ever point at what is left in storage');
  assert.equal((await world.db.listClips(job.id)).length, 2);
  assert.ok(await exists(job.outputDirectory) && await exists(job.uploadedFile), 'and its files on the disk are untouched');
  assert.equal(world.lines.filter((line) => line.level === 'error').length, job.keys.length + 1, 'every file was tried and each failure is in the log (the source that is normally not there is tried too)');

  memory.failDeletes = false;
  assert.equal(await world.eraser.erase(job.id, 'requested'), 'erased');
  assert.deepEqual(stored(world), []);
  assert.equal(await world.db.getJob(job.id), undefined);
}));

test('one file that cannot be deleted does not stop the others from being deleted, and keeps the job on the list', () => withWorld('erase_one_fails', async (world) => {
  const memory = world.storage as MemoryStorage;
  const job = await makeJob(world, 'completed');
  const stubborn = job.keys[1];
  const realDelete = memory.delete.bind(memory);
  memory.delete = async (key: string) => { if (key === stubborn) throw new Error('refused'); return realDelete(key); };
  assert.equal(await world.eraser.erase(job.id, 'requested'), 'storage failed');
  assert.deepEqual(stored(world), [stubborn], 'everything else was deleted, and only the stubborn file is left');
  assert.ok(await world.db.getJob(job.id));
  memory.delete = realDelete;
  assert.equal(await world.eraser.erase(job.id, 'requested'), 'erased');
  assert.deepEqual(stored(world), []);
}));

test('the video that was uploaded and the caption file the database names are deleted from storage too', () => withWorld('erase_source', async (world) => {
  const job = await makeJob(world, 'completed', { clipCount: 1, sourceKey: 'sources/the-job/source.mp4' });
  const [clip] = await world.db.listClips(job.id);
  await world.db.updateClip(clip.id, { captionPath: 'elsewhere/own-name.srt' });
  (world.storage as MemoryStorage).objects.set('elsewhere/own-name.srt', Buffer.from('captions'));
  assert.equal(await world.eraser.erase(job.id, 'requested'), 'erased');
  assert.deepEqual(stored(world), [], 'the clip, the caption file by its usual name, the caption file by the name the database holds, and the upload: all gone');
}));

test('with no durable storage nothing is asked of storage, and the files on the server\'s own disk are what is deleted', () => withWorld('erase_local', async (world) => {
  const asked: string[] = [];
  const noStorage: DurableStorage = { isDurable: false, upload: async () => undefined, download: async () => undefined, delete: async (key) => { asked.push(key); }, selfTest: async () => undefined, getDownloadUrl: async () => null };
  const eraser = new JobEraser({ db: world.db, storage: noStorage, uploadDir: world.uploadDir, outputDir: world.outputDir, logger: world.log });
  const job = await makeJob(world, 'completed');
  assert.equal(await eraser.erase(job.id, 'requested'), 'erased');
  assert.deepEqual(asked, [], 'storage was not asked to delete anything');
  assert.equal(await exists(job.outputDirectory) || await exists(job.uploadedFile), false);
  assert.equal(await world.db.getJob(job.id), undefined);
}));

test('a name that is not one of ours is never turned into a path to delete: the job is deleted, and nothing outside the server\'s folders is', () => withWorld('erase_paths', async (world) => {
  const outside = join(workspace, `outside-${randomUUID()}`); await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'precious.txt'), 'not ours');
  const sibling = join(world.outputDir, '..', 'precious-folder'); await mkdir(sibling, { recursive: true }); await writeFile(join(sibling, 'file.txt'), 'not ours');
  const outsideFile = join(world.uploadDir, '..', 'precious.mp4'); await writeFile(outsideFile, 'not ours');
  const hostile = await makeJob(world, 'completed', { id: '../precious-folder', storedFilename: '../precious.mp4', clipCount: 0 });
  assert.equal(await world.eraser.erase(hostile.id, 'requested'), 'erased');
  assert.ok(await exists(join(sibling, 'file.txt')), 'a job id that is not one of ours does not become a folder to delete');
  assert.ok(await exists(outsideFile), 'a stored name with a path in it does not become a file to delete');
  assert.ok(await exists(join(outside, 'precious.txt')));
  assert.equal(await world.db.getJob(hostile.id), undefined, 'the job itself is deleted all the same');
}));

test('deleting the job forgets the transcript that was kept for reuse from its sound', () => withWorld('erase_cache', async (world) => {
  const job = await makeJob(world, 'completed', { clipCount: 0 });
  await world.db.recordAudioFingerprint(job.id, 'sound-a');
  await world.db.storeCachedTranscript('sound-a', 'engine', [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Words that were said.' }]);
  assert.equal(await world.eraser.erase(job.id, 'requested'), 'erased');
  assert.equal(await world.db.findCachedTranscript('sound-a', 'engine'), undefined);
}));

test('two requests to delete the same job at the same moment delete it once and tell the second that it is gone', () => withWorld('erase_twice', async (world) => {
  const job = await makeJob(world, 'completed');
  const outcomes = await Promise.all([world.eraser.erase(job.id, 'requested'), world.eraser.erase(job.id, 'requested')]);
  assert.deepEqual([...outcomes].sort(), ['erased', 'missing']);
  assert.equal(await world.db.getJob(job.id), undefined);
  assert.equal(await world.eraser.erase(job.id, 'requested'), 'missing');
}));

// ---------------------------------------------------------------------------------------------------------------------------

test('with CLIP_RETENTION_DAYS at 0 nothing is ever deleted, however old, and no timer is started', () => withWorld('sweep_off', async (world) => {
  const ancient = await makeJob(world, 'completed', { age: 4000 });
  const sweeper = new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 0, firstSweepMs: 5, intervalMs: 5 });
  assert.equal(sweeper.enabled, false);
  sweeper.start();
  assert.deepEqual(await sweeper.sweep(), { erased: 0, failed: 0 });
  await sleep(60);
  assert.ok(await world.db.getJob(ancient.id));
  assert.equal((world.storage as MemoryStorage).log.filter((entry) => entry.startsWith('delete:')).length, 0);
  await sweeper.stop();
}));

test('a look deletes the jobs that finished longer ago than the retention time, and keeps the younger ones and the ones still being worked on', () => withWorld('sweep_basic', async (world) => {
  const old = await makeJob(world, 'completed', { age: 10 }); const failed = await makeJob(world, 'failed', { age: 8, clipCount: 0 });
  const young = await makeJob(world, 'completed', { age: 6 }); const fresh = await makeJob(world, 'completed', { age: 0 });
  const stuck = await makeJob(world, 'processing', { age: 40 }); const waiting = await makeJob(world, 'queued', { age: 40 });
  const sweeper = new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 7 });
  assert.deepEqual(await sweeper.sweep(), { erased: 2, failed: 0 });
  for (const gone of [old, failed]) assert.equal(await world.db.getJob(gone.id), undefined, `${gone.id} was older than 7 days`);
  for (const kept of [young, fresh, stuck, waiting]) assert.ok(await world.db.getJob(kept.id), `${kept.id} stays`);
  assert.deepEqual(stored(world), [...young.keys, ...fresh.keys, ...stuck.keys, ...waiting.keys].sort(), 'and so do their files');
  const told = world.lines.filter((line) => line.message.startsWith('Deleted the clips that are older'));
  assert.equal(told.length, 1);
  assert.deepEqual([told[0].fields.erased, told[0].fields.failed, told[0].fields.retentionDays], [2, 0, 7]);
  assert.deepEqual(await sweeper.sweep(), { erased: 0, failed: 0 }, 'looking again finds nothing and says nothing');
  assert.equal(world.lines.filter((line) => line.message.startsWith('Deleted the clips that are older')).length, 1);
}));

test('how old a job is counted from the clock the sweeper is given, and the retention time is counted in whole days', () => withWorld('sweep_clock', async (world) => {
  const job = await makeJob(world, 'completed', { age: 5 });
  const inADayAndAHalf = () => Date.now() + 1.5 * 86_400_000;
  assert.deepEqual(await new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 7, now: inADayAndAHalf }).sweep(), { erased: 0, failed: 0 }, 'six and a half days old by that clock: not yet more than seven');
  assert.deepEqual(await new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 6, now: inADayAndAHalf }).sweep(), { erased: 1, failed: 0 }, 'but more than six');
  assert.equal(await world.db.getJob(job.id), undefined);
}));

test('more jobs than one round holds are all deleted, within the number of rounds a look may make; what is left is deleted by the next look', () => withWorld('sweep_rounds', async (world) => {
  for (let index = 0; index < 5; index += 1) await makeJob(world, 'completed', { age: 30 + index, clipCount: 1 });
  const sweeper = new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 7, batchSize: 2, maxBatches: 2 });
  assert.deepEqual(await sweeper.sweep(), { erased: 4, failed: 0 }, 'two rounds of two');
  assert.equal((await world.db.listFinishedJobsOlderThan(new Date().toISOString())).length, 1, 'one is left');
  assert.deepEqual(await sweeper.sweep(), { erased: 1, failed: 0 }, 'the next look deletes it');
  const all = new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 7, batchSize: 2 });
  for (let index = 0; index < 5; index += 1) await makeJob(world, 'completed', { age: 30, clipCount: 0 });
  assert.deepEqual(await all.sweep(), { erased: 5, failed: 0 }, 'with the usual number of rounds a look deletes five jobs in rounds of two');
}));

test('when storage is down a look ends after the first round, says so, keeps every job, and the next look after storage is back deletes them all', () => withWorld('sweep_storage_down', async (world) => {
  const memory = world.storage as MemoryStorage;
  const made: Made[] = [];
  for (let index = 0; index < 5; index += 1) made.push(await makeJob(world, 'completed', { age: 30 + index, clipCount: 1 }));
  const sweeper = new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 7, batchSize: 2 });
  memory.failDeletes = true;
  const result = await sweeper.sweep();
  assert.deepEqual(result, { erased: 0, failed: 2 }, 'the first round of two failed, and the look stopped there instead of asking again for the same jobs');
  for (const job of made) assert.ok(await world.db.getJob(job.id), 'every job is still listed');
  const told = world.lines.find((line) => line.message.includes('tried again next time'));
  assert.ok(told, 'the log says that some could not be deleted');
  assert.equal(told?.level, 'info');
  assert.equal(memory.log.filter((entry) => entry.startsWith('delete:')).length, 2 * 3, 'only the two oldest jobs were tried (a clip, its captions and the upload each)');

  memory.failDeletes = false;
  assert.deepEqual(await sweeper.sweep(), { erased: 5, failed: 0 });
  assert.deepEqual(stored(world), []);
}));

test('two looks at the same moment are one look', () => withWorld('sweep_once', async (world) => {
  const memory = world.storage as MemoryStorage;
  const job = await makeJob(world, 'completed', { age: 30, clipCount: 1 });
  let release!: () => void; memory.holdDeletes = new Promise<void>((resolve) => { release = resolve; });
  const sweeper = new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 7 });
  const first = sweeper.sweep(); const second = sweeper.sweep();
  assert.equal(first, second, 'the second look is the first one');
  release();
  assert.deepEqual(await first, { erased: 1, failed: 0 });
  assert.equal(memory.log.filter((entry) => entry === `delete:${job.keys[0]}`).length, 1, 'each file was deleted once');
  assert.deepEqual(await sweeper.sweep(), { erased: 0, failed: 0 }, 'and a look after it is a new one');
}));

test('the sweeper looks by itself, first soon after it starts and then again and again, until it is stopped; stopping waits for a look that is under way', () => withWorld('sweep_timer', async (world) => {
  const memory = world.storage as MemoryStorage;
  // A job that is made while the sweeper is looking must not be due before it is complete (its clips are made after its row), or the test would race the sweeper.
  const dueLater = async () => { const job = await makeJob(world, 'completed', { clipCount: 1 }); await rewind(world, job.id, daysAgo(30)); return job; };
  const first = await makeJob(world, 'completed', { age: 30, clipCount: 1 });
  const sweeper = new RetentionSweeper({ db: world.db, eraser: world.eraser, logger: world.log }, { days: 7, firstSweepMs: 30, intervalMs: 40 });
  sweeper.start(); sweeper.start();
  await eventually('the first look to delete the old job', () => world.db.getJob(first.id), (job) => job === undefined);
  const second = await dueLater();
  await eventually('a later look to delete the next one', () => world.db.getJob(second.id), (job) => job === undefined);

  let release!: () => void; memory.holdDeletes = new Promise<void>((resolve) => { release = resolve; });
  const third = await dueLater();
  await eventually('a look to be under way', () => memory.log.filter((entry) => entry === `delete:${third.keys[0]}`).length, (count) => count === 1);
  let stopped = false; const stopping = sweeper.stop().then(() => { stopped = true; });
  await sleep(100);
  assert.equal(stopped, false, 'stopping waits for the look that is under way');
  release(); await stopping;
  assert.equal(await world.db.getJob(third.id), undefined, 'and that look was finished');

  const fourth = await dueLater();
  await sleep(200);
  assert.ok(await world.db.getJob(fourth.id), 'once it is stopped it looks no more');
}));

test('a look that fails (the database does not answer) is written to the log and the next one still comes', async () => {
  const { log, lines } = recordingLog();
  let asked = 0;
  const db = { listFinishedJobsOlderThan: async () => { asked += 1; if (asked === 1) throw new Error('the database is not answering'); return []; } };
  const sweeper = new RetentionSweeper({ db, eraser: { erase: async () => 'erased' as const }, logger: log }, { days: 7, firstSweepMs: 10, intervalMs: 20 });
  sweeper.start();
  await eventually('a second look after the first one failed', () => asked, (count) => count >= 2);
  await sweeper.stop();
  const failure = lines.find((line) => line.level === 'error');
  assert.match(failure?.message ?? '', /tried again next time/);
  assert.match(String((failure?.fields.err as Error).message), /not answering/);
});

test('a look asks for 25 jobs at a time and for at most 20 rounds, however many are due, and stops asking as soon as nothing is due', async () => {
  const { log } = recordingLog();
  const asked: Array<{ before: string; limit: number | undefined }> = [];
  const reasons: string[] = [];
  const eraser = { erase: async (_id: string, reason: string) => { reasons.push(reason); return 'erased' as const; } };

  const endless = { listFinishedJobsOlderThan: async (before: string, limit?: number) => { asked.push({ before, limit }); return [{ id: `job-${asked.length}` }] as VideoJob[]; } };
  assert.deepEqual(await new RetentionSweeper({ db: endless, eraser, logger: log }, { days: 7 }).sweep(), { erased: 20, failed: 0 }, 'one look ends after 20 rounds, whatever is still due');
  assert.equal(asked.length, 20);
  assert.ok(asked.every((entry) => entry.limit === 25), 'each round asks for 25');
  assert.ok(reasons.every((reason) => reason === 'expired') && reasons.length === 20, 'and what it deletes is deleted because it is old, not because a person asked');

  asked.length = 0;
  const rounds = [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]] as VideoJob[][];
  const shrinking = { listFinishedJobsOlderThan: async (before: string, limit?: number) => { asked.push({ before, limit }); return rounds[asked.length - 1] ?? []; } };
  assert.deepEqual(await new RetentionSweeper({ db: shrinking, eraser, logger: log }, { days: 7 }).sweep(), { erased: 3, failed: 0 });
  assert.equal(asked.length, 3, 'a round that finds nothing ends the look: no more questions');

  asked.length = 0;
  const nothing = { listFinishedJobsOlderThan: async (before: string, limit?: number) => { asked.push({ before, limit }); return [] as VideoJob[]; } };
  assert.deepEqual(await new RetentionSweeper({ db: nothing, eraser, logger: log }, { days: 7 }).sweep(), { erased: 0, failed: 0 });
  assert.equal(asked.length, 1, 'a look with nothing due asks once');
});

test('left to its own settings the sweeper first looks a minute after it starts and then an hour after each look, and never again once it is stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { log } = recordingLog();
  const sweeper = new RetentionSweeper({ db: { listFinishedJobsOlderThan: async () => [] }, eraser: { erase: async () => 'erased' as const }, logger: log }, { days: 7 });
  let looks = 0;
  sweeper.sweep = async () => { looks += 1; return { erased: 0, failed: 0 }; };
  const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
  sweeper.start();
  t.mock.timers.tick(59_999); await settle();
  assert.equal(looks, 0, 'not yet a minute');
  t.mock.timers.tick(1); await settle();
  assert.equal(looks, 1, 'a minute after the start');
  t.mock.timers.tick(3_599_999); await settle();
  assert.equal(looks, 1, 'not yet an hour after that look');
  t.mock.timers.tick(1); await settle();
  assert.equal(looks, 2, 'an hour after it');
  await sweeper.stop();
  t.mock.timers.tick(10_000_000); await settle();
  assert.equal(looks, 2, 'a stopped sweeper looks no more');
  sweeper.start();
  t.mock.timers.tick(10_000_000); await settle();
  assert.equal(looks, 2, 'and cannot be started again');
});

test('what the sweeper counts: only what it deleted itself as deleted, a job that was already gone or is being worked on as nothing, and trouble with storage as trouble', async () => {
  const { log } = recordingLog();
  const due = (...ids: string[]) => ({ listFinishedJobsOlderThan: async (_before: string, _limit?: number) => ids.map((id) => ({ id })) as VideoJob[] });
  const answering = (answers: Record<string, 'erased' | 'missing' | 'not finished' | 'storage failed'>) => ({ erase: async (id: string) => answers[id] });
  assert.deepEqual(await new RetentionSweeper({ db: due('a', 'b', 'c'), eraser: answering({ a: 'erased', b: 'missing', c: 'not finished' }), logger: log }, { days: 7, maxBatches: 1 }).sweep(), { erased: 1, failed: 0 });
  assert.deepEqual(await new RetentionSweeper({ db: due('a', 'b', 'c'), eraser: answering({ a: 'storage failed', b: 'erased', c: 'storage failed' }), logger: log }, { days: 7, maxBatches: 1 }).sweep(), { erased: 1, failed: 2 });
});

test('a sweeper that is off never starts a timer, and one that is on starts only one however often it is started', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { log } = recordingLog();
  const parts = { db: { listFinishedJobsOlderThan: async () => [] as VideoJob[] }, eraser: { erase: async () => 'erased' as const }, logger: log };
  const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

  const off = new RetentionSweeper(parts, { days: 0, firstSweepMs: 10, intervalMs: 10 });
  let offLooks = 0; off.sweep = async () => { offLooks += 1; return { erased: 0, failed: 0 }; };
  off.start(); t.mock.timers.tick(1000); await settle();
  assert.equal(offLooks, 0, 'with the retention time at 0 nobody is looking');

  const on = new RetentionSweeper(parts, { days: 7, firstSweepMs: 10, intervalMs: 10 });
  let onLooks = 0; on.sweep = async () => { onLooks += 1; return { erased: 0, failed: 0 }; };
  on.start(); on.start(); on.start();
  t.mock.timers.tick(10); await settle();
  assert.equal(onLooks, 1, 'three starts, one timer, one look');
  await on.stop();
});
