import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createApp, type AppOverrides } from './app.js';
import { loadConfig } from './config.js';
import { StudioDatabase } from './database.js';
import type { ClipFramer } from './face-track.js';
import { SAYS_HLG, probeToneMapping } from './hdr.js';
import type { MachineLimits } from './machine.js';
import { NullStorage, type DurableStorage } from './storage.js';
import { MemoryStorage, eventually, isAlive, sleep, speechSampleJson, writeFakeWhisper } from './test-support.js';
import { onlyVideos, plainWords } from './failures.js';
import { describeBasis, type KnownSpeeds } from './speeds.js';
import type { ToolchainReport } from './toolchain.js';
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

/** A genuine 2-second video with no sound track at all. */
const silentVideo = join(workspace, 'silent.mp4');
if (hasFfmpeg) await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silentVideo]);

/** What an iPhone records: 8 seconds of ten bits per colour, BT.2020 colours and the HLG curve (written with FFV1, which every FFmpeg has). */
const hdrVideo = join(workspace, 'iphone-hdr.mkv');
if (hasFfmpeg) await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=160x120:rate=10,format=yuv420p10le', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-vf', SAYS_HLG, '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', '-c:a', 'pcm_s16le', hdrVideo]);

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
async function start(options: { schema: string; storage?: DurableStorage; transcriber?: TranscriptionEngine; /** Use the engine the configuration asks for (whisper.cpp, here a stand-in program) instead of the fixed text. */ realSpeechEngine?: boolean; env?: Record<string, string>; keepAwakeIntervalMs?: number; bootRecoveryWaitMs?: number; framer?: ClipFramer | null; extra?: AppOverrides }): Promise<RunningServer> {
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
  const studio = await createApp(config, { storage, transcriber: options.realSpeechEngine ? undefined : options.transcriber ?? talk, databaseSchema: options.schema, keepAwakeIntervalMs: options.keepAwakeIntervalMs, bootRecoveryWaitMs: options.bootRecoveryWaitMs, framer: options.framer, ...options.extra });
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
    assert.deepEqual(((await api.json()) as { error: unknown }).error, { code: 'INVALID_UPLOAD', message: 'Video exceeds the 1 MB upload limit.' });
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
    assert.deepEqual(job.options, { clipCount: 1, clipLength: 'auto', quality: 'standard', captionStyle: 'none', captionAccent: 'gold', captionPosition: 'lower', captionSize: 'medium', framing: 'center', aspect: 'vertical' });

    const finished = await waitForJob(server.base, job.id) as JobView & { job: { progress: number; stageTimings: Record<string, number>; options: unknown } };
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    assert.equal(finished.job.progress, 100);
    assert.ok(Object.keys(finished.job.stageTimings).includes('transcribing') && Object.keys(finished.job.stageTimings).includes('extracting_clips'), 'the stages must be timed');
    assert.deepEqual(finished.job.options, { clipCount: 1, clipLength: 'auto', quality: 'standard', captionStyle: 'none', captionAccent: 'gold', captionPosition: 'lower', captionSize: 'medium', framing: 'center', aspect: 'vertical' });
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

test('the shape chosen at upload is kept with the job and is the shape of the clip the real FFmpeg makes', needsFfmpeg, async () => {
  const schema = schemaName('shape'); const server = await start({ schema });
  try {
    // The test server is configured for 360x640, so these are the sizes of the shapes at that configuration.
    for (const [aspect, expected] of [['square', { width: 360, height: 360 }], ['landscape', { width: 640, height: 360 }], ['portrait', { width: 360, height: 450 }]] as const) {
      const response = await uploadWith(server.base, '/api/jobs', await readFile(sampleVideo), { clipCount: '1', aspect });
      assert.equal(response.status, 202);
      const { job } = await response.json() as { job: { id: string; options: { aspect: string } } };
      assert.equal(job.options.aspect, aspect);
      const finished = await waitForJob(server.base, job.id) as JobView & { job: { options: { aspect: string } }; clips: Array<{ id: string; outputPath: string }> };
      assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
      assert.equal(finished.job.options.aspect, aspect, 'the choice is kept with the job');
      await untilSettled(server);
      const clipFile = join(workspace, `${finished.clips[0].id}-${aspect}.mp4`);
      await writeFile(clipFile, (server.storage as MemoryStorage).objects.get(finished.clips[0].outputPath)!);
      const facts = await inspect(clipFile);
      assert.deepEqual({ width: facts.width, height: facts.height }, expected, `the ${aspect} clip has the size of its shape`);
      assert.ok(facts.kinds.includes('video') && facts.kinds.includes('audio'), 'the sound is kept');
    }
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the options from the upload form are read, kept, and shown as choices on the upload page', needsFfmpeg, async () => {
  const schema = schemaName('form'); const server = await start({ schema });
  try {
    const page = await (await fetch(`${server.base}/test-upload`)).text();
    for (const name of ['clipCount', 'clipLength', 'quality', 'captionStyle', 'captionAccent', 'captionPosition', 'captionSize', 'framing', 'aspect']) assert.ok(page.includes(`name="${name}"`), `the form has no ${name} choice`);
    for (const aspect of ['vertical', 'portrait', 'square', 'landscape']) assert.ok(page.includes(`<option value="${aspect}">`), `the form does not offer the ${aspect} shape`);
    for (const framing of ['center', 'face', 'fit']) assert.ok(page.includes(`<option value="${framing}">`), `the form does not offer the ${framing} framing`);
    for (const style of ['classic', 'highlight', 'pop', 'none']) assert.ok(page.includes(`<option value="${style}">`), `the form does not offer the ${style} captions`);
    assert.match(page, /Automatic \(up to 1\)/, 'the automatic choice says what it means on this server');
    assert.match(page, /Automatic \(2–6 s\)/);

    const response = await uploadWith(server.base, '/test-upload', await readFile(sampleVideo), { clipCount: '1', clipLength: '', quality: 'hd', captionStyle: 'classic' });
    assert.equal(response.status, 200);
    const id = response.url.match(/\/jobs\/([0-9a-f-]{36})$/)![1];
    const finished = await waitForJob(server.base, id) as JobView & { job: { options: unknown } };
    assert.deepEqual(finished.job.options, { clipCount: 1, clipLength: 'auto', quality: 'hd', captionStyle: 'classic', captionAccent: 'gold', captionPosition: 'lower', captionSize: 'medium', framing: 'center', aspect: 'vertical' }, 'a blank choice means automatic');
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

    const framing = await uploadWith(server.base, '/api/jobs', Buffer.alloc(64 * 1024, 3), { framing: 'sideways' });
    assert.equal(framing.status, 400);
    assert.match(((await framing.json()) as { error: { message: string } }).error.message, /framing/);

    const shape = await uploadWith(server.base, '/api/jobs', Buffer.alloc(64 * 1024, 3), { aspect: 'cinema' });
    assert.equal(shape.status, 400);
    assert.match(((await shape.json()) as { error: { message: string } }).error.message, /aspect/);

    for (const [field, value] of [['captionAccent', 'purple'], ['captionPosition', 'bottom'], ['captionSize', 'huge']]) {
      const look = await uploadWith(server.base, '/api/jobs', Buffer.alloc(64 * 1024, 3), { [field]: value });
      assert.equal(look.status, 400, `${field}=${value}`);
      assert.match(((await look.json()) as { error: { message: string } }).error.message, new RegExp(field));
    }

    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), [], 'the refused videos must not stay on the disk');
    assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('following a face, end to end: the choice is kept with the job, the clip is cut along the plan by the real FFmpeg, and the clip says what was done', needsFfmpeg, async () => {
  const schema = schemaName('face'); const asked: Array<{ startSeconds: number; endSeconds: number }> = [];
  const framer: ClipFramer = { frame: async ({ startSeconds, endSeconds }) => { asked.push({ startSeconds, endSeconds }); return { followed: true, plan: { keyframes: [{ seconds: 0, position: 0 }, { seconds: 1, position: 0 }, { seconds: 1.5, position: 1 }] }, seenShare: 0.9, tracksFollowed: 1, note: 'Followed a face, seen in 90% of the moments checked.' }; } };
  const server = await start({ schema, framer });
  try {
    const response = await uploadWith(server.base, '/api/jobs', await readFile(sampleVideo), { clipCount: '1', captionStyle: 'none', framing: 'face' });
    assert.equal(response.status, 202);
    const { job } = await response.json() as { job: { id: string; options: { framing: string } } };
    assert.equal(job.options.framing, 'face');

    const finished = await waitForJob(server.base, job.id) as JobView & { job: { options: { framing: string } }; clips: Array<{ id: string; status: string; outputPath: string; framing: string | null }> };
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    assert.equal(finished.job.options.framing, 'face', 'the choice is kept with the job');
    await untilSettled(server);
    assert.equal(asked.length, 1, 'one look for a face for the one clip');
    assert.ok(asked[0].startSeconds >= 0 && asked[0].endSeconds <= 8.001 && asked[0].endSeconds > asked[0].startSeconds, 'looked for in a stretch of the video');

    const [clip] = finished.clips;
    assert.equal(clip.status, 'completed');
    assert.equal(clip.framing, 'Followed a face, seen in 90% of the moments checked.', 'the API tells what was done');
    const clipFile = join(workspace, `${clip.id}-face.mp4`);
    await writeFile(clipFile, (server.storage as MemoryStorage).objects.get(clip.outputPath)!);
    const facts = await inspect(clipFile);
    assert.deepEqual({ width: facts.width, height: facts.height, codec: facts.codec }, { width: 360, height: 640, codec: 'h264' }, 'FFmpeg accepted the moving window and made a normal vertical clip');
    assert.ok(facts.kinds.includes('video') && facts.kinds.includes('audio'), 'the sound is kept');

    const page = await (await fetch(`${server.base}/jobs/${job.id}`)).text();
    assert.match(page, /Followed a face, seen in 90% of the moments checked\./, 'the job page says what was done too');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the whole picture over a blurred copy, end to end: chosen on the form, kept with the job, and the real FFmpeg makes a normal vertical clip with no empty bands', needsFfmpeg, async () => {
  const schema = schemaName('fit'); const server = await start({ schema, framer: null });
  try {
    const response = await uploadWith(server.base, '/test-upload', await readFile(sampleVideo), { clipCount: '1', captionStyle: 'none', framing: 'fit' });
    assert.equal(response.status, 200);
    const id = response.url.match(/\/jobs\/([0-9a-f-]{36})$/)![1];
    const finished = await waitForJob(server.base, id) as JobView & { job: { options: { framing: string } }; clips: Array<{ id: string; outputPath: string; framing: string | null }> };
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    assert.equal(finished.job.options.framing, 'fit');
    assert.equal(finished.clips[0].framing, null, 'nothing to explain: the whole picture is shown');
    await untilSettled(server);

    const clipFile = join(workspace, `${finished.clips[0].id}-fit.mp4`);
    await writeFile(clipFile, (server.storage as MemoryStorage).objects.get(finished.clips[0].outputPath)!);
    const facts = await inspect(clipFile);
    assert.deepEqual({ width: facts.width, height: facts.height, codec: facts.codec }, { width: 360, height: 640, codec: 'h264' });
    // The sample video is 320 x 240, so its picture takes the middle 270 rows of 640 and the first rows are the blurred copy: they must not be black.
    const { stdout } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', clipFile, '-frames:v', '1', '-vf', 'crop=360:60:0:0,format=gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    const average = stdout.reduce((total, value) => total + value, 0) / stdout.length;
    assert.ok(stdout.length === 360 * 60 && average > 25, `the top of the clip is a copy of the picture, not black (average brightness ${average.toFixed(0)})`);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the choice to follow a face is only offered when this server can do it, and asking anyway still gives the clips, from the middle, with a note', needsFfmpeg, async () => {
  for (const setting of [{ label: 'no framer', framer: null as null }, { label: 'switched off by FACE_FRAMING_ENABLED', env: { FACE_FRAMING_ENABLED: 'false' } }]) {
    const schema = schemaName('noface'); const server = await start({ schema, framer: setting.framer, env: setting.env });
    try {
      const page = await (await fetch(`${server.base}/test-upload`)).text();
      assert.ok(!page.includes('<option value="face">') && !page.includes('Follow a face'), `${setting.label}: the page must not offer what the server cannot do`);
      assert.ok(page.includes('<option value="fit">'), `${setting.label}: what it can do is still offered`);
      assert.ok(page.includes('name="captionStyle"'), `${setting.label}: the other choices are still there`);

      const response = await uploadWith(server.base, '/api/jobs', await readFile(sampleVideo), { clipCount: '1', captionStyle: 'none', framing: 'face' });
      assert.equal(response.status, 202, `${setting.label}: a request that names the option is not refused`);
      const { job } = await response.json() as { job: { id: string } };
      const finished = await waitForJob(server.base, job.id) as JobView & { clips: Array<{ framing: string | null }> };
      assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
      assert.equal(finished.clips[0].framing, 'Centred: following a face is switched off on this server.', setting.label);
      await untilSettled(server);
    } finally { await server.stop(); await dropSchema(schema); }
  }
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
    await server.studio.db.createClip({ id: clipId, jobId: done, candidateId: 'c', startSeconds: 0, endSeconds: 12, durationSeconds: 12, outputPath: `${done}/${clipId}.mp4`, outputFilename: `${clipId}.mp4`, status: 'completed', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now, title: null, score: null, reasons: [], framing: null });

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

// ---- The access code (ACCESS_CODE) -------------------------------------------------------------------------------------------------

const ACCESS_CODE = 'blue-river-7421';
const gated = { ACCESS_CODE };
const noDelay = { accessFailureDelayMs: 0 };
const manual = (headers: Record<string, string> = {}) => ({ redirect: 'manual' as const, headers });
const login = (base: string, fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0];

test('with an access code set, only the health check and the way in are open, and nothing is stored for someone without the code', async () => {
  const schema = schemaName('gate'); const server = await start({ schema, env: gated, extra: noDelay });
  try {
    const health = await fetch(`${server.base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { access: { codeRequired: boolean } }).access.codeRequired, true, 'the health check says whether a code is needed, and nothing more');

    for (const path of ['/', '/test-upload', `/jobs/${randomUUID()}`, '/anything-else']) {
      const response = await fetch(`${server.base}${path}`, manual());
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('location'), `/login?next=${encodeURIComponent(path)}`, path);
    }
    for (const path of ['/api/jobs/x', '/api/jobs/x/transcript', '/api/jobs/x/highlights', `/api/jobs/${randomUUID()}/clips/${randomUUID()}`, '/api/nothing-here']) {
      const response = await fetch(`${server.base}${path}`);
      assert.equal(response.status, 401, path);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'ACCESS_CODE_REQUIRED', path);
      assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer /);
    }

    const api = await uploadWith(server.base, '/api/jobs', Buffer.alloc(64 * 1024, 3), {});
    assert.equal(api.status, 401);
    const form = await uploadWith(server.base, '/test-upload', Buffer.alloc(64 * 1024, 3), {});
    assert.equal(form.status, 401);
    assert.match(await form.text(), /Access code needed/);
    const youtube = await fetch(`${server.base}/api/youtube`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://example.test/v"}' });
    assert.equal(youtube.status, 401);
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), [], 'nothing was written for somebody who has not given the code');
    assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('typing the right code opens the door for a month, a wrong one does not, the page it leads to is a place on this server, and logging out closes it again', async () => {
  const schema = schemaName('login'); const server = await start({ schema, env: gated, extra: noDelay });
  try {
    const page = await fetch(`${server.base}/login?next=${encodeURIComponent('/jobs/abc')}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<input name="code" type="password"[^>]*required/);
    assert.match(html, /<input type="hidden" name="next" value="\/jobs\/abc">/);
    const hostile = await (await fetch(`${server.base}/login?next=${encodeURIComponent('/x"><script>alert(1)</script>')}`)).text();
    assert.doesNotMatch(hostile, /<script>alert/);
    assert.match(hostile, /value="\/x&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/, 'what comes with the address is escaped');
    assert.match(await (await fetch(`${server.base}/login?next=${encodeURIComponent('https://evil.example')}`)).text(), /name="next" value="\/test-upload"/, 'another site is never a destination');

    const wrong = await login(server.base, { code: 'not-the-code-1', next: '/jobs/abc' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
    assert.match(await wrong.text(), /That code is not right/);

    const right = await login(server.base, { code: ACCESS_CODE, next: '/jobs/abc' });
    assert.equal(right.status, 303);
    assert.equal(right.headers.get('location'), '/jobs/abc');
    const setCookie = right.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^studio_access=v1\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/, 'a month, not readable by scripts, not sent along with other sites\' requests; no Secure flag on plain http');
    assert.ok(!setCookie.includes(ACCESS_CODE), 'the cookie does not hold the code');
    const elsewhere = await login(server.base, { code: ACCESS_CODE, next: '//evil.example/x' });
    assert.equal(elsewhere.headers.get('location'), '/test-upload');

    const cookie = cookieOf(right);
    assert.equal((await fetch(`${server.base}/test-upload`, manual({ cookie }))).status, 200);
    assert.equal((await fetch(`${server.base}/`, manual({ cookie }))).status, 302);
    assert.equal((await fetch(`${server.base}/`, manual({ cookie }))).headers.get('location'), '/test-upload', 'past the door the bare address leads to the upload page again');
    const known = await fetch(`${server.base}/api/jobs/${randomUUID()}`, { headers: { cookie } });
    assert.equal(known.status, 404, 'past the door a missing job is just missing');
    assert.equal(((await known.json()) as { error: { code: string } }).error.code, 'JOB_NOT_FOUND');
    assert.equal((await fetch(`${server.base}/login`, manual({ cookie }))).status, 302, 'somebody who is in already is not asked again');
    assert.equal((await fetch(`${server.base}/test-upload`, manual({ cookie: cookie.replace(/.$/, 'x') }))).status, 302, 'a cookie that is not the right one is no cookie');

    const out = await fetch(`${server.base}/logout`, manual({ cookie }));
    assert.equal(out.status, 302);
    assert.equal(out.headers.get('location'), '/login');
    assert.match(out.headers.get('set-cookie') ?? '', /^studio_access=; Path=\/; Max-Age=0;/);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('programs can give the code in a header instead of a cookie, and a wrong one gets nothing', async () => {
  const schema = schemaName('bearer'); const server = await start({ schema, env: gated, extra: noDelay });
  try {
    const id = randomUUID();
    const accepted: Record<string, string>[] = [{ authorization: `Bearer ${ACCESS_CODE}` }, { authorization: `bearer ${ACCESS_CODE}` }, { 'x-access-code': ACCESS_CODE }];
    for (const [index, headers] of accepted.entries()) {
      const response = await fetch(`${server.base}/api/jobs/${id}`, { headers });
      assert.equal(response.status, 404, `accepted form ${index + 1}`);
    }
    const refusedForms: Record<string, string>[] = [{ authorization: 'Bearer not-the-code-1' }, { authorization: ACCESS_CODE }, { 'x-access-code': 'not-the-code-1' }, { authorization: `Basic ${ACCESS_CODE}` }];
    for (const [index, headers] of refusedForms.entries()) {
      const response = await fetch(`${server.base}/api/jobs/${id}`, { headers });
      assert.equal(response.status, 401, `refused form ${index + 1}`);
    }
    const refused = await fetch(`${server.base}/api/jobs/${id}?code=${ACCESS_CODE}`);
    assert.equal(refused.status, 401, 'the code in an address is never accepted: addresses end up in histories and logs');
    const upload = await uploadWith(server.base, '/api/jobs', Buffer.alloc(64 * 1024, 3), {});
    assert.equal(upload.status, 401);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('after ten wrong codes an address has to wait, even with the right one', async () => {
  const schema = schemaName('throttle'); const server = await start({ schema, env: gated, extra: noDelay });
  try {
    for (let attempt = 1; attempt <= 10; attempt += 1) assert.equal((await login(server.base, { code: `wrong-code-${attempt}` })).status, 401, `attempt ${attempt}`);
    const blocked = await login(server.base, { code: ACCESS_CODE });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 14 * 60 && Number(blocked.headers.get('retry-after')) <= 15 * 60);
    assert.equal(blocked.headers.get('set-cookie'), null, 'not even the right code opens the door while it has to wait');
    assert.match(await blocked.text(), /Too many wrong codes\. Try again in 1[45] minutes/);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('without an access code nothing changes: no login, no cookie, everything open as before', async () => {
  const schema = schemaName('nogate'); const server = await start({ schema });
  try {
    assert.equal(((await (await fetch(`${server.base}/api/health`)).json()) as { access: { codeRequired: boolean } }).access.codeRequired, false);
    assert.equal((await fetch(`${server.base}/test-upload`, manual())).status, 200);
    const page = await fetch(`${server.base}/login?next=${encodeURIComponent('/jobs/abc')}`, manual());
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/jobs/abc');
    const posted = await login(server.base, { code: 'anything-at-all', next: '/test-upload' });
    assert.equal(posted.status, 303);
    assert.equal(posted.headers.get('set-cookie'), null);
    assert.equal((await fetch(`${server.base}/api/jobs/${randomUUID()}`)).status, 404);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('behind https the cookie is marked so that it is never sent over plain http', async () => {
  const schema = schemaName('secure'); const server = await start({ schema, env: { ...gated, RENDER_EXTERNAL_URL: 'https://studio.example.test' }, extra: noDelay });
  try {
    const response = await login(server.base, { code: ACCESS_CODE });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('set-cookie') ?? '', /; HttpOnly; SameSite=Lax; Secure$/);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('a person gets in, uploads, watches the job and fetches a clip, and neither the code, the cookie nor the signed download address ever reach the logs', needsFfmpeg, async () => {
  const schema = schemaName('gatedlogs'); const lines: string[] = [];
  const server = await start({ schema, env: gated, extra: { ...noDelay, logLevel: 'info', logDestination: { write: (line) => { lines.push(line); } } } });
  try {
    await fetch(`${server.base}/test-upload`, manual());
    const wrong = await login(server.base, { code: 'definitely-wrong-9' });
    assert.equal(wrong.status, 401);
    const right = await login(server.base, { code: ACCESS_CODE, next: '/test-upload' });
    const cookie = cookieOf(right);
    assert.match(cookie, /^studio_access=v1\./);

    const form = new FormData();
    form.append('clipCount', '1'); form.append('captionStyle', 'none');
    form.append('video', new Blob([new Uint8Array(await readFile(sampleVideo))], { type: 'video/mp4' }), 'match.mp4');
    const posted = await fetch(`${server.base}/test-upload`, { method: 'POST', body: form, headers: { cookie } });
    assert.equal(posted.status, 200, 'followed to the job page, with the cookie');
    const id = posted.url.match(/\/jobs\/([0-9a-f-]{36})$/)![1];
    const finished = await (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const view = await (await fetch(`${server.base}/api/jobs/${id}`, { headers: { authorization: `Bearer ${ACCESS_CODE}` } })).json() as JobView;
        if (view.job.status === 'completed' || view.job.status === 'failed') return view;
        if (Date.now() > deadline) throw new Error('the job did not finish');
        await sleep(100);
      }
    })();
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    await untilSettled(server);
    const page = await (await fetch(`${server.base}/jobs/${id}`, { headers: { cookie } })).text();
    assert.match(page, /<video controls/, 'the finished job page is shown to somebody with the cookie');
    const clip = await fetch(`${server.base}/api/jobs/${id}/clips/${finished.clips[0].id}?download=1`, { redirect: 'manual', headers: { cookie } });
    assert.equal(clip.status, 302);
    assert.match(clip.headers.get('location') ?? '', /^https:\/\/storage\.test\//, 'the clip is sent on to its storage address, as before');

    const everything = lines.join('');
    assert.match(everything, /"url":"\/api\/jobs\//, 'requests are still logged');
    assert.ok(everything.includes('[hidden]'), 'and what must not be there is replaced');
    for (const secret of [ACCESS_CODE, 'definitely-wrong-9', cookie.split('=')[1], 'storage.test']) assert.ok(!everything.includes(secret), `a secret reached the logs: ${secret.slice(0, 12)}…`);
    assert.match(everything, /A wrong access code was given/, 'a wrong guess is noted, without saying what was typed');
  } finally { await server.stop(); await dropSchema(schema); }
});


// ---- The check of the video tools ---------------------------------------------------------------------------------------------------

interface HealthView { status: string; toolchain: { state: string; checkedAt: string | null; failed: string[] } }
const healthOf = async (base: string) => (await (await fetch(`${base}/api/health`)).json()) as HealthView;
const passedReport: ToolchainReport = { ok: true, steps: [{ name: 'ffmpeg', ok: true, ms: 3, detail: 'ffmpeg 9.9.9 at /secret/path/ffmpeg' }] };
const failedReport: ToolchainReport = { ok: false, steps: [{ name: 'ffmpeg', ok: true, ms: 3, detail: 'ffmpeg 9.9.9 at /secret/path/ffmpeg' }, { name: 'filters', ok: false, ms: 4, detail: 'no filter named ass at /secret/path/ffmpeg' }] };

test('the health check says whether the video tools were checked and which checks failed, and never what was found', async () => {
  const schema = schemaName('toolhealth'); let report = passedReport;
  const server = await start({ schema, extra: { toolchainCheck: async () => report, toolchainRetryMs: 5 } });
  try {
    assert.deepEqual((await healthOf(server.base)).toolchain, { state: 'pending', checkedAt: null, failed: [] }, 'nothing has been checked until the server that listens starts the check');
    await server.studio.toolchain.run();
    const passed = await healthOf(server.base);
    assert.equal(passed.status, 'ok');
    assert.equal(passed.toolchain.state, 'passed');
    assert.ok(passed.toolchain.checkedAt && !Number.isNaN(Date.parse(passed.toolchain.checkedAt)));
    assert.deepEqual(passed.toolchain.failed, []);

    report = failedReport;
    await server.studio.toolchain.run();
    const failed = await healthOf(server.base);
    assert.equal(failed.status, 'ok', 'a failed check does not make the server look dead: a host would restart it for ever');
    assert.deepEqual(failed.toolchain.failed, ['filters']);
    assert.equal(failed.toolchain.state, 'failed');
    const everything = JSON.stringify(await (await fetch(`${server.base}/api/health`)).json());
    for (const secret of ['9.9.9', '/secret/path', 'no filter named']) assert.ok(!everything.includes(secret), `the health check shows ${secret}`);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('with the check switched off the health check says so and the server never looks at its tools', async () => {
  const schema = schemaName('toolsoff'); let looked = 0;
  const server = await start({ schema, env: { TOOLCHAIN_CHECK_ENABLED: 'false' }, extra: { toolchainCheck: async () => { looked += 1; return passedReport; } } });
  try {
    assert.deepEqual((await healthOf(server.base)).toolchain, { state: 'disabled', checkedAt: null, failed: [] });
    assert.equal(looked, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the real check, in the real server: a missing whisper.cpp is the one thing reported, and with it in place everything passes (both said in the log)', needsFfmpeg, async () => {
  const schema = schemaName('toolreal'); const lines: string[] = [];
  const whisperBinary = join(workspace, 'whisper-for-check'); const whisperModel = join(workspace, 'ggml-for-check.bin');
  const whisperStarts = join(workspace, 'whisper-for-check.starts');
  await writeFakeWhisper(whisperBinary, { argsLog: whisperStarts });   // says its usage, and writes what whisper.cpp writes for the recording of speech that comes with the program
  await writeFile(whisperModel, ''); await truncate(whisperModel, 12 * 1024 * 1024);
  const logging = { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } };

  const missing = await start({ schema, env: { WHISPER_CPP_PATH: join(workspace, 'no-whisper-here'), WHISPER_MODEL_PATH: whisperModel }, extra: logging });
  try {
    const status = await missing.studio.toolchain.run();
    assert.equal(status.state, 'failed');
    assert.deepEqual(status.failed, ['speech-engine', 'speech-sample'], 'FFmpeg, the fonts, the captions, the layouts and the face follower all work here, and only the missing program is named (and the recording that needs it, not listened to)');
    assert.deepEqual((await healthOf(missing.base)).toolchain.failed, ['speech-engine', 'speech-sample']);
  } finally { await missing.stop(); await dropSchema(schema); }
  const failedLine = lines.map((line) => JSON.parse(line) as { level: number; msg?: string; steps?: Array<{ name: string; ok: boolean }> }).find((entry) => entry.msg?.startsWith('Toolchain check FAILED'));
  assert.ok(failedLine, 'the failure is in the log');
  assert.equal(failedLine.level, 50, 'at error level, so that it is found');
  assert.match(failedLine.msg ?? '', /^Toolchain check FAILED: speech-engine, speech-sample\./);
  assert.ok(failedLine.steps?.some((step) => step.name === 'face-following' && step.ok), 'the follower was checked too, since it is on offer');

  lines.length = 0;
  const schema2 = schemaName('toolreal2');
  const working = await start({ schema: schema2, env: { WHISPER_CPP_PATH: whisperBinary, WHISPER_MODEL_PATH: whisperModel, WHISPER_THREADS: '2' }, extra: { ...logging, machine: smallInstance } });
  try {
    const status = await working.studio.toolchain.run();
    assert.equal(status.state, 'passed', lines.join('\n').slice(-1500));
    assert.deepEqual((await healthOf(working.base)).toolchain.failed, []);
    assert.deepEqual(await readdir(working.dirs.TEMP_DIR), [], 'the tiny test clips are gone from the server\'s temporary folder');
  } finally { await working.stop(); await dropSchema(schema2); }
  const passedLine = lines.map((line) => JSON.parse(line) as { level: number; msg?: string; steps?: Array<{ name: string; ok: boolean }> }).find((entry) => entry.msg?.startsWith('Toolchain check passed'));
  assert.ok(passedLine, 'the pass is in the log');
  assert.equal(passedLine.level, 30);
  assert.deepEqual(passedLine.steps?.map((step) => step.name), ['machine', 'ffmpeg', 'ffprobe', 'encoders', 'filters', 'fonts', 'speech-engine', 'speech-sample', 'test-video', 'captions', 'whole-picture', 'moving-window', 'hdr-clip', 'render-speed', 'face-following'], 'what the machine is like, the recording of speech and a render at the size of real clips are part of the check unless they are switched off');
  const detail = (name: string) => (passedLine.steps as unknown as Array<{ name: string; detail: string }>).find((step) => step.name === name)?.detail ?? '';
  assert.match(detail('speech-sample'), /^wrote 22 words with their times, 100% of those said/, 'the real program, here a stand-in that writes what whisper.cpp writes, was listened to and understood');
  assert.match(detail('render-speed'), /^3 s of 360x640 with captions/, 'at the size of clips this server is set to make');
  assert.equal(detail('machine'), 'the processor share is limited to 0.15 of one core (1 cores visible); memory limited to 512 MiB', 'what the machine may use, as far as it could be read');
  assert.match(detail('speech-sample'), /; [\d.]+ s to listen to 11 s of speech, with 2 threads$/, 'the check says how many threads the speech program had: WHISPER_THREADS, which beats the machine\'s own share');
  assert.match(detail('render-speed'), / with preset ultrafast and 1 thread \(/, 'and FFmpeg: one thread, for a machine that may use 0.15 of a processor');
  const starts = (await readFile(whisperStarts, 'utf8')).split('\n').filter(Boolean);
  assert.ok(starts.length >= 1 && starts.every((line) => / -l en -t 2 -ng /.test(line)), `WHISPER_THREADS reaches the program: ${starts.join(' | ')}`);
});

const MEBIBYTE = 1024 * 1024;
/** What Render's free instance reports (measured on 27 October 2026): 0.15 of one core, 512 MiB. */
const smallInstance = async (): Promise<MachineLimits> => ({ cpuLimit: 0.15, memoryLimitBytes: 512 * MEBIBYTE, cores: 1, totalMemoryBytes: 8192 * MEBIBYTE });
/** A machine with memory to spare and no limit of its container: the colours of HDR video are converted on it (by default) when its FFmpeg can. */
const plentyOfMemory = async (): Promise<MachineLimits> => ({ cpuLimit: null, memoryLimitBytes: null, cores: 2, totalMemoryBytes: 16 * 1024 * MEBIBYTE });

/** A stand-in for FFmpeg that notes every start (one line each) and then runs the real FFmpeg: what the server asks of the program can be read afterwards. */
const writeRecordingFfmpeg = (path: string, log: string) => writeFile(path, `#!/bin/sh\necho "$*" >> '${log}'\nexec ffmpeg "$@"\n`, { mode: 0o755 });

/** A machine that may use 8 processors of the 16 it shows: whisper.cpp gets 4 threads (it gains nothing from more), FFmpeg 8. */
const bigMachine = async (): Promise<MachineLimits> => ({ cpuLimit: 8, memoryLimitBytes: null, cores: 16, totalMemoryBytes: 64 * 1024 * MEBIBYTE });

const countOf = (line: string, option: string) => line.split(' ').filter((word, index, words) => word === option.split(' ')[0] && words[index + 1] === option.split(' ')[1]).length;

test('the threads follow what the machine may use: for every job the speech program and FFmpeg (the clips, and the follower of a face) are started with them, and what is set by hand wins', needsFfmpeg, async () => {
  const sentence = 'Here is the first important point. But the second point is even better! That is why you must remember it.';
  const noLimit = async (): Promise<MachineLimits> => ({ cpuLimit: null, memoryLimitBytes: null, cores: 16, totalMemoryBytes: 64 * 1024 * MEBIBYTE });
  const unreadable = async (): Promise<MachineLimits> => { throw new Error('the control group files cannot be read here'); };
  // `speech` and `ffmpeg`: the number of threads each program must be started with (null: no option at all, the program chooses).
  const cases: Array<{ label: string; machine: () => Promise<MachineLimits>; env?: Record<string, string>; speech: number | null; ffmpeg: number | null }> = [
    { label: 'a small instance (0.15 of a processor)', machine: smallInstance, speech: 1, ffmpeg: 1 },
    { label: 'a machine that may use 8 processors: the speech program does not gain from more than 4, FFmpeg takes all 8', machine: bigMachine, speech: 4, ffmpeg: 8 },
    { label: 'no limit known (not in a container): the programs choose for themselves', machine: noLimit, speech: null, ffmpeg: null },
    { label: 'the limits cannot be read: the programs choose for themselves and the server still works', machine: unreadable, speech: null, ffmpeg: null },
    { label: 'WHISPER_THREADS and CLIP_THREADS set by hand beat the machine', machine: smallInstance, env: { WHISPER_THREADS: '3', CLIP_THREADS: '2' }, speech: 3, ffmpeg: 2 },
    { label: 'WHISPER_THREADS alone: FFmpeg stays automatic', machine: smallInstance, env: { WHISPER_THREADS: '3' }, speech: 3, ffmpeg: 1 },
    { label: 'CLIP_THREADS alone: the speech program stays automatic', machine: bigMachine, env: { CLIP_THREADS: '2' }, speech: 4, ffmpeg: 2 },
  ];
  for (const [index, setting] of cases.entries()) {
    const schema = schemaName('threads'); const speechLog = join(workspace, `threads-${index}.speech`); const ffmpegLog = join(workspace, `threads-${index}.ffmpeg`);
    const whisperBinary = join(workspace, `threads-${index}-whisper`); const ffmpegBinary = join(workspace, `threads-${index}-ffmpeg`); const model = join(workspace, `threads-${index}-model.bin`);
    await writeFakeWhisper(whisperBinary, { argsLog: speechLog, json: speechSampleJson({ text: sentence, from: 0.2, to: 7.8 }) });
    await writeRecordingFfmpeg(ffmpegBinary, ffmpegLog); await writeFile(model, '');
    const server = await start({ schema, realSpeechEngine: true, env: { WHISPER_CPP_PATH: whisperBinary, WHISPER_MODEL_PATH: model, FFMPEG_PATH: ffmpegBinary, ...setting.env }, extra: { machine: setting.machine } });
    try {
      const response = await uploadWith(server.base, '/api/jobs', await readFile(sampleVideo), { clipCount: '1', captionStyle: 'none', framing: 'face' });
      assert.equal(response.status, 202, setting.label);
      const { job } = await response.json() as { job: { id: string } };
      const finished = await waitForJob(server.base, job.id);
      assert.equal(finished.job.status, 'completed', `${setting.label}: ${finished.job.errorMessage ?? ''}`);
      assert.equal(finished.clips.length, 1, setting.label);
      await untilSettled(server);
    } finally { await server.stop(); await dropSchema(schema); }

    const listened = (await readFile(speechLog, 'utf8')).split('\n').filter(Boolean);
    assert.equal(listened.length, 1, `${setting.label}: the speech was listened to once`);
    assert.ok(listened[0].includes(setting.speech === null ? ' -l en -ng ' : ` -l en -t ${setting.speech} -ng `), `${setting.label}: the speech program was started as: ${listened[0]}`);

    const starts = (await readFile(ffmpegLog, 'utf8')).split('\n').filter(Boolean);
    const rendered = starts.filter((line) => line.includes('+faststart')); const looked = starts.filter((line) => line.includes('image2pipe'));
    assert.equal(rendered.length, 1, `${setting.label}: one clip was cut`); assert.equal(looked.length, 1, `${setting.label}: one look for a face`);
    for (const [what, line, threadOptions] of [['the clip', rendered[0], 2], ['the follower of a face', looked[0], 1]] as const) {
      if (setting.ffmpeg === null) {
        assert.ok(!/-threads|-filter_threads/.test(line), `${setting.label}: ${what} is cut with FFmpeg's own choice of threads: ${line}`);
      } else {
        assert.equal(countOf(line, `-filter_threads ${setting.ffmpeg}`), 1, `${setting.label}: the filters of ${what} use ${setting.ffmpeg} thread(s): ${line}`);
        assert.equal(countOf(line, `-threads ${setting.ffmpeg}`), threadOptions, `${setting.label}: the decoder${threadOptions === 2 ? ' and the encoder' : ''} of ${what} use ${setting.ffmpeg} thread(s): ${line}`);
        assert.equal(line.split(' ').filter((word) => word === '-threads' || word === '-filter_threads').length, threadOptions + 1, `${setting.label}: no other thread option: ${line}`);
      }
    }
  }
});

test('the log says how many threads each program is started with, and why', async () => {
  const lines: string[] = [];
  const logging = { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } };
  for (const [machine, env] of [[smallInstance, {}], [bigMachine, {}], [async (): Promise<MachineLimits> => ({ cpuLimit: null, memoryLimitBytes: null, cores: 4, totalMemoryBytes: 8192 * MEBIBYTE }), { TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example.test/v1', TRANSCRIPTION_API_KEY: 'a-key-that-is-never-logged' }]] as const) {
    const schema = schemaName('threadlog'); lines.length = 0;
    const server = await start({ schema, env, extra: { ...logging, machine } });
    await server.stop(); await dropSchema(schema);
    const entry = lines.map((line) => JSON.parse(line) as { msg?: string; processorShare?: number | null; whisperThreads?: number | null; clipThreads?: number | null }).find((candidate) => candidate.msg?.startsWith('Threads: '));
    assert.ok(entry, `the line about threads is in the log: ${lines.join('\n').slice(0, 600)}`);
    if (machine === smallInstance) {
      assert.equal(entry.msg, 'Threads: whisper.cpp with 1 thread, FFmpeg with 1 thread (this machine may use 0.15 of a processor)');
      assert.deepEqual({ share: entry.processorShare, whisper: entry.whisperThreads, clips: entry.clipThreads }, { share: 0.15, whisper: 1, clips: 1 });
    } else if (machine === bigMachine) {
      assert.equal(entry.msg, 'Threads: whisper.cpp with 4 threads, FFmpeg with 8 threads (this machine may use 8.00 of a processor)', 'each program is told its own number');
      assert.deepEqual({ share: entry.processorShare, whisper: entry.whisperThreads, clips: entry.clipThreads }, { share: 8, whisper: 4, clips: 8 });
    } else {
      assert.equal(entry.msg, "Threads: FFmpeg with the program's own choice of threads", 'a hosted speech service has no threads to count');
      assert.deepEqual({ share: entry.processorShare, whisper: entry.whisperThreads, clips: entry.clipThreads }, { share: null, whisper: null, clips: null });
      assert.ok(!lines.join('').includes('a-key-that-is-never-logged'), 'the key of a hosted service is never in the logs');
    }
  }
});

test('with a hosted speech service and face following switched off, the check leaves out what is not in use', needsFfmpeg, async () => {
  const schema = schemaName('toolhosted'); const lines: string[] = [];
  const server = await start({ schema, env: { TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example.test/v1', TRANSCRIPTION_API_KEY: 'a-key-that-is-never-used', FACE_FRAMING_ENABLED: 'false' }, extra: { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } } });
  try {
    assert.equal((await server.studio.toolchain.run()).state, 'passed');
  } finally { await server.stop(); await dropSchema(schema); }
  const entry = lines.map((line) => JSON.parse(line) as { msg?: string; steps?: Array<{ name: string }> }).find((candidate) => candidate.msg?.startsWith('Toolchain check passed'));
  assert.deepEqual(entry?.steps?.map((step) => step.name), ['machine', 'ffmpeg', 'ffprobe', 'encoders', 'filters', 'fonts', 'test-video', 'captions', 'whole-picture', 'moving-window', 'hdr-clip', 'render-speed'], 'no speech engine on this machine, so no recording to listen to');
  assert.ok(!lines.join('').includes('a-key-that-is-never-used'), 'the key of a hosted service is never in the logs');
});

test('with TOOLCHAIN_REAL_SAMPLES switched off the check is what it was: no recording of speech, no render sample, nothing about the machine', needsFfmpeg, async () => {
  const schema = schemaName('toolsamples'); const lines: string[] = [];
  const server = await start({ schema, env: { TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example.test/v1', TRANSCRIPTION_API_KEY: 'a-key-that-is-never-used', FACE_FRAMING_ENABLED: 'false', TOOLCHAIN_REAL_SAMPLES: 'false' }, extra: { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } } });
  try {
    assert.equal((await server.studio.toolchain.run()).state, 'passed');
  } finally { await server.stop(); await dropSchema(schema); }
  const entry = lines.map((line) => JSON.parse(line) as { msg?: string; steps?: Array<{ name: string }> }).find((candidate) => candidate.msg?.startsWith('Toolchain check passed'));
  assert.deepEqual(entry?.steps?.map((step) => step.name), ['ffmpeg', 'ffprobe', 'encoders', 'filters', 'fonts', 'test-video', 'captions', 'whole-picture', 'moving-window', 'hdr-clip']);
});

test('the check does not run while a job is being processed, and runs as soon as the work is done', needsFfmpeg, async () => {
  const schema = schemaName('toolidle'); const looked: number[] = [];
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  const server = await start({ schema, transcriber: slowTalk, extra: { toolchainCheck: async () => { looked.push(Date.now()); return passedReport; }, toolchainRetryMs: 25 } });
  try {
    const { job } = await (await upload(server.base, '/api/jobs', await readFile(sampleVideo))).json() as { job: { id: string } };
    await eventually('the job to be running', () => server.studio.pipeline.activeJobCount, (count) => count > 0);
    const checking = server.studio.toolchain.run();
    await sleep(300);
    assert.equal(looked.length, 0, 'a check on top of a running job could use up the memory of a small server');
    assert.equal((await healthOf(server.base)).toolchain.state, 'pending');

    release();
    const finished = await waitForJob(server.base, job.id);
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    await untilSettled(server);
    assert.equal((await checking).state, 'passed');
    assert.equal(looked.length, 1, 'once, after the job');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the check holds a place for the heavy stages: a video uploaded while it runs waits for it and is worked on as soon as it is over', needsFfmpeg, async () => {
  const schema = schemaName('toolhold'); let began = false;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = await start({ schema, extra: { toolchainCheck: async () => { began = true; await gate; return passedReport; }, toolchainRetryMs: 25 } });
  try {
    const checking = server.studio.toolchain.run();
    await eventually('the check to begin', () => began, (value) => value);
    const { job } = await (await upload(server.base, '/api/jobs', await readFile(sampleVideo))).json() as { job: { id: string } };
    const viewOf = async () => (await (await fetch(`${server.base}/api/jobs/${job.id}`)).json() as JobView).job;
    await eventually('the job to say it is waiting for a place', viewOf, (seen) => seen.stage === 'waiting_for_capacity');
    await sleep(300);
    assert.equal((await viewOf()).status, 'queued', 'a video must not be worked on at the same time as the check: on a small server both together could use up the memory');
    assert.equal((await healthOf(server.base)).toolchain.state, 'running');
    release();
    const finished = await waitForJob(server.base, job.id);
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    assert.equal((await checking).state, 'passed');
    await untilSettled(server);
  } finally { release(); await server.stop(); await dropSchema(schema); }
});

test('the same video uploaded twice is listened to once, end to end, and TRANSCRIPT_CACHE_DAYS=0 switches that off', needsFfmpeg, async () => {
  const counting = (calls: { n: number }): TranscriptionEngine => ({ cacheKey: 'e2e-engine|1', transcribe: async (audioPath, workDir, onProgress) => { calls.n += 1; return talk.transcribe(audioPath, workDir, onProgress); } });
  for (const [days, listenedTo, kept] of [[undefined, 1, 1], ['0', 2, 0]] as const) {
    const schema = schemaName('cache_e2e'); const calls = { n: 0 };
    const server = await start({ schema, transcriber: counting(calls), env: days === undefined ? {} : { TRANSCRIPT_CACHE_DAYS: days } });
    const raw = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
    try {
      const first = await uploadAndFinish(server); await untilSettled(server);
      const second = await uploadAndFinish(server); await untilSettled(server);
      for (const finished of [first, second]) assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
      assert.equal(calls.n, listenedTo, days === undefined ? 'the second upload had the same sound: nobody listened again' : 'with the cache switched off the speech is listened to each time');
      assert.equal((await raw.query('SELECT count(*)::int AS n FROM transcript_cache')).rows[0].n, kept);
      assert.equal(second.clips.length, 1, 'the clip is made as usual');
      const page = await (await fetch(`${server.base}/jobs/${second.job.id}`)).text();
      assert.equal(page.includes('Reusing what was heard in this video before'), days === undefined, 'the job page says whether the speech was reused');
    } finally { await raw.end(); await server.stop(); await dropSchema(schema); }
  }
});

test('start-up forgets the transcripts nobody has needed for as many days as are set, and clears them all when the cache is switched off', async () => {
  const schema = schemaName('cache_prune');
  const raw = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
  try {
    const first = await start({ schema });
    try {
      const transcript = [{ segmentIndex: 0, startSeconds: 0, endSeconds: 1, text: 'Hello.' }];
      for (const sound of ['fresh', 'old']) await first.studio.db.storeCachedTranscript(sound, 'engine', transcript);
      await raw.query(`UPDATE transcript_cache SET last_used_at = $1 WHERE audio_sha256 = 'old'`, [new Date(Date.now() - 40 * 86_400_000).toISOString()]);
    } finally { await first.stop(); }

    const second = await start({ schema });
    try {
      const kept = () => raw.query('SELECT audio_sha256 FROM transcript_cache ORDER BY 1').then((result) => result.rows.map((row) => String(row.audio_sha256)));
      await eventually('the transcript nobody asked for in 40 days to be forgotten (30 are kept by default)', kept, (sounds) => sounds.join() === 'fresh');
    } finally { await second.stop(); }

    const third = await start({ schema, env: { TRANSCRIPT_CACHE_DAYS: '0' } });
    try {
      await eventually('switching the cache off to clear it', () => raw.query('SELECT count(*)::int AS n FROM transcript_cache').then((result) => result.rows[0].n as number), (count) => count === 0);
    } finally { await third.stop(); }
  } finally { await raw.end(); await dropSchema(schema); }
});

// ---- what a person is told when something goes wrong: words that were written to be read, never the inside of the server ------------------------

/** Something a server's own failure looks like: a program's name, a folder, an address with a password. */
const INSIDE = 'spawn /opt/render/project/src/.render/whisper-cli ENOENT; connect ECONNREFUSED 10.1.2.3:5432 postgres://user:hunter2@db.example.test/prod';
const nothingInside = (text: string, what: string) => assert.doesNotMatch(text, /\/opt\/|whisper-cli|ECONNREFUSED|10\.1\.2\.3|hunter2|postgres:|db\.example|ENOENT|moov atom|ffprobe|Command failed/i, `${what} must not show the inside of the server: ${text.slice(0, 300)}`);
const logLines = (lines: string[]) => lines.map((line) => JSON.parse(line) as { level: number; msg?: string; err?: { message?: string } });

test('a file that is not a video is refused in plain words by the form and by the API, and nothing is left behind', async () => {
  const schema = schemaName('notvideo'); const server = await start({ schema });
  try {
    const form = await upload(server.base, '/test-upload', Buffer.from('just some notes'), 'notes.txt');
    assert.equal(form.status, 400);
    const page = await form.text();
    assert.ok(page.includes(onlyVideos), 'the page says which files are taken');
    nothingInside(page, 'the page');

    const api = await upload(server.base, '/api/jobs', Buffer.from('just some notes'), 'notes.txt');
    assert.equal(api.status, 400);
    assert.deepEqual(((await api.json()) as { error: unknown }).error, { code: 'INVALID_UPLOAD', message: onlyVideos });
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), []);
    assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('when the server itself fails (here the database), the person is told in general words, by the form as a page and by the API as JSON, and the log has the real cause', async () => {
  const schema = schemaName('inside'); const lines: string[] = [];
  const server = await start({ schema, extra: { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } } });
  try {
    server.studio.db.createJob = async () => { throw new Error(INSIDE); };
    const api = await upload(server.base, '/api/jobs', await readFile(sampleVideo));
    assert.equal(api.status, 500);
    const body = await api.json() as { error: { code: string; message: string } };
    assert.deepEqual(body.error, { code: 'INTERNAL_ERROR', message: plainWords.server });
    nothingInside(JSON.stringify(body), 'the answer of the API');

    const form = await upload(server.base, '/test-upload', await readFile(sampleVideo));
    assert.equal(form.status, 500);
    assert.match(form.headers.get('content-type') ?? '', /text\/html/, 'a person at the form is shown a page');
    const page = await form.text();
    assert.ok(page.includes(plainWords.server) && page.includes('Upload failed'));
    nothingInside(page, 'the page');
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), [], 'the video that could not become a job is not kept');
    const real = logLines(lines).filter((entry) => entry.level === 50 && entry.err?.message?.includes('ECONNREFUSED'));
    assert.deepEqual(real.map((entry) => entry.msg).sort(), ['Request failed', 'Upload failed'], 'the log has what really happened, once for the call to the API and once for the form');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('a request the parser cannot read is a bad request in general words, and the words of the parser are not repeated', async () => {
  const schema = schemaName('badjson'); const server = await start({ schema, env: { COBALT_API_URL: 'http://127.0.0.1:9' } });
  try {
    const broken = await fetch(`${server.base}/api/youtube`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url": ' });
    assert.equal(broken.status, 400);
    assert.deepEqual(((await broken.json()) as { error: unknown }).error, { code: 'INVALID_REQUEST', message: 'The request could not be understood.' });
    const huge = await fetch(`${server.base}/api/youtube`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'x'.repeat(40_000) }) });
    assert.equal(huge.status, 413);
    assert.deepEqual(((await huge.json()) as { error: unknown }).error, { code: 'INVALID_REQUEST', message: 'The request is too large.' });
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the YouTube route says what is wrong with an address in plain words, passes on only a short reason from the download service, and keeps the rest to the log', async () => {
  const oddCodes: Record<string, unknown> = { longest: 'a'.repeat(80), toolong: 'a'.repeat(81), nothing: '', joined: 'rate_limit-exceeded.v2', numeric: 12345 };
  const cobalt = createServer((request, response) => {
    let body = ''; request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const asked = JSON.parse(body) as { url: string };
      response.setHeader('content-type', 'application/json');
      if (asked.url.includes('unavailable')) return void response.end(JSON.stringify({ status: 'error', error: { code: 'error.api.content.video.unavailable' } }));
      if (asked.url.includes('strange')) return void response.end(JSON.stringify({ status: 'error', error: { code: '<script>alert(1)</script> /srv/cobalt/secret' } }));
      for (const [word, code] of Object.entries(oddCodes)) if (asked.url.includes(word)) return void response.end(JSON.stringify({ status: 'error', error: { code } }));
      response.statusCode = 500; response.end(`internal failure at /srv/cobalt/app.js line 12 with key hunter2`);
    });
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => cobalt.once('listening', resolve));
  const schema = schemaName('youtube'); const lines: string[] = [];
  const server = await start({ schema, env: { COBALT_API_URL: `http://127.0.0.1:${(cobalt.address() as AddressInfo).port}` }, extra: { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } } });
  const ask = async (url: string) => { const response = await fetch(`${server.base}/api/youtube`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); return { status: response.status, error: ((await response.json()) as { error: { code: string; message: string } }).error }; };
  try {
    assert.deepEqual(await ask('https://example.com/watch?v=1'), { status: 400, error: { code: 'INVALID_YOUTUBE_URL', message: 'Only YouTube addresses are accepted.' } });
    assert.deepEqual(await ask('not an address'), { status: 400, error: { code: 'INVALID_YOUTUBE_URL', message: 'That is not a web address. Paste the address of a YouTube video.' } });
    assert.deepEqual(await ask('https://www.youtube.com/watch?v=unavailable'), { status: 502, error: { code: 'DOWNLOAD_FAILED', message: 'The video could not be downloaded from YouTube (the reason given: error.api.content.video.unavailable).' } });
    const strange = await ask('https://www.youtube.com/watch?v=strange');
    assert.deepEqual(strange, { status: 502, error: { code: 'DOWNLOAD_FAILED', message: 'The video could not be downloaded from YouTube (the reason given: unknown).' } }, 'a reason that is not a short code is not passed on');
    assert.ok(logLines(lines).some((entry) => entry.err?.message?.includes('Cobalt error: <script>alert(1)</script>')), 'the log has the whole of what the service gave, as what the failure was made from');
    const reasonFor = async (word: string) => (await ask(`https://www.youtube.com/watch?v=${word}`)).error.message.match(/\(the reason given: (.*)\)\.$/)?.[1];
    assert.equal(await reasonFor('longest'), 'a'.repeat(80), 'a code of the longest length that is passed on');
    assert.equal(await reasonFor('toolong'), 'unknown', 'one that is longer is not');
    assert.equal(await reasonFor('nothing'), 'unknown', 'an empty one is not');
    assert.equal(await reasonFor('numeric'), 'unknown', 'a number is not a code');
    assert.equal(await reasonFor('joined'), 'rate_limit-exceeded.v2', 'dots, hyphens and underscores belong to a code');
    const broken = await ask('https://www.youtube.com/watch?v=1');
    assert.deepEqual(broken, { status: 500, error: { code: 'INTERNAL_ERROR', message: plainWords.server } }, 'what the service answered with is not repeated');
    assert.ok(logLines(lines).some((entry) => entry.err?.message?.includes('Cobalt HTTP 500') && entry.err.message.includes('/srv/cobalt/app.js')), 'but the log has it');
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), []);
  } finally { await server.stop(); await dropSchema(schema); await new Promise<void>((resolve) => cobalt.close(() => resolve())); }
});

test('a video with no sound fails at once with words that say so, a file that is not a video says so too, and neither shows anything of the server', needsFfmpeg, async () => {
  const schema = schemaName('nosound'); let listened = 0;
  const server = await start({ schema, transcriber: { transcribe: async (audioPath, workDir) => { listened += 1; return talk.transcribe(audioPath, workDir); } } });
  try {
    const silent = await (await upload(server.base, '/api/jobs', await readFile(silentVideo))).json() as { job: { id: string } };
    const failed = await waitForJob(server.base, silent.job.id);
    assert.equal(failed.job.status, 'failed');
    assert.equal(failed.job.errorMessage, plainWords.noSound);
    assert.equal(listened, 0, 'nothing was listened to');
    const page = await (await fetch(`${server.base}/jobs/${silent.job.id}`)).text();
    assert.ok(page.includes('This video has no sound'), 'the page says it');
    nothingInside(page, 'the page of the job');

    const notVideo = await (await upload(server.base, '/api/jobs', Buffer.alloc(64 * 1024, 3))).json() as { job: { id: string } };
    const unreadable = await waitForJob(server.base, notVideo.job.id);
    assert.equal(unreadable.job.status, 'failed');
    assert.equal(unreadable.job.errorMessage, plainWords.unreadableVideo);
    nothingInside(await (await fetch(`${server.base}/jobs/${notVideo.job.id}`)).text(), 'the page of the job');
    nothingInside(JSON.stringify(unreadable), 'the answer of the API about the job');
    await untilSettled(server);
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), []);
    assert.equal((server.storage as MemoryStorage).objects.size, 0, 'and neither video is kept in storage');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('an upload that the upload library refuses for its shape is answered in the words of the app, never in the library\'s own', async () => {
  const schema = schemaName('shape'); const server = await start({ schema });
  try {
    const part = () => new Blob([new Uint8Array(Buffer.from('not a video, but that is not what is looked at here'))], { type: 'video/mp4' });
    const wrongField = () => { const form = new FormData(); form.append('movie', part(), 'match.mp4'); return form; };
    const twoVideos = () => { const form = new FormData(); form.append('video', part(), 'one.mp4'); form.append('video', part(), 'two.mp4'); return form; };
    const hugeValue = () => { const form = new FormData(); form.append('title', 'x'.repeat(1_100_000)); form.append('video', part(), 'match.mp4'); return form; };
    const cases: Array<[string, () => FormData, string]> = [
      ['a file in a field that is not \u201cvideo\u201d', wrongField, 'Attach one video file using the \u201cvideo\u201d field.'],
      ['two videos at once', twoVideos, 'Only one video can be uploaded at a time.'],
      ['a field with far more in it than any field has', hugeValue, 'The upload could not be understood.'],
    ];
    for (const [what, form, words] of cases) {
      const api = await fetch(`${server.base}/api/jobs`, { method: 'POST', body: form() });
      assert.equal(api.status, 400, what);
      assert.deepEqual(((await api.json()) as { error: unknown }).error, { code: 'INVALID_UPLOAD', message: words }, what);
      const page = await fetch(`${server.base}/test-upload`, { method: 'POST', body: form() });
      assert.equal(page.status, 400, what);
      const html = await page.text();
      assert.ok(html.includes(words), `${what}: the page says it`);
      assert.doesNotMatch(html, /Unexpected field|Too many files|Field value too long/, `${what}: the words of the library are not repeated`);
    }
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), []);
    assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('when the server cannot keep an upload (here its folder is gone), the person is told in general words with no folder in them, by the form and by the API, and the log has the real cause', async () => {
  const schema = schemaName('nofolder'); const lines: string[] = [];
  const server = await start({ schema, extra: { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } } });
  try {
    await rm(server.dirs.UPLOAD_DIR, { recursive: true, force: true });
    const bytes = Buffer.from('a video, as far as the server can tell');
    const api = await upload(server.base, '/api/jobs', bytes);
    assert.equal(api.status, 500);
    const body = await api.json() as { error: { code: string; message: string } };
    assert.deepEqual(body.error, { code: 'INTERNAL_ERROR', message: plainWords.server });
    nothingInside(JSON.stringify(body), 'the answer of the API');
    assert.ok(!JSON.stringify(body).includes(server.root), 'no folder of the server');

    const form = await upload(server.base, '/test-upload', bytes);
    assert.equal(form.status, 500);
    const page = await form.text();
    assert.ok(page.includes(plainWords.server) && page.includes('Upload failed'));
    nothingInside(page, 'the page');
    assert.ok(!page.includes(server.root), 'no folder of the server');
    const real = logLines(lines).filter((entry) => entry.level === 50 && entry.err?.message?.includes('ENOENT'));
    assert.deepEqual(real.map((entry) => entry.msg).sort(), ['Request failed', 'Upload failed'], 'the log has what really happened, once for the call to the API and once for the form');
    assert.equal((await server.studio.db.listUnfinishedJobs()).length, 0);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('an error that carries a status of its own is taken for a bad request only when that status is a client error, and what it says is never repeated', async () => {
  const schema = schemaName('statuses'); const server = await start({ schema });
  try {
    const ask = () => upload(server.base, '/api/jobs', Buffer.from('a video, as far as the server can tell'));
    for (const status of [399, 500, 503, '404']) {
      server.studio.db.createJob = async () => { throw Object.assign(new Error(INSIDE), { status }); };
      const answer = await ask();
      assert.equal(answer.status, 500, `an error with the status ${String(status)}`);
      assert.deepEqual(((await answer.json()) as { error: unknown }).error, { code: 'INTERNAL_ERROR', message: plainWords.server }, String(status));
    }
    server.studio.db.createJob = async () => { throw Object.assign(new Error(INSIDE), { status: 422 }); };
    const refused = await ask();
    assert.equal(refused.status, 422);
    assert.deepEqual(((await refused.json()) as { error: unknown }).error, { code: 'INVALID_REQUEST', message: 'The request could not be understood.' });
  } finally { await server.stop(); await dropSchema(schema); }
});

// ---- HDR video from phones -------------------------------------------------------------------------------------------------

type LogEntry = { level: number; msg?: string; jobId?: string; hdr?: string; coloursConverted?: boolean; toneMapping?: { works: boolean; detail: string }; toneMappingDecision?: { convert: boolean; why: string }; steps?: Array<{ name: string; ok: boolean; detail: string }> };
const readLog = (lines: string[]) => lines.map((line) => JSON.parse(line) as LogEntry);
const capturing = (lines: string[]) => ({ logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } });
const clipPicture = async (path: string) => (JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=profile,pix_fmt,width,height,color_space,color_transfer,color_primaries', '-of', 'json', path])).stdout) as { streams: Array<{ profile: string; pix_fmt: string; width: number; height: number; color_space?: string; color_transfer?: string; color_primaries?: string }> }).streams[0];

test('a video from an iPhone (ten bits, HDR) comes out of the whole service as a clip that plays everywhere: its colours are converted where this machine can and left as they were where it cannot, and the log says which', needsFfmpeg, async () => {
  const canConvert = (await probeToneMapping('ffmpeg')).works;
  const cases: Array<{ label: string; trial?: () => Promise<{ works: boolean; detail: string }>; converted: boolean }> = [
    { label: 'the start-up trial found that the machine cannot', trial: async () => ({ works: false, detail: 'tried, and it did not work' }), converted: false },
    { label: 'the machine is asked, as in production', converted: canConvert },
  ];
  for (const { label, trial, converted } of cases) {
    const schema = schemaName('hdr'); const lines: string[] = [];
    const server = await start({ schema, framer: null, extra: { ...capturing(lines), machine: plentyOfMemory, ...(trial ? { toneMapping: trial } : {}) } });
    try {
      const response = await upload(server.base, '/api/jobs', await readFile(hdrVideo), 'iphone.mkv');
      assert.equal(response.status, 202, label);
      const { job } = await response.json() as { job: { id: string } };
      const finished = await waitForJob(server.base, job.id);
      assert.equal(finished.job.status, 'completed', `${label}: ${finished.job.errorMessage ?? ''}`);
      await untilSettled(server);
      assert.equal(finished.clips.length, 1);

      const clipFile = join(workspace, `${finished.clips[0].id}-hdr.mp4`);
      await writeFile(clipFile, (server.storage as MemoryStorage).objects.get(finished.clips[0].outputPath)!);
      const picture = await clipPicture(clipFile);
      assert.deepEqual({ width: picture.width, height: picture.height, pixels: picture.pix_fmt }, { width: 360, height: 640, pixels: 'yuv420p' }, `${label}: a vertical clip of 8-bit pixels, not "${picture.profile}" of ten bits`);
      assert.ok(['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(picture.profile), `${label}: a profile that plays everywhere, not ${picture.profile}`);
      if (converted) assert.deepEqual([picture.color_primaries, picture.color_transfer, picture.color_space], ['bt709', 'bt709', 'bt709'], `${label}: the colours of an ordinary video`);
      else assert.equal(picture.color_transfer, 'arib-std-b67', `${label}: the clip says what it still is (HLG) instead of claiming colours it was not converted to`);

      const log = readLog(lines);
      const done = log.find((entry) => entry.msg?.startsWith('Video processing') && entry.jobId === job.id);
      assert.ok(done, `${label}: the job's end is in the log`);
      assert.equal(done.hdr, 'hlg', `${label}: the log says the video was HDR`);
      assert.equal(done.coloursConverted, converted, `${label}: and whether its colours were converted`);
      const warned = log.find((entry) => entry.level === 40 && /^This video is HDR but its colours could not be converted/.test(entry.msg ?? ''));
      assert.equal(warned !== undefined, !converted, `${label}: a warning exactly when the colours were not converted`);
      assert.equal(JSON.stringify(finished.job).includes('hlg'), false, `${label}: the kind of HDR is for the log, not for the job a person is shown`);
    } finally { await server.stop(); await dropSchema(schema); }
  }
});

test('at start-up the server tries converting HDR colours once and says what it found, and hands that to its own check of the clips', needsFfmpeg, async () => {
  const canConvert = (await probeToneMapping('ffmpeg')).works;
  const env = { TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example.test/v1', TRANSCRIPTION_API_KEY: 'a-key-that-is-never-used', FACE_FRAMING_ENABLED: 'false', TOOLCHAIN_REAL_SAMPLES: 'false' };
  const boot = async (label: string, settings: { env?: Record<string, string>; trial?: () => Promise<{ works: boolean; detail: string }>; machine?: () => Promise<MachineLimits> }) => {
    const schema = schemaName('hdrboot'); const lines: string[] = [];
    const server = await start({ schema, env: { ...env, ...settings.env }, extra: { ...capturing(lines), machine: settings.machine ?? plentyOfMemory, ...(settings.trial ? { toneMapping: settings.trial } : {}) } });
    try { await server.studio.toolchain.run(); } finally { await server.stop(); await dropSchema(schema); }
    const log = readLog(lines);
    return { label, log, line: log.find((entry) => entry.msg?.startsWith('HDR video:')), step: log.find((entry) => entry.msg?.startsWith('Toolchain check'))?.steps?.find((step) => step.name === 'hdr-clip') };
  };

  const no = await boot('trial: no', { trial: async () => ({ works: false, detail: 'No such filter: zscale' }) });
  assert.equal(no.line?.level, 40, 'a machine that cannot is a warning: its HDR clips look flat');
  assert.equal(no.line?.msg, 'HDR video: this FFmpeg cannot convert its colours (No such filter: zscale). Clips from HDR video are made as ordinary 8-bit pictures that play everywhere, but their colours look flat');
  assert.deepEqual(no.line?.toneMapping, { works: false, detail: 'No such filter: zscale' });
  assert.equal(no.step?.ok, true, 'and the check of the clips passes: they are still clips that play');
  assert.equal(no.step?.detail, 'a ten-bit HDR picture became an ordinary 8-bit clip; its colours were not converted (switched off, left off for want of memory, or this FFmpeg cannot)');

  const thrown = await boot('trial: throws', { trial: async () => { throw new Error('the trial itself broke'); } });
  assert.equal(thrown.line?.level, 40);
  assert.match(thrown.line?.msg ?? '', /this FFmpeg cannot convert its colours \(the trial itself broke\)/, 'a trial that blows up is a machine that cannot, never a server that does not start');

  let asked = 0;
  const off = await boot('switched off', { env: { CLIP_TONE_MAP_HDR: 'false' }, trial: async () => { asked += 1; return { works: true, detail: 'yes' }; } });
  assert.equal(asked, 0, 'switched off, the machine is not even asked');
  assert.equal(off.line?.level, 30);
  assert.equal(off.line?.msg, 'HDR video: converting its colours is switched off (CLIP_TONE_MAP_HDR). Clips from HDR video are made as ordinary 8-bit pictures that play everywhere, but their colours look flat');
  assert.match(off.step?.detail ?? '', /not converted \(switched off, left off for want of memory, or this FFmpeg cannot\)$/, 'and the check does not expect a conversion either');

  // By default (nothing set) the machine's memory decides: the free instance (512 MiB, a limit of its container below the 8 GiB of the host) is not asked.
  const counting = async () => { asked += 1; return { works: true, detail: 'yes' }; };
  asked = 0;
  const tight = await boot('automatic, 512 MiB', { machine: smallInstance, trial: counting });
  assert.equal(asked, 0, 'a machine with 512 MiB of memory is not even asked: the limit of its container counts, not the memory of the host');
  assert.equal(tight.line?.level, 30);
  assert.equal(tight.line?.msg, 'HDR video: converting its colours is left off on this machine, which has 512 MiB of memory: it needs about 90 MiB more for every clip (CLIP_TONE_MAP_HDR=true converts them anyway). Clips from HDR video are made as ordinary 8-bit pictures that play everywhere, but their colours look flat');
  assert.equal(tight.line?.toneMappingDecision?.convert, false);
  assert.match(tight.step?.detail ?? '', /not converted \(switched off, left off for want of memory, or this FFmpeg cannot\)$/, 'and the check does not expect a conversion either');
  const noLimitSmall = await boot('automatic, no limit but a small host', { machine: async () => ({ cpuLimit: null, memoryLimitBytes: null, cores: 2, totalMemoryBytes: 768 * MEBIBYTE }), trial: counting });
  assert.equal(asked, 0, 'with no limit of the container the memory of the machine is what counts');
  assert.match(noLimitSmall.line?.msg ?? '', /which has 768 MiB of memory/);
  const withRoom = await boot('automatic, 2 GiB', { machine: async () => ({ cpuLimit: 1, memoryLimitBytes: 2048 * MEBIBYTE, cores: 2, totalMemoryBytes: 8192 * MEBIBYTE }), trial: counting });
  assert.equal(asked, 1, 'with 2 GiB it is asked');
  assert.equal(withRoom.line?.msg, 'HDR video: its colours are converted to those of an ordinary picture (yes)');
  const unreadableMachine = await boot('automatic, memory unknown', { machine: async () => { throw new Error('the control group files cannot be read here'); }, trial: counting });
  assert.equal(asked, 2, 'a machine whose memory cannot be read is not taken for a small one');
  assert.equal(unreadableMachine.line?.msg, 'HDR video: its colours are converted to those of an ordinary picture (yes)');
  const forced = await boot('asked for, 512 MiB', { env: { CLIP_TONE_MAP_HDR: 'true' }, machine: smallInstance, trial: counting });
  assert.equal(asked, 3, 'asked for, a small machine converts all the same');
  assert.equal(forced.line?.msg, 'HDR video: its colours are converted to those of an ordinary picture (yes)');
  asked = 0;

  const yes = await boot('trial: yes', { trial: async () => ({ works: true, detail: 'a test HLG picture was converted in 3 ms' }) });
  assert.equal(yes.line?.level, 30);
  assert.equal(yes.line?.msg, 'HDR video: its colours are converted to those of an ordinary picture (a test HLG picture was converted in 3 ms)');
  if (canConvert) {
    assert.equal(yes.step?.ok, true, JSON.stringify(yes.log.filter((entry) => entry.level >= 40)));
    assert.match(yes.step?.detail ?? '', /\(bt709\)$/, 'when the trial says the colours are converted, the check of the clips expects the clip to say so, and it does');
  } else assert.equal(yes.step?.ok, false, 'a trial that promises what this FFmpeg cannot do is found out by the check of the clips');

  const real = await boot('as in production', {});
  assert.ok(real.line, 'with nothing set the machine is asked, and the log says what it found');
  assert.equal(real.line?.level, canConvert ? 30 : 40);
  assert.equal(real.line?.toneMapping?.works, canConvert);
  assert.equal(real.log.filter((entry) => entry.msg?.startsWith('HDR video:')).length, 1, 'once');
});

// ---- Deleting a job, and how long clips are kept ---------------------------------------------------------------------------------

/** A job made directly in the database and in storage, with no video processed: what the routes that delete act on. It is made as new (its row and its clips together, so that nothing sees it half made) and then given its age. */
async function makeJobToDelete(server: RunningServer, schema: string, options: { status?: 'completed' | 'failed' | 'processing' | 'queued'; ageDays?: number; clipCount?: number } = {}) {
  const id = randomUUID(); const status = options.status ?? 'completed'; const stamp = new Date().toISOString();
  await server.studio.db.createJob({ id, originalFilename: 'match.mp4', storedFilename: `${randomUUID()}.mp4`, mimeType: 'video/mp4', sizeBytes: 1, status, stage: status, errorMessage: status === 'failed' ? 'This video has no sound.' : null, durationSeconds: 8, width: 320, height: 240, createdAt: stamp, updatedAt: stamp });
  const keys: string[] = [];
  for (let index = 0; index < (options.clipCount ?? 1); index += 1) {
    const clipId = randomUUID();
    await server.studio.db.createClip({ id: clipId, jobId: id, candidateId: 'c', startSeconds: 0, endSeconds: 5, durationSeconds: 5, outputPath: `${id}/${clipId}.mp4`, outputFilename: `${clipId}.mp4`, status: 'completed', errorMessage: null, captionPath: null, createdAt: stamp, updatedAt: stamp, title: 'A clip', score: null, reasons: [], framing: null });
    for (const key of [`${id}/${clipId}.mp4`, `${id}/${clipId}.srt`]) { (server.storage as MemoryStorage).objects.set(key, Buffer.from('stored')); keys.push(key); }
  }
  if (options.ageDays) await admin.query(`UPDATE "${schema}".video_jobs SET updated_at = $1 WHERE id = $2`, [new Date(Date.now() - options.ageDays * 86_400_000).toISOString(), id]);
  return { id, keys };
}
/** Servers that have jobs not yet over must not have them taken over by the check for abandoned jobs while a test is looking. */
const patient = { JOB_STALE_AFTER_SECONDS: '600' };
const stillStored = (server: RunningServer, keys: string[]) => keys.filter((key) => (server.storage as MemoryStorage).objects.has(key));

test('the API deletes a job that is over together with its clips, and says why it cannot delete one that is still being worked on, one that is not there, or one whose files storage will not delete', async () => {
  const schema = schemaName('delete_api'); const server = await start({ schema, env: patient });
  try {
    const done = await makeJobToDelete(server, schema, { clipCount: 2 }); const other = await makeJobToDelete(server, schema);
    const deleted = await fetch(`${server.base}/api/jobs/${done.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '', 'nothing is said when it is done');
    assert.deepEqual(stillStored(server, done.keys), [], 'every file of the job is gone from storage');
    const gone = await fetch(`${server.base}/api/jobs/${done.id}`);
    assert.equal(gone.status, 404);
    assert.equal(((await gone.json()) as { error: { code: string } }).error.code, 'JOB_NOT_FOUND');
    assert.equal((await fetch(`${server.base}/api/jobs/${done.id}/transcript`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/jobs/${other.id}`)).status, 200, 'another job is not touched');
    assert.deepEqual(stillStored(server, other.keys), other.keys);

    const again = await fetch(`${server.base}/api/jobs/${done.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404, 'a job that is gone cannot be deleted again');
    assert.deepEqual(((await again.json()) as { error: unknown }).error, { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' });
    assert.equal((await fetch(`${server.base}/api/jobs/${randomUUID()}`, { method: 'DELETE' })).status, 404);

    for (const status of ['queued', 'processing'] as const) {
      const running = await makeJobToDelete(server, schema, { status });
      const refused = await fetch(`${server.base}/api/jobs/${running.id}`, { method: 'DELETE' });
      assert.equal(refused.status, 409, status);
      assert.deepEqual(((await refused.json()) as { error: unknown }).error, { code: 'JOB_NOT_FINISHED', message: 'This video is still being processed. It can be deleted once it is finished, or once you have stopped it.' }, status);
      assert.equal((await fetch(`${server.base}/api/jobs/${running.id}`)).status, 200, `${status}: still there`);
      assert.deepEqual(stillStored(server, running.keys), running.keys, `${status}: and so are its files`);
    }

    const stuck = await makeJobToDelete(server, schema); const memory = server.storage as MemoryStorage;
    memory.failDeletes = true;
    const failed = await fetch(`${server.base}/api/jobs/${stuck.id}`, { method: 'DELETE' });
    assert.equal(failed.status, 503);
    const body = await failed.json() as { error: { code: string; message: string } };
    assert.deepEqual(body.error, { code: 'DELETE_FAILED', message: 'The files of this video could not be deleted right now, and nothing was removed. Please try again in a moment.' });
    assert.ok(!JSON.stringify(body).includes('simulated storage outage'), 'what storage said stays in the log');
    assert.equal((await fetch(`${server.base}/api/jobs/${stuck.id}`)).status, 200, 'the job is still there to be deleted again');
    memory.failDeletes = false;
    assert.equal((await fetch(`${server.base}/api/jobs/${stuck.id}`, { method: 'DELETE' })).status, 204, 'and it is, once storage works');
    assert.deepEqual(stillStored(server, stuck.keys), []);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the pages offer deleting only for a job that is over, ask once more first, and do it with a plain form, with no JavaScript', async () => {
  const schema = schemaName('delete_pages'); const server = await start({ schema, env: patient });
  try {
    const done = await makeJobToDelete(server, schema); const failed = await makeJobToDelete(server, schema, { status: 'failed', clipCount: 0 }); const running = await makeJobToDelete(server, schema, { status: 'processing' });
    const page = (path: string) => fetch(`${server.base}${path}`);

    const finishedPage = await (await page(`/jobs/${done.id}`)).text();
    assert.match(finishedPage, new RegExp(`<a class="btn danger" href="/jobs/${done.id}/delete">Delete this video and its clips</a>`), 'a finished job has a way to delete it');
    assert.match(await (await page(`/jobs/${failed.id}`)).text(), new RegExp(`href="/jobs/${failed.id}/delete">Delete this job</a>`), 'so has one that failed, in words that do not speak of clips');
    assert.doesNotMatch(await (await page(`/jobs/${running.id}`)).text(), /\/delete|Delete this/, 'a job that is still being worked on has none');

    const ask = await page(`/jobs/${done.id}/delete`);
    assert.equal(ask.status, 200);
    const asking = await ask.text();
    assert.match(asking, /<h1>Delete this video\?<\/h1>/);
    assert.match(asking, new RegExp(`<form method="post" action="/jobs/${done.id}/delete"><button type="submit" class="danger">Yes, delete it for good</button></form>`));
    assert.match(asking, new RegExp(`<a href="/jobs/${done.id}">No, keep it</a>`));
    assert.match(asking, /cannot be undone/);
    assert.doesNotMatch(asking, /<script/i, 'the pages have no JavaScript at all');
    assert.deepEqual(stillStored(server, done.keys), done.keys, 'asking deletes nothing');
    assert.equal((await fetch(`${server.base}/api/jobs/${done.id}`)).status, 200);

    const notYet = await page(`/jobs/${running.id}/delete`);
    assert.equal(notYet.status, 409);
    assert.match(await notYet.text(), /still being processed[\s\S]*Back to the video/);
    const nobody = await page(`/jobs/${randomUUID()}/delete`);
    assert.equal(nobody.status, 404);
    assert.match(await nobody.text(), /No job exists for this id\./);

    const doIt = await fetch(`${server.base}/jobs/${done.id}/delete`, { method: 'POST' });
    assert.equal(doIt.status, 200);
    const result = await doIt.text();
    assert.match(result, /<h1>Deleted<\/h1>[\s\S]*were deleted\.[\s\S]*Upload another video/);
    assert.doesNotMatch(result, /class="card error"/, 'it is not shown as an error');
    assert.deepEqual(stillStored(server, done.keys), []);
    assert.equal((await page(`/jobs/${done.id}`)).status, 404, 'the page of a deleted job is the page of a job that is not there');
    assert.equal((await fetch(`${server.base}/jobs/${done.id}/delete`, { method: 'POST' })).status, 404, 'and deleting it again finds nothing');

    const refused = await fetch(`${server.base}/jobs/${running.id}/delete`, { method: 'POST' });
    assert.equal(refused.status, 409);
    assert.equal((await fetch(`${server.base}/api/jobs/${running.id}`)).status, 200, 'a job that is still being worked on is not deleted by a form either');

    const memory = server.storage as MemoryStorage; memory.failDeletes = true;
    const stuck = await fetch(`${server.base}/jobs/${failed.id}/delete`, { method: 'POST' });
    assert.equal(stuck.status, 503);
    const stuckPage = await stuck.text();
    assert.match(stuckPage, /could not be deleted right now[\s\S]*Back to the video/);
    assert.ok(!stuckPage.includes('simulated storage outage'));
    memory.failDeletes = false;
    assert.equal((await fetch(`${server.base}/jobs/${failed.id}/delete`, { method: 'POST' })).status, 200);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('what is said about how long clips are kept: nothing unless CLIP_RETENTION_DAYS is set, and then the upload page, the job page and the page of a job that is gone say it', async () => {
  const keptSentence = /Clips are deleted 14 days after they are made\./;
  for (const days of [undefined, '14'] as const) {
    const schema = schemaName('retention_pages'); const server = await start({ schema, env: days ? { CLIP_RETENTION_DAYS: days } : {} });
    try {
      const done = await makeJobToDelete(server, schema, { ageDays: 3 }); const failed = await makeJobToDelete(server, schema, { status: 'failed', clipCount: 0 });
      const upload = await (await fetch(`${server.base}/test-upload`)).text();
      const job = await (await fetch(`${server.base}/jobs/${done.id}`)).text();
      const jobFailed = await (await fetch(`${server.base}/jobs/${failed.id}`)).text();
      const missing = await (await fetch(`${server.base}/jobs/${randomUUID()}`)).text();
      if (!days) {
        for (const html of [upload, job, jobFailed, missing]) assert.doesNotMatch(html, /Clips are deleted|are kept until/, 'with clips kept until they are deleted, nothing is promised');
        continue;
      }
      assert.match(upload, /<p class="notice">Clips are deleted 14 days after they are made\. Download the clips you want to keep\.<\/p>/);
      const until = new Date(Date.now() - 3 * 86_400_000 + 14 * 86_400_000).toISOString().slice(0, 10);
      assert.match(job, keptSentence);
      assert.ok(job.includes(`These are kept until ${until}.`), `the day is counted from when the job finished (${until})`);
      assert.doesNotMatch(jobFailed, /These are kept until/, 'a job that made no clips has none to keep');
      assert.match(missing, /No job exists for this id\. Clips are deleted 14 days after they are made\./, 'a job that is not there may be one that was deleted by the clock, and the page says so');
    } finally { await server.stop(); await dropSchema(schema); }
  }
});

test('with CLIP_RETENTION_DAYS the server itself deletes the jobs that are older than that, with their clips, and keeps the others; the log says what is kept at start-up', async () => {
  const schema = schemaName('retention_e2e'); const lines: string[] = [];
  const server = await start({ schema, env: { CLIP_RETENTION_DAYS: '7', ...patient }, extra: { ...capturing(lines), retention: { firstSweepMs: 20, intervalMs: 60 } } });
  try {
    const kept = readLog(lines).find((entry) => entry.msg?.startsWith('Clips are deleted 7 days after'));
    assert.ok(kept, 'the log says how long clips are kept');
    const old = await makeJobToDelete(server, schema, { ageDays: 10, clipCount: 2 }); const young = await makeJobToDelete(server, schema, { ageDays: 6 });
    const running = await makeJobToDelete(server, schema, { status: 'processing', ageDays: 20 });
    await eventually('the job that is ten days old to be deleted by the server itself', async () => (await fetch(`${server.base}/api/jobs/${old.id}`)).status, (status) => status === 404);
    assert.deepEqual(stillStored(server, old.keys), [], 'with its clips');
    await sleep(200);
    assert.equal((await fetch(`${server.base}/api/jobs/${young.id}`)).status, 200, 'six days is not older than seven');
    assert.deepEqual(stillStored(server, young.keys), young.keys);
    assert.equal((await fetch(`${server.base}/api/jobs/${running.id}`)).status, 200, 'a job that is still being worked on is never deleted by the clock, however long ago it began');
    const told = readLog(lines).find((entry) => entry.msg === 'Deleted the clips that are older than they are kept');
    assert.ok(told, 'and what was deleted is in the log');
  } finally { await server.stop(); await dropSchema(schema); }

  const quietSchema = schemaName('retention_off'); const quietLines: string[] = [];
  const quiet = await start({ schema: quietSchema, extra: { ...capturing(quietLines), retention: { firstSweepMs: 20, intervalMs: 30 } } });
  try {
    const ancient = await makeJobToDelete(quiet, quietSchema, { ageDays: 4000 });
    await sleep(200);
    assert.equal((await fetch(`${quiet.base}/api/jobs/${ancient.id}`)).status, 200, 'by default nothing is ever deleted by the clock');
    assert.ok(readLog(quietLines).some((entry) => entry.msg === 'Clips are kept until a person deletes them (CLIP_RETENTION_DAYS is 0)'));
  } finally { await quiet.stop(); await dropSchema(quietSchema); }
});

test('with no durable storage (local-only mode) deleting a finished job removes its clips and its video from the server\'s own disk, and nothing of any other job', needsFfmpeg, async () => {
  const schema = schemaName('delete_local'); const server = await start({ schema, storage: new NullStorage() });
  try {
    const first = await uploadAndFinish(server); await untilSettled(server);
    const second = await uploadAndFinish(server); await untilSettled(server);
    assert.equal(first.job.status, 'completed', first.job.errorMessage ?? '');
    assert.equal(second.job.status, 'completed', second.job.errorMessage ?? '');
    const outputs = async () => (await readdir(server.dirs.OUTPUT_DIR)).sort();
    const uploads = async () => (await readdir(server.dirs.UPLOAD_DIR)).sort();
    assert.deepEqual(await outputs(), [first.job.id, second.job.id].sort(), 'the clips are on the server\'s own disk, a folder for each job');
    const videosBefore = await uploads();

    assert.equal((await fetch(`${server.base}/api/jobs/${first.job.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await outputs(), [second.job.id], 'the clips of the job are gone from the disk, and the other job keeps its own');
    assert.equal((await fetch(`${server.base}/api/jobs/${first.job.id}/clips/${first.clips[0].id}`, { redirect: 'manual' })).status, 404, 'a clip that was deleted cannot be fetched');
    assert.equal((await fetch(`${server.base}/api/jobs/${second.job.id}/clips/${second.clips[0].id}`, { redirect: 'manual' })).status, 200, 'and the other job\'s clips still play');
    assert.equal((await uploads()).length, videosBefore.length - 1, 'the video that was uploaded for the job went with it, the other one stays');
    assert.equal((await fetch(`${server.base}/api/jobs/${second.job.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await outputs(), [], 'nothing of either job is left');
    assert.deepEqual(await uploads(), [], 'neither is the video of either');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the log says that a person asked for a deletion, whether through the API or through the page, and which job it was', async () => {
  const schema = schemaName('delete_log'); const lines: string[] = [];
  const server = await start({ schema, env: patient, extra: { ...capturing(lines) } });
  try {
    const viaApi = await makeJobToDelete(server, schema, { clipCount: 1 }); const viaPage = await makeJobToDelete(server, schema, { clipCount: 1 });
    assert.equal((await fetch(`${server.base}/api/jobs/${viaApi.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${server.base}/jobs/${viaPage.id}/delete`, { method: 'POST' })).status, 200);
    const told = readLog(lines).filter((entry) => entry.msg?.startsWith('Deleted a job'));
    assert.deepEqual(told.map((entry) => entry.msg), ['Deleted a job at the request of the person who made it', 'Deleted a job at the request of the person who made it']);
    assert.deepEqual(told.map((entry) => (entry as unknown as { jobId: string }).jobId), [viaApi.id, viaPage.id]);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('stopping the server stops the look for old jobs: a look that was about to happen does not happen once the server is stopped', async () => {
  const schema = schemaName('retention_stop');
  const server = await start({ schema, env: { CLIP_RETENTION_DAYS: '7', ...patient }, extra: { retention: { firstSweepMs: 150, intervalMs: 150 } } });
  let looks = 0;
  server.studio.retention.sweep = async () => { looks += 1; return { erased: 0, failed: 0 }; };
  try { await server.stop(); await sleep(450); } finally { await dropSchema(schema); }
  assert.equal(looks, 0, 'the database is closed by then: nothing may look into it any more');
});

test('deleting needs the access code like everything else, and with the code it works', async () => {
  const schema = schemaName('delete_gate'); const server = await start({ schema, env: { ...gated, ...patient }, extra: noDelay });
  try {
    const job = await makeJobToDelete(server, schema);
    const without = await fetch(`${server.base}/api/jobs/${job.id}`, { method: 'DELETE' });
    assert.equal(without.status, 401);
    assert.equal(((await without.json()) as { error: { code: string } }).error.code, 'ACCESS_CODE_REQUIRED');
    assert.equal((await fetch(`${server.base}/jobs/${job.id}/delete`, manual())).status, 302, 'the page that asks is behind the way in');
    assert.equal((await fetch(`${server.base}/jobs/${job.id}/delete`, { method: 'POST' })).status, 401);
    assert.deepEqual(stillStored(server, job.keys), job.keys, 'nothing was deleted for someone without the code');
    assert.equal((await fetch(`${server.base}/api/jobs/${job.id}`, { headers: { 'x-access-code': ACCESS_CODE } })).status, 200);
    const refused = await fetch(`${server.base}/api/jobs/${job.id}`, { method: 'DELETE', headers: { 'x-access-code': 'not-the-code-1' } });
    assert.equal(refused.status, 401);
    const allowed = await fetch(`${server.base}/api/jobs/${job.id}`, { method: 'DELETE', headers: { 'x-access-code': ACCESS_CODE } });
    assert.equal(allowed.status, 204);
    assert.deepEqual(stillStored(server, job.keys), []);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('a real upload, once it is done, can be deleted: every file the pipeline stored for it, its transcript, and the transcript kept from its sound are gone', needsFfmpeg, async () => {
  const schema = schemaName('delete_real'); const raw = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
  const server = await start({ schema, transcriber: { cacheKey: 'e2e-engine|1', transcribe: (audioPath, workDir, onProgress) => talk.transcribe(audioPath, workDir, onProgress) } });
  try {
    const finished = await uploadAndFinish(server); await untilSettled(server);
    assert.equal(finished.job.status, 'completed', finished.job.errorMessage ?? '');
    const id = finished.job.id; const memory = server.storage as MemoryStorage;
    assert.ok([...memory.objects.keys()].some((key) => key.startsWith(`${id}/`)), 'the clips are in storage');
    assert.equal((await raw.query('SELECT count(*)::int AS n FROM transcript_cache')).rows[0].n, 1, 'the transcript is kept for the next time this sound comes');
    assert.equal((await raw.query('SELECT audio_sha256 FROM video_jobs WHERE id = $1', [id])).rows[0].audio_sha256?.length, 64, 'and the job noted which sound that was');
    const other = await makeJobToDelete(server, schema);

    const gone = await fetch(`${server.base}/api/jobs/${id}`, { method: 'DELETE' });
    assert.equal(gone.status, 204);
    assert.deepEqual([...memory.objects.keys()].filter((key) => key.includes(id)), [], 'not one object of the job is left in storage, under the job or under sources/');
    assert.deepEqual((await raw.query('SELECT (SELECT count(*)::int FROM video_jobs WHERE id = $1) AS jobs, (SELECT count(*)::int FROM generated_clips WHERE job_id = $1) AS clips, (SELECT count(*)::int FROM transcript_segments WHERE job_id = $1) AS segments, (SELECT count(*)::int FROM highlight_candidates WHERE job_id = $1) AS candidates, (SELECT count(*)::int FROM transcript_cache) AS cached', [id])).rows[0], { jobs: 0, clips: 0, segments: 0, candidates: 0, cached: 0 });
    assert.equal((await readdir(server.dirs.OUTPUT_DIR)).includes(id), false);
    assert.deepEqual(stillStored(server, other.keys), other.keys, 'what belongs to other jobs stays');
    assert.equal((await fetch(`${server.base}/api/jobs/${id}/clips/${finished.clips[0].id}`, { redirect: 'manual' })).status, 404, 'and a clip that was deleted cannot be fetched');
  } finally { await raw.end(); await server.stop(); await dropSchema(schema); }
});

// ---- Stopping a video ------------------------------------------------------------------------------------------------------------

/** A speech engine that never ends by itself and ends when its job is stopped, like the real program does (it is killed); `gate` makes it take its time over that, like a program that needs a moment to die. */
function slowToStop(gate: Promise<void> = Promise.resolve()) {
  const state = { listening: false };
  const engine: TranscriptionEngine = { transcribe: (_audio, _dir, _progress, signal) => new Promise<never>((_resolve, reject) => {
    state.listening = true;
    signal?.addEventListener('abort', () => { void gate.then(() => reject(signal?.reason)); }, { once: true });
  }) };
  return { engine, state };
}
const uploadSample = async (server: RunningServer, headers: Record<string, string> = {}) => {
  const form = new FormData();
  form.append('video', new Blob([new Uint8Array(await readFile(sampleVideo))], { type: 'video/mp4' }), 'match.mp4');
  const response = await fetch(`${server.base}/api/jobs`, { method: 'POST', body: form, headers });
  assert.equal(response.status, 202);
  return ((await response.json()) as { job: { id: string } }).job.id;
};
const askToStop = (server: RunningServer, id: string, headers: Record<string, string> = {}) => fetch(`${server.base}/api/jobs/${id}/stop`, { method: 'POST', headers });
const errorOf = async (response: Response) => ((await response.json()) as { error: unknown }).error;
const toldAsStopped = 'Video processing was stopped by the person who uploaded it';

test('the API stops a video that is being worked on: it answers at once, the job ends as stopped with nothing kept and nothing logged as an error, and it says why it cannot stop a video that is over, one that is not there, or one that nobody here is working on', needsFfmpeg, async () => {
  const schema = schemaName('stop_api'); const lines: string[] = []; const { engine, state } = slowToStop();
  const server = await start({ schema, transcriber: engine, env: patient, extra: capturing(lines) });
  try {
    const id = await uploadSample(server);
    await eventually('the speech to be listened to', () => state.listening, (listening) => listening);
    const stopping = await askToStop(server, id);
    assert.equal(stopping.status, 202);
    assert.deepEqual(await stopping.json(), { stopping: true });
    const view = await waitForJob(server.base, id); await untilSettled(server);
    assert.deepEqual({ status: view.job.status, stage: view.job.stage, errorMessage: view.job.errorMessage }, { status: 'failed', stage: 'stopped', errorMessage: plainWords.stopped });
    assert.deepEqual(view.clips, []);
    assert.deepEqual([...(server.storage as MemoryStorage).objects.keys()], [], 'nothing of the video is kept in storage');
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), [], 'the video is not kept on the server');
    assert.ok(!(await readdir(server.dirs.OUTPUT_DIR)).includes(id), 'no clips are kept on the server');
    const entries = readLog(lines);
    assert.deepEqual(entries.filter((entry) => entry.jobId === id && entry.level >= 50).map((entry) => entry.msg), [], 'a stop is not an error');
    assert.ok(entries.some((entry) => entry.msg === toldAsStopped && entry.jobId === id && entry.level === 30), 'it is told as information');

    const again = await askToStop(server, id);
    assert.equal(again.status, 409);
    assert.deepEqual(await errorOf(again), { code: 'JOB_ALREADY_OVER', message: 'This video is already finished, so there is nothing to stop.' });
    const nobody = await askToStop(server, randomUUID());
    assert.equal(nobody.status, 404);
    assert.deepEqual(await errorOf(nobody), { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' });
    const elsewhere = await makeJobToDelete(server, schema, { status: 'processing' });
    const notHere = await askToStop(server, elsewhere.id);
    assert.equal(notHere.status, 409);
    assert.deepEqual(await errorOf(notHere), { code: 'JOB_NOT_RUNNING', message: 'This video is not being worked on at this moment (it may be waiting to start again after a restart). Try again in a minute.' });
    assert.equal(((await (await fetch(`${server.base}/api/jobs/${elsewhere.id}`)).json()) as JobView).job.status, 'processing', 'a video that nobody here works on is left as it was');
    assert.deepEqual(stillStored(server, elsewhere.keys), elsewhere.keys);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('the pages let a person stop a video: a link, a page that asks, a plain form, a page that says it is being stopped, and then one that says they stopped it', needsFfmpeg, async () => {
  const schema = schemaName('stop_pages'); let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
  const { engine, state } = slowToStop(gate);
  const server = await start({ schema, transcriber: engine, env: patient });
  const page = (path: string) => fetch(`${server.base}${path}`);
  const form = (path: string) => fetch(`${server.base}${path}`, { method: 'POST', redirect: 'manual' });
  try {
    const id = await uploadSample(server);
    await eventually('the speech to be listened to', () => state.listening, (listening) => listening);
    const running = await (await page(`/jobs/${id}`)).text();
    assert.match(running, new RegExp(`<a class="btn danger" href="/jobs/${id}/stop">Stop this video</a>`), 'a video that is being worked on has a way to stop it');
    assert.doesNotMatch(running, /\/delete/, 'and none to delete it');

    const ask = await page(`/jobs/${id}/stop`);
    assert.equal(ask.status, 200);
    const asking = await ask.text();
    assert.match(asking, /<h1>Stop this video\?<\/h1>/);
    assert.match(asking, new RegExp(`<form method="post" action="/jobs/${id}/stop"><button type="submit" class="danger">Yes, stop it</button></form>`));
    assert.match(asking, new RegExp(`<a href="/jobs/${id}">No, let it go on</a>`));
    assert.doesNotMatch(asking, /<script/i, 'the pages have no JavaScript at all');
    assert.equal(server.studio.pipeline.isStopping(id), false, 'asking stops nothing');

    const stopped = await form(`/jobs/${id}/stop`);
    assert.equal(stopped.status, 303);
    assert.equal(stopped.headers.get('location'), `/jobs/${id}`, 'the person is taken back to the video');
    const stopping = await (await page(`/jobs/${id}`)).text();
    assert.match(stopping, /<h1>Stopping your video<\/h1>/, 'until the clean-up is over the page says that the video is being stopped');
    assert.doesNotMatch(stopping, /Stop this video|\/stop"|<progress/);
    assert.equal((await form(`/jobs/${id}/stop`)).status, 303, 'pressing it again is harmless');

    open();
    await waitForJob(server.base, id); await untilSettled(server);
    const over = await (await page(`/jobs/${id}`)).text();
    assert.match(over, /<h1>You stopped this video<\/h1>/);
    assert.match(over, /Status: <strong>stopped<\/strong>/);
    assert.match(over, /You stopped this video before it was finished\. Nothing from it was kept\./);
    assert.doesNotMatch(over, /class="card error"|could not be processed|<meta http-equiv="refresh"/, 'it is not shown as an error, and the page stops refreshing');
    assert.match(over, new RegExp(`href="/jobs/${id}/delete">Delete this job</a>`), 'the job can be deleted now');

    const late = await form(`/jobs/${id}/stop`);
    assert.equal(late.status, 409);
    assert.match(await late.text(), /<h1>Already finished<\/h1>[\s\S]*This video is already finished, so there is nothing to stop\.[\s\S]*Back to the video/);
    const lateAsk = await page(`/jobs/${id}/stop`);
    assert.equal(lateAsk.status, 409);
    assert.doesNotMatch(await lateAsk.text(), /<form/, 'a video that is over is not asked about');

    const elsewhere = await makeJobToDelete(server, schema, { status: 'processing' });
    const notHere = await form(`/jobs/${elsewhere.id}/stop`);
    assert.equal(notHere.status, 409);
    const notHereText = await notHere.text();
    assert.match(notHereText, /<h1>Not being worked on<\/h1>[\s\S]*may be waiting to start again after a restart[\s\S]*Back to the video/);
    assert.doesNotMatch(notHereText, /<script/i);
    const nobody = await form(`/jobs/${randomUUID()}/stop`);
    assert.equal(nobody.status, 404);
    assert.match(await nobody.text(), /No job exists for this id\./);
    assert.equal((await page(`/jobs/${randomUUID()}/stop`)).status, 404);
  } finally { open(); await server.stop(); await dropSchema(schema); }
});

test('stopping needs the access code like everything else, and with the code it works', needsFfmpeg, async () => {
  const schema = schemaName('stop_gate'); const { engine, state } = slowToStop();
  const server = await start({ schema, transcriber: engine, env: { ...gated, ...patient }, extra: noDelay });
  try {
    const id = await uploadSample(server, { 'x-access-code': ACCESS_CODE });
    await eventually('the speech to be listened to', () => state.listening, (listening) => listening);
    const without = await askToStop(server, id);
    assert.equal(without.status, 401);
    assert.equal(((await without.json()) as { error: { code: string } }).error.code, 'ACCESS_CODE_REQUIRED');
    assert.equal((await fetch(`${server.base}/jobs/${id}/stop`, manual())).status, 302, 'the page that asks is behind the way in');
    assert.equal((await fetch(`${server.base}/jobs/${id}/stop`, { method: 'POST' })).status, 401);
    assert.equal((await askToStop(server, id, { 'x-access-code': 'not-the-code-1' })).status, 401);
    assert.equal(server.studio.pipeline.isStopping(id), false, 'nothing was stopped for someone without the code');
    const allowed = await askToStop(server, id, { 'x-access-code': ACCESS_CODE });
    assert.equal(allowed.status, 202);
    const view = await (async () => { for (;;) { const seen = await (await fetch(`${server.base}/api/jobs/${id}`, { headers: { 'x-access-code': ACCESS_CODE } })).json() as JobView; if (seen.job.status === 'failed') return seen; await sleep(100); } })();
    assert.equal(view.job.stage, 'stopped');
  } finally { await server.stop(); await dropSchema(schema); }
});

test('stopping a video while the speech program runs ends that program for good, and the job ends as stopped', needsFfmpeg, async () => {
  const schema = schemaName('stop_speech'); const whisperBinary = join(workspace, 'stop-speech-whisper'); const model = join(workspace, 'stop-speech-model.bin'); const pidFile = join(workspace, 'stop-speech.pid');
  await rm(pidFile, { force: true });
  await writeFakeWhisper(whisperBinary, { body: `echo $$ > '${pidFile}'\nexec sleep 60` }); await writeFile(model, '');
  const lines: string[] = [];
  const server = await start({ schema, realSpeechEngine: true, env: { WHISPER_CPP_PATH: whisperBinary, WHISPER_MODEL_PATH: model, ...patient }, extra: capturing(lines) });
  let pid = 0;
  try {
    const id = await uploadSample(server);
    pid = await eventually('the speech program to be started', async () => { try { return Number((await readFile(pidFile, 'utf8')).trim()); } catch { return 0; } }, (value) => value > 0);
    assert.ok(isAlive(pid), 'the speech program is running');
    assert.equal((await askToStop(server, id)).status, 202);
    const view = await waitForJob(server.base, id); await untilSettled(server);
    assert.deepEqual({ status: view.job.status, stage: view.job.stage, errorMessage: view.job.errorMessage }, { status: 'failed', stage: 'stopped', errorMessage: plainWords.stopped });
    await eventually('the speech program to be gone', () => isAlive(pid), (alive) => !alive, 3000);
    assert.deepEqual(readLog(lines).filter((entry) => entry.jobId === id && entry.level >= 50).map((entry) => entry.msg), [], 'a stop is not an error');
  } finally { if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL'); await server.stop(); await dropSchema(schema); }
});

test('stopping a video while FFmpeg makes a clip ends that program for good, and nothing of the clip is kept', needsFfmpeg, async () => {
  const schema = schemaName('stop_render'); const ffmpegBinary = join(workspace, 'stop-render-ffmpeg'); const pidFile = join(workspace, 'stop-render.pid');
  await rm(pidFile, { force: true });
  // Everything is real FFmpeg except the making of the clip (it writes into the outputs folder), which waits, being the very process that was started.
  await writeFile(ffmpegBinary, `#!/bin/sh\ncase "$*" in\n  */outputs/*) echo $$ > '${pidFile}'; exec sleep 60;;\nesac\nexec ffmpeg "$@"\n`, { mode: 0o755 });
  const lines: string[] = [];
  const server = await start({ schema, env: { FFMPEG_PATH: ffmpegBinary, ...patient }, extra: capturing(lines) });
  let pid = 0;
  try {
    const id = await uploadSample(server);
    pid = await eventually('FFmpeg to start making the clip', async () => { try { return Number((await readFile(pidFile, 'utf8')).trim()); } catch { return 0; } }, (value) => value > 0, 20_000);
    assert.ok(isAlive(pid), 'FFmpeg is making the clip');
    assert.equal((await askToStop(server, id)).status, 202);
    const view = await waitForJob(server.base, id); await untilSettled(server);
    assert.deepEqual({ status: view.job.status, stage: view.job.stage, errorMessage: view.job.errorMessage }, { status: 'failed', stage: 'stopped', errorMessage: plainWords.stopped });
    assert.deepEqual(view.clips, [], 'the clip that was being made is not kept, not even as a failed one');
    await eventually('FFmpeg to be gone', () => isAlive(pid), (alive) => !alive, 3000);
    assert.deepEqual([...(server.storage as MemoryStorage).objects.keys()], [], 'nothing of the video is kept in storage');
    assert.ok(!(await readdir(server.dirs.OUTPUT_DIR)).includes(id), 'no clips are kept on the server');
    assert.deepEqual(readLog(lines).filter((entry) => entry.jobId === id && entry.level >= 50).map((entry) => entry.msg), [], 'a stop is not an error, and the clip is not told as one that failed');
  } finally { if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL'); await server.stop(); await dropSchema(schema); }
});


// ---- How long a video takes, and saying no early ----

/** What a server has learned of its own speed, for these tests: seconds of work for each second of video (or of clip). */
const knownSpeeds = (speeds: { listen?: number; render?: number }, samples = 7): KnownSpeeds => ({ speeds, sources: { ...(speeds.listen !== undefined ? { listen: { kind: 'learned' as const, samples } } : {}), ...(speeds.render !== undefined ? { render: { kind: 'learned' as const, samples } } : {}) } });
const noSpeeds: KnownSpeeds = { speeds: {}, sources: {} };
const schemaPool = (schema: string) => new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
const countJobs = async (pool: Pool) => (await pool.query('SELECT count(*)::int AS n FROM video_jobs')).rows[0].n as number;

/** A genuine video of `seconds` seconds (small, and quick to make), with a tone of its own: two videos with different tones are not taken for the same speech. */
async function toneVideo(name: string, seconds: number, hertz: number) {
  const path = join(workspace, `${name}.mp4`);
  await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=160x120:rate=2`, '-f', 'lavfi', '-i', `sine=frequency=${hertz}:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path]);
  return path;
}

/** A genuine two-minute video, for the tests of what is turned away for its length. */
let twoMinutes: string | undefined;
async function twoMinuteVideo() {
  twoMinutes ??= await toneVideo('two-minutes', 120, 440);
  return readFile(twoMinutes);
}

interface Estimate { ahead?: { running: number; waiting: number }; startsInSeconds?: number; finishesInSeconds?: number; basis?: string }
const jobView = async (base: string, id: string) => (await (await fetch(`${base}/api/jobs/${id}`)).json()) as { job: { id: string }; estimate?: Estimate };

test('a video that cannot be listened to in the time allowed is turned away at once, in words that say why, with nothing kept of it; when no speed is known, nothing is said against a video, and unreadable ones are taken as before', needsFfmpeg, async () => {
  const schema = schemaName('toolong'); const raw = schemaPool(schema);
  let known: KnownSpeeds = noSpeeds;
  const server = await start({ schema, extra: { speeds: async () => known } });
  try {
    const long = await twoMinuteVideo();
    const first = await upload(server.base, '/api/jobs', long);   // the server has not learned how fast it is yet
    assert.equal(first.status, 202);
    const accepted = (await first.json() as { job: { id: string; durationSeconds: number | null; width: number | null; height: number | null } }).job;
    assert.ok(accepted.durationSeconds !== null && Math.abs(accepted.durationSeconds - 120) < 1, `what looking at the video showed is kept with the job from the start (${accepted.durationSeconds})`);
    assert.deepEqual([accepted.width, accepted.height], [160, 120]);
    assert.equal((await waitForJob(server.base, accepted.id)).job.status, 'completed'); await untilSettled(server);

    known = knownSpeeds({ listen: 40, render: 3.4 });   // now it knows: listening to two minutes of video (four windows of 30 s) takes 40 times as long, which is more than the hour it is allowed
    const uploadsBefore = await readdir(server.dirs.UPLOAD_DIR);
    const turnedAway = await upload(server.base, '/api/jobs', long);
    assert.equal(turnedAway.status, 422);
    assert.equal(turnedAway.headers.get('retry-after'), null, 'trying again later does not help a video that is too long');
    assert.deepEqual(await turnedAway.json(), { error: { code: 'VIDEO_TOO_LONG', message: 'This video is 2 min 00 s long, which is too long for this server: listening to it would take about 1 h 20 min, and the server stops listening after 1 hour. Videos up to about 1 min work right now. Please upload a shorter part of it.' } });
    const page = await upload(server.base, '/test-upload', long);
    assert.equal(page.status, 422); assert.match(page.headers.get('content-type') ?? '', /html/);
    const html = await page.text();
    assert.match(html, /<h1>This video is too long<\/h1>/); assert.match(html, /listening to it would take about 1 h 20 min/); assert.match(html, /href="\/test-upload"/);
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), uploadsBefore, 'the videos that were turned away are not kept');
    assert.equal(await countJobs(raw), 1, 'and no job was made for them');

    const fits = await upload(server.base, '/api/jobs', await readFile(sampleVideo));   // 8 seconds are one window of 30: 1200 seconds of listening at this speed, which is within the hour
    assert.equal(fits.status, 202);
    assert.equal((await waitForJob(server.base, (await fits.json() as { job: { id: string } }).job.id)).job.status, 'completed'); await untilSettled(server);
    const unreadable = await upload(server.base, '/api/jobs', Buffer.from('this is not a video at all'));
    assert.equal(unreadable.status, 202, 'a file that cannot be looked at is taken as it is');
    const failed = await waitForJob(server.base, (await unreadable.json() as { job: { id: string } }).job.id);
    assert.equal(failed.job.status, 'failed'); assert.equal(failed.job.errorMessage, plainWords.unreadableVideo, 'and fails with its own words, as it always did');
  } finally { await raw.end(); await server.stop(); await dropSchema(schema); }
});

test('a hosted speech service is not stopped at a time limit, so no video is turned away for its length, and no longest length is told', needsFfmpeg, async () => {
  const schema = schemaName('hostedlong');
  const server = await start({ schema, env: { TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example.test/v1', TRANSCRIPTION_API_KEY: 'a-key-that-is-never-used' }, extra: { speeds: async () => knownSpeeds({ listen: 40, render: 3.4 }) } });
  try {
    const response = await upload(server.base, '/api/jobs', await twoMinuteVideo());
    assert.equal(response.status, 202);
    assert.equal((await waitForJob(server.base, (await response.json() as { job: { id: string } }).job.id)).job.status, 'completed'); await untilSettled(server);
    assert.equal(((await (await fetch(`${server.base}/api/queue`)).json()) as { longestVideoSeconds?: number }).longestVideoSeconds, undefined);
    assert.doesNotMatch(await (await fetch(`${server.base}/test-upload`)).text(), /work right now|turned away/);
  } finally { await server.stop(); await dropSchema(schema); }
});

test('a server that holds as many waiting videos as it takes on turns the next one away at once and says when to try again; it keeps nothing of it and takes videos again once the line has moved', needsFfmpeg, async () => {
  const schema = schemaName('full'); const raw = schemaPool(schema);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  let known: KnownSpeeds = noSpeeds;
  const server = await start({ schema, transcriber: slowTalk, env: { JOB_QUEUE_LIMIT: '2' }, extra: { speeds: async () => known } });
  const bytes = await readFile(sampleVideo);
  const send = async () => (await (await upload(server.base, '/api/jobs', bytes)).json() as { job: { id: string } }).job.id;
  try {
    const first = await send();
    await eventually('the first video to be worked on', () => server.studio.pipeline.queueView().running.length, (count) => count === 1);
    const second = await send(); const third = await send();
    await eventually('the next two to wait for their turn', () => server.studio.pipeline.queueView().waiting.length, (count) => count === 2);

    assert.deepEqual(await (await fetch(`${server.base}/api/queue`)).json(), { running: 1, waiting: 2, places: 1, queueLimit: 2, full: true }, 'with no speed known there is no time to tell');
    const uploadsBefore = await readdir(server.dirs.UPLOAD_DIR);
    const refused = await upload(server.base, '/api/jobs', bytes);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('retry-after'), '300', 'five minutes when it cannot be told when a place frees up');
    assert.deepEqual(await refused.json(), { error: { code: 'SERVER_BUSY', message: 'The server is full right now: 2 videos are already waiting for their turn, and it does not take on more than 2. Please try again in a few minutes.' } });
    const refusedPage = await upload(server.base, '/test-upload', bytes);
    assert.equal(refusedPage.status, 503); assert.equal(refusedPage.headers.get('retry-after'), '300');
    assert.match(await refusedPage.text(), /<h1>The server is full<\/h1>/);
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), uploadsBefore, 'nothing was kept of the videos that were turned away');
    assert.equal(await countJobs(raw), 3, 'and no job was made for them');
    assert.match(await (await fetch(`${server.base}/test-upload`)).text(), /<div class="card error"><div class="stage">Right now<\/div><div>The server is full right now: 2 videos are already waiting for their turn/, 'the upload page says it before anyone picks a video');

    known = knownSpeeds({ listen: 3.4, render: 3.4 });   // once the speeds are known, times are told, as estimates, with what they rest on
    const basis = describeBasis(known);
    const queue = await (await fetch(`${server.base}/api/queue`)).json() as Record<string, unknown>;
    assert.equal(queue.longestVideoSeconds, 930, 'an hour, less a tenth of it, at 3.4 seconds of listening for each second of a window: 31 whole windows of 30 s');
    assert.equal(queue.basis, basis);
    // Each video here is 8 s of video, which whisper.cpp works on as one window of 30 s: 102 s of listening and 13.6 s of making the 4 s clip, 115.6 s in all.
    assert.ok(typeof queue.newVideoStartsInSeconds === 'number' && queue.newVideoStartsInSeconds > 300 && queue.newVideoStartsInSeconds <= 347, `a video uploaded now starts after what is left of the one that works and the whole of the two that wait (${String(queue.newVideoStartsInSeconds)} s of the 346.8, in whole seconds)`);
    assert.ok(Number.isInteger(queue.newVideoStartsInSeconds), 'the API tells whole seconds');
    const refusedAgain = await upload(server.base, '/api/jobs', bytes);
    assert.equal(refusedAgain.status, 503);
    const wait = Number(refusedAgain.headers.get('retry-after'));
    assert.ok(wait >= 60 && wait <= 116, `what is left of the video that works, which is at most 115.6 s (${wait})`);
    assert.match(((await refusedAgain.json()) as { error: { message: string } }).error.message, /Please try again in about [12] min\.$/);
    const withTimes = await (await fetch(`${server.base}/test-upload`)).text();
    assert.match(withTimes, /Videos up to about 15 min work right now\. A longer video is turned away at once: listening to it would take more than the 1 hour this server allows\./);

    const working = await jobView(server.base, first);
    assert.ok(working.estimate?.finishesInSeconds !== undefined && working.estimate.finishesInSeconds > 60 && working.estimate.finishesInSeconds <= 115.7, `the video that works has 115.6 s of work at most (${working.estimate?.finishesInSeconds})`);
    assert.ok(Number.isInteger(working.estimate?.finishesInSeconds), 'whole seconds');
    assert.equal(working.estimate?.basis, basis); assert.equal(working.estimate && 'ahead' in working.estimate, false); assert.equal(working.estimate && 'startsInSeconds' in working.estimate, false);
    const waiting = (await jobView(server.base, third)).estimate;
    assert.deepEqual(waiting?.ahead, { running: 1, waiting: 1 });
    assert.ok(waiting?.startsInSeconds !== undefined && waiting.startsInSeconds > 170 && waiting.startsInSeconds <= 231.3, `it starts after what is left of the first and the whole of the second (${waiting?.startsInSeconds})`);
    assert.ok(waiting?.finishesInSeconds !== undefined && Math.abs(waiting.finishesInSeconds - waiting.startsInSeconds - 115.6) <= 1, 'and ends 115.6 s after it starts (the API tells whole seconds)');
    assert.ok(Number.isInteger(waiting.startsInSeconds) && Number.isInteger(waiting.finishesInSeconds), 'whole seconds');
    assert.deepEqual((await jobView(server.base, second)).estimate?.ahead, { running: 1, waiting: 0 });
    assert.match(await (await fetch(`${server.base}/jobs/${third}`)).text(), /In front of yours: 1 video being worked on and 1 video waiting\.<\/div><div style="margin-top:8px">It should start in (about \d+ min|less than a minute) and be done in about \d+ min\.<\/div><div class="muted" style="margin-top:8px">An estimate based on how long this server took for its last 7 videos\. It can be off by a good margin\./);
    assert.match(await (await fetch(`${server.base}/jobs/${first}`)).text(), /Time left: (about \d+ min|less than a minute)\./);

    known = knownSpeeds({ listen: 40, render: 3.4 });   // a video that is too long for this server is told so, even while the server is full: waiting would not make it any shorter
    const tooLongAndFull = await upload(server.base, '/api/jobs', await twoMinuteVideo());
    assert.equal(tooLongAndFull.status, 422); assert.equal(tooLongAndFull.headers.get('retry-after'), null);
    assert.equal(((await tooLongAndFull.json()) as { error: { code: string } }).error.code, 'VIDEO_TOO_LONG');

    known = knownSpeeds({ listen: 0.01, render: 0.01 });   // a server so quick that what is left of the video that works is a fraction of a second
    const soon = await upload(server.base, '/api/jobs', bytes);
    assert.equal(soon.status, 503); assert.equal(soon.headers.get('retry-after'), '60', 'not sooner than a minute, however little is left of the video that works');
    assert.match(((await soon.json()) as { error: { message: string } }).error.message, /Please try again in less than a minute\.$/);
    known = knownSpeeds({ listen: 3.4, render: 3.4 });

    release();
    for (const id of [first, second, third]) assert.equal((await waitForJob(server.base, id)).job.status, 'completed'); await untilSettled(server);
    assert.equal('estimate' in await jobView(server.base, first), false, 'a video that is done has nothing to wait for');
    assert.doesNotMatch(await (await fetch(`${server.base}/jobs/${first}`)).text(), /In front of yours|Time left|should start/);
    assert.deepEqual(await (await fetch(`${server.base}/api/queue`)).json(), { running: 0, waiting: 0, places: 1, queueLimit: 2, full: false, newVideoStartsInSeconds: 0, basis, longestVideoSeconds: 930 });
    const again = await upload(server.base, '/api/jobs', bytes);
    assert.equal(again.status, 202, 'a server whose line has moved takes videos again');
    assert.equal((await waitForJob(server.base, (await again.json() as { job: { id: string } }).job.id)).job.status, 'completed'); await untilSettled(server);
  } finally { release(); await raw.end(); await server.stop(); await dropSchema(schema); }
});

test('with JOB_QUEUE_LIMIT=0 any number of videos may wait, and nothing says that the server is full; the log says which it is', needsFfmpeg, async () => {
  const lines: string[] = [];
  const logging = { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } } };
  const unlimited = schemaName('nolimit'); const limited = schemaName('withlimit');
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  const server = await start({ schema: unlimited, transcriber: slowTalk, env: { JOB_QUEUE_LIMIT: '0' }, extra: logging });
  const bytes = await readFile(sampleVideo);
  try {
    const ids: string[] = [];
    for (let count = 0; count < 4; count += 1) {
      const response = await upload(server.base, '/api/jobs', bytes); assert.equal(response.status, 202);
      ids.push((await response.json() as { job: { id: string } }).job.id);
      if (count === 0) await eventually('the first video to be worked on', () => server.studio.pipeline.queueView().running.length, (running) => running === 1);
    }
    await eventually('the others to wait for their turn', () => server.studio.pipeline.queueView().waiting.length, (waiting) => waiting === 3);
    assert.deepEqual(await (await fetch(`${server.base}/api/queue`)).json(), { running: 1, waiting: 3, places: 1, queueLimit: null, full: false });
    assert.doesNotMatch(await (await fetch(`${server.base}/test-upload`)).text(), /server is full/);
    release();
    for (const id of ids) assert.equal((await waitForJob(server.base, id)).job.status, 'completed'); await untilSettled(server);
  } finally { release(); await server.stop(); await dropSchema(unlimited); }
  assert.ok(logLines(lines).some((entry) => entry.msg === 'Any number of videos may wait for their turn (JOB_QUEUE_LIMIT is 0)'));
  lines.length = 0;
  const other = await start({ schema: limited, extra: logging });
  try { assert.ok(logLines(lines).some((entry) => entry.msg === 'At most 5 videos may wait for their turn; a video that arrives when that many already wait is turned away at once (JOB_QUEUE_LIMIT)'), 'five is what a server takes on when nothing is set'); }
  finally { await other.stop(); await dropSchema(limited); }
});

test('what the start-up check measures about making a clip is kept and logged, but the speed of listening is never taken from it: with no finished videos of its own the server tells no times and turns no video away', needsFfmpeg, async () => {
  const schema = schemaName('measured'); const lines: string[] = [];
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  const server = await start({ schema, transcriber: slowTalk, extra: { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } }, toolchainCheck: async ({ onMeasured }) => { onMeasured({ render: 3.1 }); return passedReport; } } });
  const bytes = await readFile(sampleVideo);
  try {
    assert.equal((await server.studio.toolchain.run()).state, 'passed');
    const first = (await (await upload(server.base, '/api/jobs', bytes)).json() as { job: { id: string } }).job.id;
    await eventually('the first video to be worked on', () => server.studio.pipeline.queueView().running.length, (running) => running === 1);
    const second = (await (await upload(server.base, '/api/jobs', bytes)).json() as { job: { id: string } }).job.id;
    await eventually('the second to wait', () => server.studio.pipeline.queueView().waiting.length, (waiting) => waiting === 1);
    const estimate = (await jobView(server.base, second)).estimate;
    assert.deepEqual(estimate, { ahead: { running: 1, waiting: 0 } }, 'where it is in line is told, and no time, because how long listening takes is not known yet');
    assert.equal('estimate' in await jobView(server.base, first), false, 'a video that is being worked on has nothing to say about time then, and sends no empty estimate');
    const queue = await (await fetch(`${server.base}/api/queue`)).json() as Record<string, unknown>;
    assert.equal('longestVideoSeconds' in queue, false); assert.equal('newVideoStartsInSeconds' in queue, false); assert.equal('basis' in queue, false);
    const page = await (await fetch(`${server.base}/jobs/${second}`)).text();
    assert.match(page, /In front of yours: 1 video being worked on\./); assert.doesNotMatch(page, /should start|Time left|An estimate based on/);
    const long = await upload(server.base, '/api/jobs', await twoMinuteVideo());
    assert.equal(long.status, 202, 'and a long video is taken, as there is nothing yet to say that it cannot be done');
    release();
    for (const id of [first, second, (await long.json() as { job: { id: string } }).job.id]) assert.equal((await waitForJob(server.base, id)).job.status, 'completed'); await untilSettled(server);
  } finally { release(); await server.stop(); await dropSchema(schema); }
  const told = logLines(lines).map((entry) => entry.msg);
  assert.ok(told.includes('The start-up check measured how fast this server makes a clip: 3.1 seconds of work for each second of clip.'), told.join('\n'));
  assert.equal(told.filter((message) => /how fast this server listens/.test(message ?? '')).length, 0, 'it does not claim to have measured how fast the server listens to a video');
});

test('a page about a video does not fail when its time cannot be worked out: the video is shown without a forecast, and the log says why', needsFfmpeg, async () => {
  const schema = schemaName('forecastfails'); const lines: string[] = [];
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  let broken = false;
  const server = await start({ schema, transcriber: slowTalk, extra: { logLevel: 'info', logDestination: { write: (line: string) => { lines.push(line); } }, speeds: async () => { if (broken) throw new Error('the speeds cannot be read'); return knownSpeeds({ listen: 3.4, render: 3.4 }); } } });
  try {
    const id = (await (await upload(server.base, '/api/jobs', await readFile(sampleVideo))).json() as { job: { id: string } }).job.id;
    await eventually('the video to be worked on', () => server.studio.pipeline.queueView().running.length, (running) => running === 1);
    assert.ok((await jobView(server.base, id)).estimate?.finishesInSeconds !== undefined, 'with the speeds known there is a forecast');
    broken = true;
    const api = await fetch(`${server.base}/api/jobs/${id}`);
    assert.equal(api.status, 200);
    const body = await api.json() as { job: { id: string }; estimate?: unknown };
    assert.equal(body.job.id, id); assert.equal('estimate' in body, false, 'the video is there, and nothing is said about its time');
    const page = await fetch(`${server.base}/jobs/${id}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /Time left|An estimate based on/);
    broken = false;
    release();
    assert.equal((await waitForJob(server.base, id)).job.status, 'completed'); await untilSettled(server);
  } finally { release(); await server.stop(); await dropSchema(schema); }
  assert.ok(logLines(lines).some((entry) => entry.msg === 'Could not work out how long a video takes'), 'the log says why');
});

test('once the server has finished videos of its own the estimates and the longest video go by what they took: the pipeline leaves the records the speeds are learned from, and a server that starts again reads them', needsFfmpeg, async () => {
  const schema = schemaName('learned');
  const lengths = [60, 90, 120]; const delays = [600, 900, 1200];   // what listening to each takes: 0.6 s for 60 s of video, and so on: a hundredth of a second for each second of the windows
  let listened = 0;
  const timedTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await sleep(delays[listened] ?? 0); listened += 1; return talk.transcribe(audioPath, workDir); } };
  let first: RunningServer | undefined; let second: RunningServer | undefined; let third: RunningServer | undefined;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  try {
    first = await start({ schema, transcriber: timedTalk, framer: null });
    for (const [index, seconds] of lengths.entries()) {   // a different tone for each, so that none is taken for a video whose speech was already written down
      const response = await upload(first.base, '/api/jobs', await readFile(await toneVideo(`learned-${seconds}`, seconds, 440 + 110 * index)));
      assert.equal(response.status, 202);
      assert.equal((await waitForJob(first.base, (await response.json() as { job: { id: string } }).job.id)).job.status, 'completed'); await untilSettled(first);
    }
    assert.equal(listened, 3, 'all three were listened to');
    await first.stop();   // what the first server finished stays in the database for the next

    second = await start({ schema, transcriber: heldTalk, framer: null });
    const queue = await (await fetch(`${second.base}/api/queue`)).json() as { basis?: string; longestVideoSeconds?: number };
    assert.equal(queue.basis, 'how long this server took for its last 3 videos', 'it learned from the three that finished, and says so');
    assert.ok(typeof queue.longestVideoSeconds === 'number' && queue.longestVideoSeconds % 30 === 0 && queue.longestVideoSeconds > 32_400, `a server that listens this fast turns no ordinary video away (${String(queue.longestVideoSeconds)} s, in whole windows of 30 s)`);
    const response = await upload(second.base, '/api/jobs', await readFile(await toneVideo('learned-150', 150, 770)));
    assert.equal(response.status, 202);
    const id = (await response.json() as { job: { id: string } }).job.id;
    await eventually('the video to be worked on', () => second!.studio.pipeline.queueView().running.length, (running) => running === 1);
    const estimate = (await jobView(second.base, id)).estimate;
    assert.equal(estimate?.basis, 'how long this server took for its last 3 videos');
    assert.ok(estimate?.finishesInSeconds !== undefined && estimate.finishesInSeconds > 0 && estimate.finishesInSeconds < 60, `a time that fits what the three took (${String(estimate?.finishesInSeconds)} s)`);
    assert.match(await (await fetch(`${second.base}/jobs/${id}`)).text(), /Time left: (about \d+ min|less than a minute)\.[\s\S]*An estimate based on how long this server took for its last 3 videos\. It can be off by a good margin\./);
    release();
    assert.equal((await waitForJob(second.base, id)).job.status, 'completed'); await untilSettled(second);
    await second.stop();

    // The same finished videos, but with the clips they made gone from the record, so that the speed of making a clip cannot be learned from them: what the start-up check measured stands in for it.
    const raw = schemaPool(schema);
    try { await raw.query('DELETE FROM generated_clips'); } finally { await raw.end(); }
    third = await start({ schema, framer: null, extra: { toolchainCheck: async ({ onMeasured }) => { onMeasured({ render: 2.5 }); return passedReport; } } });
    assert.equal((await third.studio.toolchain.run()).state, 'passed');
    const standIn = await (await fetch(`${third.base}/api/queue`)).json() as { basis?: string };
    assert.equal(standIn.basis, 'how long this server took for its last 4 videos (and, for making the clips, on a test it made when it started)', 'the three, and the one the second server finished');
  } finally { release(); await first?.stop(); await second?.stop(); await third?.stop(); await dropSchema(schema); }
});

test('a video from a YouTube address is looked at like an upload: its length is kept, a video that is too long is thrown away after it was downloaded, and a full server says so before it downloads anything', needsFfmpeg, async () => {
  const sample = await readFile(sampleVideo); const long = await twoMinuteVideo();
  let served = sample; const hits = { cobalt: 0, media: 0 };
  const cobalt = createServer((request, response) => {
    if (request.method === 'POST') { hits.cobalt += 1; response.setHeader('content-type', 'application/json'); return void response.end(JSON.stringify({ status: 'tunnel', url: `http://127.0.0.1:${(cobalt.address() as AddressInfo).port}/media.mp4`, filename: 'talk.mp4' })); }
    hits.media += 1; response.setHeader('content-type', 'video/mp4'); response.end(served);
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => cobalt.once('listening', resolve));
  const schema = schemaName('ytlooks');
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowTalk: TranscriptionEngine = { transcribe: async (audioPath, workDir) => { await gate; return talk.transcribe(audioPath, workDir); } };
  let known: KnownSpeeds = noSpeeds;
  const server = await start({ schema, transcriber: slowTalk, env: { COBALT_API_URL: `http://127.0.0.1:${(cobalt.address() as AddressInfo).port}`, JOB_QUEUE_LIMIT: '1' }, extra: { speeds: async () => known } });
  const ask = () => fetch(`${server.base}/api/youtube`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }) });
  try {
    const accepted = await ask(); assert.equal(accepted.status, 202);
    const { job, source } = await accepted.json() as { job: { id: string; durationSeconds: number | null; width: number | null }; source: string };
    assert.equal(source, 'youtube'); assert.ok(job.durationSeconds !== null && Math.abs(job.durationSeconds - 8) < 1, `${job.durationSeconds}`); assert.equal(job.width, 320);
    await eventually('the video to be worked on', () => server.studio.pipeline.queueView().running.length, (running) => running === 1);

    served = long; known = knownSpeeds({ listen: 40, render: 3.4 });
    const uploadsBefore = await readdir(server.dirs.UPLOAD_DIR); const downloadsBefore = hits.media;
    const tooLong = await ask();
    assert.equal(tooLong.status, 422); assert.equal(((await tooLong.json()) as { error: { code: string } }).error.code, 'VIDEO_TOO_LONG');
    assert.equal(hits.media, downloadsBefore + 1, 'it has to be downloaded before anyone can tell how long it is');
    assert.deepEqual(await readdir(server.dirs.UPLOAD_DIR), uploadsBefore, 'and what was downloaded is thrown away');

    served = sample; known = noSpeeds;
    const queued = await ask(); assert.equal(queued.status, 202);   // one waits now, which is as many as this server takes on
    const asked = hits.cobalt;
    const full = await ask();
    assert.equal(full.status, 503); assert.equal(full.headers.get('retry-after'), '300');
    assert.equal(((await full.json()) as { error: { code: string } }).error.code, 'SERVER_BUSY');
    assert.equal(hits.cobalt, asked, 'a server that is full does not even ask for the video');
    release();
    await eventually('both videos to be done', () => server.studio.pipeline.activeJobCount, (count) => count === 0);
  } finally { release(); await server.stop(); await dropSchema(schema); await new Promise<void>((resolve) => cobalt.close(() => resolve())); }
});
