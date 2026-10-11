import assert from 'node:assert/strict';
import test from 'node:test';
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
      const object = this.objects.get(command.input.Key!);
      if (!object) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
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
