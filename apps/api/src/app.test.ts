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
async function start(options: { schema: string; storage?: DurableStorage; transcriber?: TranscriptionEngine; env?: Record<string, string> }): Promise<RunningServer> {
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
  const studio = await createApp(config, { storage, transcriber: options.transcriber ?? talk, databaseSchema: options.schema });
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
    const html = await response.text();
    assert.match(html, /Upload received/);
    const id = html.match(/Job ID: ([0-9a-f-]{36})/)?.[1];
    assert.ok(id, 'the confirmation page must show the job id');

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

test('file names are escaped on the confirmation page, so an upload cannot inject markup', needsFfmpeg, async () => {
  const schema = schemaName('xss'); const server = await start({ schema });
  try {
    const response = await upload(server.base, '/test-upload', await readFile(sampleVideo), '<img src=x onerror=alert(1)>.mp4');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.mp4'));
    assert.ok(!html.includes('<img src=x'));
    const id = html.match(/Job ID: ([0-9a-f-]{36})/)![1];
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
