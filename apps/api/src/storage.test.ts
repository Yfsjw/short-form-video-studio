import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { NullStorage, R2Storage, createStorage, missingR2Settings, sourceKeyFor } from './storage.js';

/** An in-memory stand-in for the S3 API, with switches to simulate the ways a real store misbehaves. */
class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  putFailures = 0; // reject this many PUTs before behaving
  getFailures = 0; // reject this many GETs before behaving
  brokenGetStreams = 0; // for this many GETs, hand over a body that dies halfway through
  reportedSizeOffset = 0; // make HEAD lie about the stored size
  truncateGetBy = 0; // deliver fewer bytes than ContentLength announces
  garbleGet = false; // deliver different bytes than were stored

  async send(command: unknown): Promise<any> {
    if (command instanceof PutObjectCommand) {
      this.calls.push('put');
      if (this.putFailures > 0) { this.putFailures -= 1; throw new Error('simulated network failure'); }
      const { Key, Body } = command.input;
      if (Buffer.isBuffer(Body)) this.objects.set(Key!, Body);
      else {
        const chunks: Buffer[] = [];
        for await (const chunk of Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        this.objects.set(Key!, Buffer.concat(chunks));
      }
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      this.calls.push('head');
      const object = this.objects.get(command.input.Key!);
      if (!object) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      return { ContentLength: object.length + this.reportedSizeOffset };
    }
    if (command instanceof GetObjectCommand) {
      this.calls.push('get');
      if (this.getFailures > 0) { this.getFailures -= 1; throw new Error('simulated network failure'); }
      const object = this.objects.get(command.input.Key!);
      if (!object) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      if (this.brokenGetStreams > 0) {
        this.brokenGetStreams -= 1;
        const half = object.subarray(0, Math.floor(object.length / 2));
        return { Body: Readable.from((async function* () { yield half; throw new Error('connection reset halfway through the download'); })()), ContentLength: object.length };
      }
      const delivered = this.garbleGet ? Buffer.alloc(object.length, 'x') : object.subarray(0, object.length - this.truncateGetBy);
      return { Body: Readable.from([delivered]), ContentLength: object.length };
    }
    if (command instanceof DeleteObjectCommand) {
      this.calls.push('delete');
      this.objects.delete(command.input.Key!);
      return {};
    }
    throw new Error('unexpected command');
  }
}

async function withStorage(work: (context: { s3: FakeS3; storage: R2Storage; dir: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-storage-'));
  const s3 = new FakeS3();
  const storage = new R2Storage('0123456789abcdef0123456789abcdef', 'bucket', 'AKIAFAKEKEYFORTESTS', 'fake-secret-for-tests', { client: s3, retryDelaysMs: [0, 0] });
  try { await work({ s3, storage, dir }); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('upload stores the file and checks with the store that it arrived complete', () => withStorage(async ({ s3, storage, dir }) => {
  const file = join(dir, 'clip.mp4');
  await writeFile(file, 'twelve bytes');
  await storage.upload(file, 'job/clip.mp4', 'video/mp4');
  assert.equal(s3.objects.get('job/clip.mp4')?.toString(), 'twelve bytes');
  assert.deepEqual(s3.calls, ['put', 'head']);
}));

test('upload survives a transient failure by retrying with a fresh stream', () => withStorage(async ({ s3, storage, dir }) => {
  const file = join(dir, 'source.mp4');
  await writeFile(file, 'the complete video');
  s3.putFailures = 2;
  await storage.upload(file, 'sources/j/source.mp4', 'video/mp4');
  assert.equal(s3.objects.get('sources/j/source.mp4')?.toString(), 'the complete video', 'a retry must send the whole file, not what was left of a half-read stream');
  assert.equal(s3.calls.filter((call) => call === 'put').length, 3);
}));

test('upload gives up with a clear error once every attempt has failed', () => withStorage(async ({ s3, storage, dir }) => {
  const file = join(dir, 'source.mp4');
  await writeFile(file, 'video');
  s3.putFailures = 99;
  await assert.rejects(storage.upload(file, 'sources/j/source.mp4', 'video/mp4'), /after 3 attempts: simulated network failure/);
  assert.equal(s3.objects.size, 0);
}));

test('upload refuses to call a file safe when the store reports a different size', () => withStorage(async ({ s3, storage, dir }) => {
  const file = join(dir, 'clip.mp4');
  await writeFile(file, 'abcdef');
  s3.reportedSizeOffset = -2;
  await assert.rejects(storage.upload(file, 'job/clip.mp4', 'video/mp4'), /the store reports 4 bytes but 6 were sent/);
}));

test('download writes the complete file and leaves no temporary files behind', () => withStorage(async ({ s3, storage, dir }) => {
  s3.objects.set('sources/j/source.mp4', Buffer.from('restored video bytes'));
  const target = join(dir, 'nested', 'source.mp4');
  await storage.download('sources/j/source.mp4', target);
  assert.equal(await readFile(target, 'utf8'), 'restored video bytes');
  assert.deepEqual(await readdir(join(dir, 'nested')), ['source.mp4']);
}));

test('a download that arrives incomplete is rejected and never appears as the real file', () => withStorage(async ({ s3, storage, dir }) => {
  s3.objects.set('sources/j/source.mp4', Buffer.from('0123456789'));
  s3.truncateGetBy = 3;
  const target = join(dir, 'source.mp4');
  await assert.rejects(storage.download('sources/j/source.mp4', target), /downloaded 7 bytes .* has 10/);
  assert.deepEqual(await readdir(dir), [], 'neither the target nor a .part file may remain');
}));

test('downloading something that does not exist fails and leaves nothing behind', () => withStorage(async ({ storage, dir }) => {
  await assert.rejects(storage.download('sources/missing/source.mp4', join(dir, 'source.mp4')), /Could not download sources\/missing\/source.mp4/);
  assert.deepEqual(await readdir(dir), []);
}));

test('a download that fails for a moment is tried again, so a passing network problem does not cost a customer their job', () => withStorage(async ({ s3, storage, dir }) => {
  s3.objects.set('sources/j/source.mp4', Buffer.from('the whole video'));
  s3.getFailures = 2;
  const target = join(dir, 'source.mp4');
  await storage.download('sources/j/source.mp4', target);
  assert.equal(await readFile(target, 'utf8'), 'the whole video');
  assert.equal(s3.calls.filter((call) => call === 'get').length, 3);
  assert.deepEqual(await readdir(dir), ['source.mp4']);
}));

test('a connection that dies halfway through a download is retried from the start, and the half-written file never survives', () => withStorage(async ({ s3, storage, dir }) => {
  s3.objects.set('sources/j/source.mp4', Buffer.from('0123456789abcdef'));
  s3.brokenGetStreams = 1;
  const target = join(dir, 'source.mp4');
  await storage.download('sources/j/source.mp4', target);
  assert.equal(await readFile(target, 'utf8'), '0123456789abcdef');
  assert.deepEqual(await readdir(dir), ['source.mp4'], 'no .part file may be left behind');
}));

test('a download gives up with a clear error once every attempt has failed', () => withStorage(async ({ s3, storage, dir }) => {
  s3.objects.set('sources/j/source.mp4', Buffer.from('video'));
  s3.getFailures = 99;
  await assert.rejects(storage.download('sources/j/source.mp4', join(dir, 'source.mp4')), /Could not download sources\/j\/source.mp4 from durable storage after 3 attempts: simulated network failure/);
  assert.equal(s3.calls.filter((call) => call === 'get').length, 3);
  assert.deepEqual(await readdir(dir), []);
}));

test('an object that is simply not there is reported at once instead of being asked for again and again', () => withStorage(async ({ s3, storage, dir }) => {
  await assert.rejects(storage.download('sources/gone/source.mp4', join(dir, 'source.mp4')), /after 1 attempt: The specified key does not exist/);
  assert.equal(s3.calls.filter((call) => call === 'get').length, 1);
}));

/** A real R2Storage (real SDK client, real sockets) talking to a server we control on this machine. */
async function withRealClient(server: net.Server, stallTimeoutsMs: { connect: number; idle: number }, work: (context: { storage: R2Storage; dir: string }) => Promise<void>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'studio-storage-'));
  try {
    const storage = new R2Storage('0123456789abcdef0123456789abcdef', 'bucket', 'AKIAFAKEKEYFORTESTS', 'fake-secret-for-tests', { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stallTimeoutsMs, retryDelaysMs: [0, 0] });
    await work({ storage, dir });
  } finally {
    (server as http.Server).closeAllConnections?.(); // only an HTTP server has this; the raw TCP one is cleaned up by its test
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test('a store that accepts the connection but never answers is given up on, instead of a job waiting for it for ever', { timeout: 40_000 }, async () => {
  // Measured before the limits existed: a request to such a server was still pending after 8 seconds, and would have stayed that way.
  const sockets = new Set<net.Socket>();
  const silent = net.createServer((socket) => { sockets.add(socket); socket.on('data', () => undefined); socket.on('error', () => undefined); });
  try {
    await withRealClient(silent, { connect: 500, idle: 500 }, async ({ storage, dir }) => {
      const video = join(dir, 'source.mp4');
      await writeFile(video, 'a video');
      const started = Date.now();
      await assert.rejects(storage.upload(video, 'sources/j/source.mp4', 'video/mp4'), /Could not save sources\/j\/source.mp4 to durable storage after 3 attempts/);
      await assert.rejects(storage.download('sources/j/source.mp4', join(dir, 'restored.mp4')), /Could not download/);
      await assert.rejects(storage.delete('sources/j/source.mp4'), /timed out|did not establish/i);
      assert.ok(Date.now() - started < 30_000, 'giving up must take seconds, not for ever');
      assert.deepEqual((await readdir(dir)).sort(), ['source.mp4'], 'no half-written download may remain');
    });
  } finally { for (const socket of sockets) socket.destroy(); }
});

test('the limit is on silence, not on duration: a slow download that keeps moving is not cut off', async () => {
  const chunk = Buffer.alloc(1024, 'v');
  const chunks = 12;
  const slow = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': String(chunk.length * chunks), 'content-type': 'video/mp4' });
    let sent = 0;
    const timer = setInterval(() => { response.write(chunk); sent += 1; if (sent === chunks) { clearInterval(timer); response.end(); } }, 150);
    response.on('close', () => clearInterval(timer));
  });
  await withRealClient(slow, { connect: 1000, idle: 1000 }, async ({ storage, dir }) => {
    const target = join(dir, 'restored.mp4');
    const started = Date.now();
    await storage.download('sources/j/source.mp4', target);
    assert.ok(Date.now() - started > 1000, 'the transfer must have lasted longer than the idle limit for this test to mean anything');
    assert.equal((await readFile(target)).length, chunk.length * chunks);
  });
});

test('delete removes an object, and deleting one that is already gone is fine', () => withStorage(async ({ s3, storage }) => {
  s3.objects.set('job/old.mp4', Buffer.from('x'));
  await storage.delete('job/old.mp4');
  await storage.delete('job/old.mp4');
  assert.equal(s3.objects.size, 0);
}));

test('the self-test writes, reads back and deletes, leaving the bucket as it found it', () => withStorage(async ({ s3, storage }) => {
  await storage.selfTest();
  assert.deepEqual(s3.calls, ['put', 'head', 'get', 'delete']);
  assert.equal(s3.objects.size, 0);
}));

test('the self-test notices corrupted read-backs and still cleans up its test object', () => withStorage(async ({ s3, storage }) => {
  s3.garbleGet = true;
  await assert.rejects(storage.selfTest(), /came back different/);
  assert.equal(s3.objects.size, 0);
}));

test('the self-test fails loudly when the store rejects writes', () => withStorage(async ({ s3, storage }) => {
  s3.putFailures = 1;
  await assert.rejects(storage.selfTest(), /simulated network failure/);
}));

test('presigned download links only force a download when asked to', async () => {
  const storage = new R2Storage('0123456789abcdef0123456789abcdef', 'bucket', 'AKIAFAKEKEYFORTESTS', 'fake-secret-for-tests');
  const inline = new URL(await storage.getDownloadUrl('job/clip.mp4'));
  const forced = new URL(await storage.getDownloadUrl('job/clip.mp4', 'my-clip.mp4'));
  assert.equal(inline.searchParams.has('response-content-disposition'), false);
  assert.equal(forced.searchParams.get('response-content-disposition'), 'attachment; filename="my-clip.mp4"');
});

test('storage is only durable when every R2 setting is present, and the missing ones are named', () => {
  const complete = { R2_ACCOUNT_ID: 'a', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'c', R2_SECRET_ACCESS_KEY: 'd' };
  assert.equal(createStorage(complete).isDurable, true);
  assert.equal(createStorage({ ...complete, R2_SECRET_ACCESS_KEY: undefined }).isDurable, false);
  assert.equal(createStorage({}).isDurable, false);
  assert.deepEqual(missingR2Settings({ R2_ACCOUNT_ID: 'a', R2_BUCKET_NAME: '' }), ['R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
  assert.deepEqual(missingR2Settings(complete), []);
});

test('the local-only fallback never pretends it can restore anything', async () => {
  const storage = new NullStorage();
  await storage.upload();
  await storage.delete();
  assert.equal(await storage.getDownloadUrl('anything'), null);
  await assert.rejects(storage.download(), /not configured/);
  await assert.rejects(storage.selfTest(), /not configured/);
});

test('source videos live under sources/ with a sanitised extension', () => {
  assert.equal(sourceKeyFor('job-1', 'abc.mp4'), 'sources/job-1/source.mp4');
  assert.equal(sourceKeyFor('job-1', 'ABC.MOV'), 'sources/job-1/source.mov');
  assert.equal(sourceKeyFor('job-1', 'weird.mp4/../x'), 'sources/job-1/source');
});
