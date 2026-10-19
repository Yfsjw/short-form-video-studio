import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { StudioDatabase } from './database.js';
import { NullStorage, type DurableStorage } from './storage.js';
import { MemoryStorage, eventually, sleep } from './test-support.js';
import type { TranscriptionEngine } from './transcription.js';

// These tests run the real application end to end: real HTTP requests, a real Postgres database,
// real ffmpeg/ffprobe, real multipart uploads. Only the three things that need the outside world
// are replaced: Cloudflare R2 (kept in memory), speech recognition (fixed text) and the clock-free network.
process.env.LOG_LEVEL = 'silent';

const run = promisify(execFile);
const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
// On a developer machine without ffmpeg these tests are skipped; in CI they must never be skipped silently.
if (!hasFfmpeg && process.env.CI) throw new Error('ffmpeg must be installed in CI so that the end-to-end tests really run.');
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg is not installed on this machine' };

const workspace = await mkdtemp(join(tmpdir(), 'studio-e2e-'));
const admin = new Pool({ connectionString: TEST_DATABASE_URL });
after(async () => { await admin.end(); await rm(workspace, { recursive: true, force: true }); });

/** A genuine 8-second H.264/AAC video with sound (320x240), small enough to process in about a second. */
const sampleVideo = join(workspace, 'sample.mp4');
if (hasFfmpeg) await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', sampleVideo]);

/** The same video followed by a valid MP4 "free" (padding) box, so it is still a real, playable video but megabytes larger. */
async function paddedVideo(megabytes: number) {
  const padding = Buffer.alloc(megabytes * 1024 * 1024);
  const box = Buffer.alloc(8); box.writeUInt32BE(padding.length + 8, 0); box.write('free', 4, 'latin1');
  return Buffer.concat([await readFile(sampleVideo), box, padding]);
}

const talk: TranscriptionEngine = { transcribe: async () => [
  { segmentIndex: 0, startSeconds: 0, endSeconds: 3, text: 'Here is the first important point.' },
  { segmentIndex: 1, startSeconds: 3, endSeconds: 6, text: 'But the second point is even better!' },
  { segmentIndex: 2, startSeconds: 6, endSeconds: 8, text: 'That is why you must remember it.' },
] };

const schemaName = (label: string) => `test_${label}_${randomUUID().replaceAll('-', '_')}`;
const dropSchema = (schema: string) => admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

type Studio = Awaited<ReturnType<typeof createApp>>;
interface RunningServer { base: string; root: string; dirs: { UPLOAD_DIR: string; TEMP_DIR: string; OUTPUT_DIR: string }; studio: Studio; storage: DurableStorage; stop: () => Promise<void> }

/** Boots the real app on a free port, with its own empty upload/temp/output folders (like a freshly started container). */
async function start(options: { schema: string; storage?: DurableStorage; transcriber?: TranscriptionEngine; env?: Record<string, string>; keepAwakeIntervalMs?: number; bootRecoveryWaitMs?: number }): Promise<RunningServer> {
  const root = await mkdtemp(join(workspace, 'server-'));
  const dirs = { UPLOAD_DIR: join(root, 'uploads'), TEMP_DIR: join(root, 'tmp'), OUTPUT_DIR: join(root, 'outputs') };
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL, ...dirs,
    CLIP_VERTICAL_WIDTH: '360', CLIP_VERTICAL_HEIGHT: '640', CLIP_PRESET: 'ultrafast', CLIP_MAX_CANDIDATES: '1',
    HIGHLIGHT_MIN_DURATION_SECONDS: '2', HIGHLIGHT_MAX_DURATION_SECONDS: '6', HIGHLIGHT_MAX_CANDIDATES: '2',
    JOB_STALE_AFTER_SECONDS: '2', JOB_HEARTBEAT_SECONDS: '1',
    ...options.env,
  });
  const storage = options.storage ?? new MemoryStorage();
  const studio = await createApp(config, { storage, transcriber: options.transcriber ?? talk, databaseSchema: options.schema, keepAwakeIntervalMs: options.keepAwakeIntervalMs, bootRecoveryWaitMs: options.bootRecoveryWaitMs });
  const server = createServer(studio.app).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  let stopped = false;
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, root, dirs, studio, storage, stop: async () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await studio.close();
  } };
}

interface JobView { job: { id: string; status: string; stage: string; errorMessage: string | null; attempts?: number; sourceStorageKey?: unknown }; clips: Array<{ id: string; status: string; outputPath: string }> }

const upload = (base: string, route: string, bytes: Buffer, filename = 'match.mp4') => {
  const form = new FormData();
  form.append('video', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), filename);
  return fetch(`${base}${route}`, { method: 'POST', body: form });
};

async function waitForJob(base: string, id: string, timeoutMs = 60_000): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await (await fetch(`${base}/api/jobs/${id}`)).json() as JobView;
    if (view.job.status === 'completed' || view.job.status === 'failed') return view;
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish (last seen: ${view.job.status} / ${view.job.stage})`);
    await sleep(100);
  }
}

/** A job's status reads "completed" a moment before its clean-up has finished; this waits for the server to be completely done with it. */
const untilSettled = (server: RunningServer) => eventually('the server to finish with the job, clean-up included', () => server.studio.pipeline.activeJobCount, (count) => count === 0);

/** Uploads the sample video through the API and waits for the job to finish. */
async function uploadAndFinish(server: RunningServer) {
  const response = await upload(server.base, '/api/jobs', await readFile(sampleVideo));
  assert.equal(response.status, 202);
  const { job } = await response.json() as { job: { id: string } };
  return waitForJob(server.base, job.id);
}

const inspect = async (path: string) => {
  const video = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', path])).stdout) as { streams: Array<{ codec_name: string; width: number; height: number }>; format: { duration: string } };
  const kinds = (await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path])).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { codec: video.streams[0].codec_name, width: video.streams[0].width, height: video.streams[0].height, seconds: Number(video.format.duration), kinds };
};

test('a real upload runs through ffmpeg, is kept in durable storage, and its clip is served from there', needsFfmpeg, async () => {
  const schema = schemaName('e2e'); const server = await start({ schema });
  try {
    const bytes = await readFile(sampleVideo);
    const finished = await uploadAndFinish(server);
    const { job } = finished;
    assert.equal(job.status, 'completed', job.errorMessage ?? '');
    assert.equal('sourceStorageKey' in job, false, 'the internal storage location must not be exposed by the API');
    await untilSettled(server);

    const storage = server.storage as MemoryStorage;
    assert.ok(bytes.equals(storage.uploaded.get(`sources/${job.id}/source.mp4`)!), 'the uploaded video must have been stored, byte for byte, before processing');
    assert.equal(storage.objects.has(`sources/${job.id}/source.mp4`), false, 'once the job is complete its stored video is deleted');

    assert.equal(finished.clips.length, 1);
    const clip = finished.clips[0];
    assert.equal(clip.status, 'completed');
    const clipBytes = storage.objects.get(clip.outputPath);
    assert.ok(clipBytes && clipBytes.length > 0, 'the finished clip must be in durable storage');
    assert.ok(storage.objects.has(`${job.id}/${clip.id}.srt`), 'its captions must be stored too');

    const clipFile = join(workspace, `${clip.id}.mp4`);
    await writeFile(clipFile, clipBytes);
    const facts = await inspect(clipFile);
    assert.deepEqual({ codec: facts.codec, width: facts.width, height: facts.height }, { codec: 'h264', width: 360, height: 640 }, 'the clip must be a vertical 9:16 H.264 video');
    assert.ok(facts.kinds.includes('audio'), 'the clip must keep its sound');
    assert.ok(facts.seconds > 1.5 && facts.seconds < 6.5, `unexpected clip length ${facts.seconds}s`);

    const download = await fetch(`${server.base}/api/jobs/${job.id}/clips/${clip.id}?download=1`, { redirect: 'manual' });
    assert.equal(download.status, 302);
    assert.equal(download.headers.get('location'), `https://storage.test/${clip.outputPath}`);

    const page = await (await fetch(`${server.base}/jobs/${job.id}`)).text();
    assert.ok(page.includes(`/api/jobs/${job.id}/clips/${clip.id}?download=1`), 'the status page must offer the download link');

    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), [], 'no copy of the upload may linger on the (ephemeral) disk');
    assert.deepEqual(await readdir(server.dirs.OUTPUT_DIR), [], 'no copy of the clip may linger on the disk');

    const health = await (await fetch(`${server.base}/api/health`)).json() as { status: string; storage: { backend: string; selfTest: string } };
    assert.deepEqual({ status: health.status, backend: health.storage.backend, selfTest: health.storage.selfTest }, { status: 'ok', backend: 'r2', selfTest: 'passed' });
  } finally { await server.stop(); await dropSchema(schema); }
});

test('RESTART: the server dies in the middle of a job; a new server with an empty disk resumes it from durable storage and finishes it', needsFfmpeg, async () => {
  const schema = schemaName('restart'); const storage = new MemoryStorage();
  let reachedTranscription!: () => void;
  const atTranscription = new Promise<void>((resolve) => { reachedTranscription = resolve; });
  const hangsForever: TranscriptionEngine = { transcribe: async () => { reachedTranscription(); return new Promise<never>(() => undefined); } };
  const first = await start({ schema, storage, transcriber: hangsForever });
  let second: RunningServer | undefined;
  try {
    const { job } = await (await upload(first.base, '/api/jobs', await readFile(sampleVideo))).json() as { job: { id: string } };
    await atTranscription;
    const midJob = await first.studio.db.getJob(job.id);
    assert.equal(midJob?.stage, 'transcribing');
    assert.equal(midJob?.sourceStorageKey, `sources/${job.id}/source.mp4`, 'the video must already be safe in durable storage while it is being processed');

    // The process dies: its timers stop, its database connections close, and its disk is gone with it.
    await first.stop();
    await rm(first.root, { recursive: true, force: true });

    second = await start({ schema, storage });
    const finished = await waitForJob(second.base, job.id);
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    assert.equal(finished.clips.filter((clip) => clip.status === 'completed').length, 1);
    await untilSettled(second);
    assert.equal((await second.studio.db.getJob(job.id))?.attempts, 2, 'the job must have been started exactly once more');
    assert.ok(storage.log.includes(`download:sources/${job.id}/source.mp4`), 'the video must have been restored from durable storage');
    assert.equal(storage.objects.has(`sources/${job.id}/source.mp4`), false, 'the stored video is deleted once the resumed job is complete');

    const clip = finished.clips[0];
    const download = await fetch(`${second.base}/api/jobs/${job.id}/clips/${clip.id}`, { redirect: 'manual' });
    assert.equal(download.status, 302, 'the clip made after the restart must be downloadable');
    assert.deepEqual(await readdir(second.dirs.UPLOAD_DIR), []);
  } finally { await first.stop(); await second?.stop(); await dropSchema(schema); }
});

test('start-up does not wait for a storage service that has stopped answering: the server opens, and the clean-up carries on in the background', async () => {
  const schema = schemaName('slowboot'); const storage = new MemoryStorage();
  const key = 'sources/stuck/source.mp4';
  let letStorageAnswer!: () => void;
  storage.holdDeletes = new Promise<void>((resolve) => { letStorageAnswer = resolve; });
  storage.objects.set(key, Buffer.from('the uploaded video'));
  // A job that was interrupted three times already and has gone quiet: recovery gives up on it, and then has to delete its stored video.
  const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const seed = await StudioDatabase.connect(TEST_DATABASE_URL, schema);
  await seed.createJob({ id: 'stuck', originalFilename: 'talk.mp4', storedFilename: 'stuck.mp4', mimeType: 'video/mp4', sizeBytes: 18, status: 'processing', stage: 'transcribing', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: longAgo, updatedAt: longAgo });
  for (let attempt = 0; attempt < 3; attempt += 1) await seed.beginAttempt('stuck');
  await seed.updateJob('stuck', { sourceStorageKey: key });
  await seed.close();
  await admin.query(`UPDATE "${schema}".video_jobs SET updated_at = $1 WHERE id = 'stuck'`, [longAgo]);

  const starting = start({ schema, storage, bootRecoveryWaitMs: 300 });
  let server: RunningServer | undefined;
  try {
    const outcome = await Promise.race([starting, sleep(8000).then(() => 'still not open' as const)]);
    assert.notEqual(outcome, 'still not open', 'the server must open even though storage is not answering');
    const open = outcome as RunningServer;
    server = open;
    assert.equal((await fetch(`${open.base}/api/health`)).status, 200);
    await eventually('the clean-up to have asked storage to delete the video', () => storage.log, (log) => log.includes(`delete:${key}`));
    assert.equal(storage.objects.has(key), true, 'storage has not answered, so the video is still there; this test means nothing unless that is so');
    assert.equal((await open.studio.db.getJob('stuck'))?.status, 'failed', 'the job was given up on without waiting for storage');

    letStorageAnswer();
    await eventually('the clean-up to carry on in the background and delete the video', () => storage.objects.has(key), (stillThere) => !stillThere);
    await eventually('the job to stop pointing at the deleted video', async () => (await open.studio.db.getJob('stuck'))?.sourceStorageKey ?? null, (stored) => stored === null);
  } finally {
    letStorageAnswer();
    server ??= await starting.catch(() => undefined); // if start-up did hang, it ends now that storage answers
    await server?.stop();
    await dropSchema(schema);
  }
});

test('with REQUIRE_DURABLE_STORAGE the server refuses to start without R2 settings, naming only what is missing', async () => {
  const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, UPLOAD_DIR: join(workspace, 'u'), TEMP_DIR: join(workspace, 't'), OUTPUT_DIR: join(workspace, 'o'), REQUIRE_DURABLE_STORAGE: 'true', R2_ACCOUNT_ID: 'visible-account-id', R2_ACCESS_KEY_ID: 'visible-key-id' });
  await assert.rejects(createApp(config), (error: Error) => {
    assert.match(error.message, /REQUIRE_DURABLE_STORAGE/);
    assert.match(error.message, /R2_BUCKET_NAME/);
    assert.match(error.message, /R2_SECRET_ACCESS_KEY/);
    assert.doesNotMatch(error.message, /visible-account-id|visible-key-id/, 'values of settings must never appear in messages');
    assert.doesNotMatch(error.message, /R2_ACCOUNT_ID|R2_ACCESS_KEY_ID/, 'settings that are present must not be reported as missing');
    return true;
  });
});

test('the bare address leads to the upload page instead of an error, and addresses that do not exist are still refused', async () => {
  const schema = schemaName('root'); const server = await start({ schema });
  try {
    const bare = await fetch(`${server.base}/`, { redirect: 'manual' });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get('location'), '/test-upload');
    const followed = await fetch(`${server.base}/`);
    assert.equal(followed.status, 200);
    assert.match(await followed.text(), /Upload a video/);
    const unknown = await fetch(`${server.base}/no-such-page`);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('without R2 settings the server still starts for local development, and says openly that it is local-only', async () => {
  const schema = schemaName('local'); const server = await start({ schema, storage: new NullStorage() });
  try {
    const health = await (await fetch(`${server.base}/api/health`)).json() as { storage: { backend: string; selfTest: string } };
    assert.deepEqual(health.storage, { backend: 'local-only', selfTest: 'not-applicable', checkedAt: null });
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the upload page states the configured size limit, and the upload route accepts videos far larger than the old 20 MB cap', needsFfmpeg, async () => {
  const schema = schemaName('big'); const server = await start({ schema, env: { MAX_UPLOAD_BYTES: String(100 * 1024 * 1024) } });
  try {
    const page = await (await fetch(`${server.base}/test-upload`)).text();
    assert.match(page, /up to 100 MB/);
    assert.doesNotMatch(page, /20 ?MB/);
    assert.match(page, /have not been tested/, 'the page must not oversell what has been verified');

    const big = await paddedVideo(22);
    assert.ok(big.length > 22 * 1024 * 1024);
    const response = await upload(server.base, '/test-upload', big);
    assert.equal(response.status, 200);
    const id = response.url.match(/\/jobs\/([0-9a-f-]{36})$/)?.[1];
    assert.ok(id, 'an upload must lead straight to the page that follows the job');
    assert.match(await response.text(), /Processing your video|Your clips/);

    const finished = await waitForJob(server.base, id);
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    assert.equal((server.storage as MemoryStorage).uploaded.get(`sources/${id}/source.mp4`)?.length, big.length, 'the whole 22 MB video must have been stored');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('a video over the configured limit is refused with a clear message and leaves nothing behind', async () => {
  const schema = schemaName('limit'); const server = await start({ schema, env: { MAX_UPLOAD_BYTES: String(1024 * 1024) } });
  try {
    const response = await upload(server.base, '/test-upload', Buffer.alloc(2 * 1024 * 1024, 1));
    assert.equal(response.status, 400);
    assert.match(await response.text(), /larger than the 1 MB limit/);
    const api = await upload(server.base, '/api/jobs', Buffer.alloc(2 * 1024 * 1024, 1));
    assert.equal(api.status, 400);
    assert.equal(((await api.json()) as { error: { code: string } }).error.code, 'INVALID_UPLOAD');
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), []);
    assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('file names are escaped on the page an upload leads to, so an upload cannot inject markup', needsFfmpeg, async () => {
  const schema = schemaName('xss'); const server = await start({ schema });
  try {
    const response = await upload(server.base, '/test-upload', await readFile(sampleVideo), '<img src=x onerror=alert(1)>.mp4');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.mp4'));
    assert.ok(!html.includes('<img src=x'));
    const id = response.url.match(/\/jobs\/([0-9a-f-]{36})$/)![1];
    await waitForJob(server.base, id);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('an upload the client abandons halfway leaves no file, no job, and the server keeps working', async () => {
  const schema = schemaName('abort'); const server = await start({ schema });
  try {
    const port = Number(new URL(server.base).port);
    for (const [route, hangUp] of [['/test-upload', (socket: net.Socket) => socket.end()], ['/test-upload', (socket: net.Socket) => socket.resetAndDestroy()], ['/api/jobs', (socket: net.Socket) => socket.destroy()], ['/api/jobs', (socket: net.Socket) => socket.resetAndDestroy()]] as const) {
      const boundary = `----abandoned${randomUUID()}`;
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => undefined);
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      // The client announces a 50 MB body, sends 3 MB of it, then goes away.
      socket.write(`POST ${route} HTTP/1.1\r\nHost: test\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${50 * 1024 * 1024}\r\n\r\n--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="big.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
      for (let megabyte = 0; megabyte < 3; megabyte += 1) socket.write(Buffer.alloc(1024 * 1024, 7));
      await eventually(`the server to start writing the upload to disk (${route})`, () => readdir(server.dirs.UPLOAD_DIR), (files) => files.length === 1);
      hangUp(socket);
      await eventually(`the half-received file to be removed (${route})`, () => readdir(server.dirs.UPLOAD_DIR), (files) => files.length === 0);
      assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0, 'no job may be created for a video that never arrived');
    }
    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('an upload whose job cannot be created (database trouble) does not leave its file on the disk', async () => {
  const schema = schemaName('nojob'); const server = await start({ schema });
  try {
    server.studio.db.createJob = async () => { throw new Error('database is down'); };
    for (const route of ['/api/jobs', '/test-upload']) {
      const response = await upload(server.base, route, Buffer.alloc(64 * 1024, 3));
      assert.equal(response.status, 500, route);
      assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), [], `an orphaned upload was left behind (${route})`);
    }
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the job page tells the truth about a resumed job and about a failed one, without trusting stored text as markup', async () => {
  const schema = schemaName('page'); const server = await start({ schema });
  try {
    const now = new Date().toISOString();
    const base = { originalFilename: 'a.mp4', storedFilename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 1, errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
    const resumed = randomUUID(); const failed = randomUUID();
    await server.studio.db.createJob({ ...base, id: resumed, status: 'processing', stage: 'transcribing' });
    await server.studio.db.beginAttempt(resumed); await server.studio.db.beginAttempt(resumed);
    await server.studio.db.createJob({ ...base, id: failed, status: 'failed', stage: 'failed', errorMessage: 'It broke: <b>boom</b>' });

    const resumedPage = await (await fetch(`${server.base}/jobs/${resumed}`)).text();
    assert.match(resumedPage, /Resumed automatically after the server restarted \(attempt 2\)/);
    assert.match(resumedPage, /http-equiv="refresh"/);

    const failedPage = await (await fetch(`${server.base}/jobs/${failed}`)).text();
    assert.ok(failedPage.includes('It broke: &lt;b&gt;boom&lt;/b&gt;'));
    assert.ok(!failedPage.includes('<b>boom</b>'));
    assert.doesNotMatch(failedPage, /http-equiv="refresh"/);
  } finally { await server.stop(); await dropSchema(schema); }
});

const uploadWith = (base: string, route: string, bytes: Buffer, fields: Record<string, string>, filename = 'match.mp4') => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('video', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), filename);
  return fetch(`${base}${route}`, { method: 'POST', body: form });
};

test('options chosen at upload are kept with the job and shape the clip, and the finished job reports its progress and timings', needsFfmpeg, async () => {
  const schema = schemaName('options'); const server = await start({ schema, env: { CLIP_VERTICAL_WIDTH: '1080', CLIP_VERTICAL_HEIGHT: '1920' } });
  try {
    const response = await uploadWith(server.base, '/api/jobs', await readFile(sampleVideo), { clipCount: '1', quality: 'standard', captionStyle: 'none' });
    assert.equal(response.status, 202);
    const { job } = await response.json() as { job: { id: string; options: unknown } };
    assert.deepEqual(job.options, { clipCount: 1, clipLength: 'auto', quality: 'standard', captionStyle: 'none' });

    const finished = await waitForJob(server.base, job.id) as JobView & { job: { progress: number; stageTimings: Record<string, number>; options: unknown } };
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    assert.equal(finished.job.progress, 100);
    assert.ok(Object.keys(finished.job.stageTimings).includes('transcribing') && Object.keys(finished.job.stageTimings).includes('extracting_clips'), 'the stages must be timed');
    assert.deepEqual(finished.job.options, { clipCount: 1, clipLength: 'auto', quality: 'standard', captionStyle: 'none' });
    await untilSettled(server);

    const clip = finished.clips[0];
    const clipFile = join(workspace, `${clip.id}.mp4`);
    await writeFile(clipFile, (server.storage as MemoryStorage).objects.get(clip.outputPath)!);
    const facts = await inspect(clipFile);
    assert.deepEqual({ width: facts.width, height: facts.height }, { width: 720, height: 1280 }, 'the faster quality is two thirds of the configured 1080x1920');
    assert.equal((server.storage as MemoryStorage).objects.has(`${job.id}/${clip.id}.srt`), false, 'no captions were asked for, so none are made');

    const page = await (await fetch(`${server.base}/jobs/${job.id}`)).text();
    assert.match(page, /Done in /);
    assert.match(page, /Where the time went/);
    assert.match(page, /<video controls[^>]*src="\/api\/jobs\/[0-9a-f-]{36}\/clips\/[0-9a-f-]{36}#t=0\.1"/, 'a finished job plays its clips on the page');
    assert.doesNotMatch(page, /http-equiv="refresh"/);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the options from the upload form are read, kept, and shown as choices on the upload page', needsFfmpeg, async () => {
  const schema = schemaName('form'); const server = await start({ schema });
  try {
    const page = await (await fetch(`${server.base}/test-upload`)).text();
    for (const name of ['clipCount', 'clipLength', 'quality', 'captionStyle']) assert.ok(page.includes(`name="${name}"`), `the form has no ${name} choice`);
    for (const style of ['classic', 'highlight', 'pop', 'none']) assert.ok(page.includes(`<option value="${style}">`), `the form does not offer the ${style} captions`);
    assert.match(page, /Automatic \(up to 1\)/, 'the automatic choice says what it means on this server');
    assert.match(page, /Automatic \(2–6 s\)/);

    const response = await uploadWith(server.base, '/test-upload', await readFile(sampleVideo), { clipCount: '1', clipLength: '', quality: 'hd', captionStyle: 'classic' });
    assert.equal(response.status, 200);
    const id = response.url.match(/\/jobs\/([0-9a-f-]{36})$/)![1];
    const finished = await waitForJob(server.base, id) as JobView & { job: { options: unknown } };
    assert.deepEqual(finished.job.options, { clipCount: 1, clipLength: 'auto', quality: 'hd', captionStyle: 'classic' }, 'a blank choice means automatic');
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('an option that is not allowed is refused with a plain message and leaves nothing behind', async () => {
  const schema = schemaName('badopt'); const server = await start({ schema });
  try {
    const api = await uploadWith(server.base, '/api/jobs', Buffer.alloc(64 * 1024, 3), { clipCount: '9' });
    assert.equal(api.status, 400);
    const body = await api.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'INVALID_OPTIONS');
    assert.match(body.error.message, /clipCount/);

    const form = await uploadWith(server.base, '/test-upload', Buffer.alloc(64 * 1024, 3), { quality: '8k' });
    assert.equal(form.status, 400);
    assert.match(await form.text(), /“quality” is not valid/);

    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), [], 'the refused videos must not stay on the disk');
    assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the job page shows a progress bar while a job runs and the clips as players when it is done', async () => {
  const schema = schemaName('jobpage'); const server = await start({ schema });
  try {
    const now = new Date().toISOString();
    const base = { originalFilename: 'talk.mp4', storedFilename: 'talk.mp4', mimeType: 'video/mp4', sizeBytes: 1, errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
    const working = randomUUID(); const done = randomUUID(); const clipId = randomUUID();
    await server.studio.db.createJob({ ...base, id: working, status: 'processing', stage: 'transcribing' });
    await server.studio.db.updateJob(working, { progress: 40 });
    await server.studio.db.createJob({ ...base, id: done, status: 'completed', stage: 'clip_extraction_complete' });
    await server.studio.db.updateJob(done, { progress: 100, stageTimings: { transcribing: 61_000, extracting_clips: 125_000 } });
    await server.studio.db.createClip({ id: clipId, jobId: done, candidateId: 'c', startSeconds: 0, endSeconds: 12, durationSeconds: 12, outputPath: `${done}/${clipId}.mp4`, outputFilename: `${clipId}.mp4`, status: 'completed', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now });

    const workingPage = await (await fetch(`${server.base}/jobs/${working}`)).text();
    assert.match(workingPage, /<progress value="40" max="100">/);
    assert.match(workingPage, /Listening to the speech/);
    assert.match(workingPage, /http-equiv="refresh"/);
    assert.doesNotMatch(workingPage, /<video/, 'a page that reloads itself must not offer players that would be cut off');

    const donePage = await (await fetch(`${server.base}/jobs/${done}`)).text();
    assert.ok(donePage.includes(`<video controls playsinline preload="metadata" src="/api/jobs/${done}/clips/${clipId}#t=0.1">`));
    assert.ok(donePage.includes(`href="/api/jobs/${done}/clips/${clipId}?download=1"`));
    assert.match(donePage, /Done in 3 min 06 s/);
    assert.match(donePage, /Listening to the speech<\/td><td>1 min 01 s/);
    assert.doesNotMatch(donePage, /http-equiv="refresh"/);

    const missing = await fetch(`${server.base}/jobs/${randomUUID()}`);
    assert.equal(missing.status, 404);
  } finally { await server.stop(); await dropSchema(schema); }
});

/** Stands in for Render's public front door: records every request that arrives at the service's "public address". */
async function frontDoor() {
  const knocks: Array<{ url: string; agent: string | undefined }> = [];
  const door = createServer((req, res) => { knocks.push({ url: req.url ?? '', agent: req.headers['user-agent'] }); res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); });
  door.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => door.once('listening', resolve));
  return { url: `http://127.0.0.1:${(door.address() as AddressInfo).port}`, knocks, close: () => new Promise<void>((resolve) => { door.closeAllConnections(); door.close(() => resolve()); }) };
}

/** Starts an upload of a 50 MB video, sends 1 MB of it and then waits, like a phone on a slow connection. */
async function startSlowUpload(server: RunningServer, route = '/api/jobs') {
  const boundary = `----slow${randomUUID()}`;
  const socket = net.connect(Number(new URL(server.base).port), '127.0.0.1');
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(`POST ${route} HTTP/1.1\r\nHost: test\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${50 * 1024 * 1024}\r\n\r\n--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="big.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
  socket.write(Buffer.alloc(1024 * 1024, 7));
  await eventually('the server to start writing the upload to disk', () => readdir(server.dirs.UPLOAD_DIR), (files) => files.length === 1);
  return socket;
}

test('while a job is being processed the instance requests its own public address, and stops as soon as the work is done', needsFfmpeg, async () => {
  const schema = schemaName('awake'); const door = await frontDoor();
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  const server = await start({ schema, transcriber: slowTalk, env: { RENDER_EXTERNAL_URL: door.url }, keepAwakeIntervalMs: 40 });
  try {
    await sleep(200);
    assert.equal(door.knocks.length, 0, 'an idle server must not knock');

    const { job } = await (await upload(server.base, '/api/jobs', await readFile(sampleVideo))).json() as { job: { id: string } };
    await eventually('knocks while the job is being processed', () => door.knocks.length, (count) => count >= 3);
    assert.ok(door.knocks.every((knock) => knock.url === '/api/health'), 'it must only ever request the health endpoint');
    assert.ok(door.knocks.every((knock) => knock.agent === 'short-form-video-studio-keep-awake'), 'its requests must be recognisable in the logs');

    release();
    const finished = await waitForJob(server.base, job.id);
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    await untilSettled(server);
    await sleep(150); // a request that was already on its way may still land
    const afterWork = door.knocks.length;
    await sleep(300);
    assert.equal(door.knocks.length, afterWork, 'it must stop knocking once the work is done');
  } finally { release(); await server.stop(); await door.close(); await dropSchema(schema); }
});

test('an upload that is still arriving counts as work, and a client that disappears stops counting', async () => {
  const schema = schemaName('awake_upload'); const door = await frontDoor();
  const server = await start({ schema, env: { RENDER_EXTERNAL_URL: door.url }, keepAwakeIntervalMs: 40 });
  try {
    const socket = await startSlowUpload(server);
    await eventually('knocks during the slow upload', () => door.knocks.length, (count) => count >= 2);
    socket.destroy();
    await eventually('the half-received file to be removed', () => readdir(server.dirs.UPLOAD_DIR), (files) => files.length === 0);
    await sleep(150);
    const afterAbandoned = door.knocks.length;
    await sleep(300);
    assert.equal(door.knocks.length, afterAbandoned, 'an abandoned upload must not keep the instance awake');
  } finally { await server.stop(); await door.close(); await dropSchema(schema); }
});

test('with KEEP_AWAKE_WHILE_PROCESSING switched off the instance never requests its own address, even while an upload is arriving', async () => {
  const schema = schemaName('awake_off'); const door = await frontDoor();
  const server = await start({ schema, env: { RENDER_EXTERNAL_URL: door.url, KEEP_AWAKE_WHILE_PROCESSING: 'false' }, keepAwakeIntervalMs: 40 });
  try {
    const socket = await startSlowUpload(server);
    await sleep(400);
    socket.destroy();
    assert.equal(door.knocks.length, 0);
  } finally { await server.stop(); await door.close(); await dropSchema(schema); }
});
