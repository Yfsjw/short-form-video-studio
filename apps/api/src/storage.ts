import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface DurableStorage {
  /** True when this storage really persists what it is given (as opposed to the local-disk-only fallback). */
  readonly isDurable: boolean;
  /** Uploads a local file under `key` (a relative path such as "jobId/clipId.mp4") and verifies it arrived complete. Throws if it could not be stored. No-op when storage isn't configured. */
  upload(localPath: string, key: string, contentType: string): Promise<void>;
  /** Downloads `key` into `localPath` (written to a temporary file first, so a half-finished download is never mistaken for the real file). Throws if the object is missing or incomplete. */
  download(key: string, localPath: string): Promise<void>;
  /** Removes `key`. Deleting a key that does not exist is not an error. */
  delete(key: string): Promise<void>;
  /** Writes, reads back and deletes a tiny object: proves the credentials, the bucket and the network path all work end to end. Throws when any step fails. */
  selfTest(): Promise<void>;
  /** A URL the browser can fetch `key` from directly, or null when nothing was ever uploaded under it (fallback mode). Pass forceDownloadFilename to make the browser save the file instead of playing/rendering it inline. */
  getDownloadUrl(key: string, forceDownloadFilename?: string): Promise<string | null>;
}

/**
 * Where the durable copy of an uploaded video lives. Everything uploaded by users sits under
 * "sources/" and generated clips under "<jobId>/", so a bucket lifecycle rule such as
 * "expire objects under sources/ after N days" can bound storage cost without touching clips.
 */
export function sourceKeyFor(jobId: string, storedFilename: string): string {
  const extension = extname(storedFilename).toLowerCase().replace(/[^a-z0-9.]/g, '');
  return `sources/${jobId}/source${extension}`;
}

/** The only part of S3Client this module relies on, so tests can substitute an in-memory fake. */
export interface S3Sender { send(command: unknown): Promise<any>; }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readAll(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Real persistence: Cloudflare R2 via its S3-compatible API. */
export class R2Storage implements DurableStorage {
  readonly isDurable = true;
  private readonly signer: S3Client;
  private readonly client: S3Sender;
  private readonly retryDelaysMs: number[];

  constructor(accountId: string, private readonly bucket: string, accessKeyId: string, secretAccessKey: string, options: { client?: S3Sender; retryDelaysMs?: number[] } = {}) {
    this.signer = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.client = options.client ?? this.signer;
    // Pause before each retry of a failed upload: 3 attempts in total with the defaults.
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1500];
  }

  async upload(localPath: string, key: string, contentType: string) {
    const { size } = await stat(localPath);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]);
      // A stream can only be read once, so every attempt gets a fresh one.
      const body = createReadStream(localPath);
      try {
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: size }));
        // Trust, but verify: ask the store what it actually holds before anyone is told the file is safe.
        const stored = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        if (Number(stored.ContentLength) !== size) throw new Error(`the store reports ${stored.ContentLength} bytes but ${size} were sent`);
        return;
      } catch (error) {
        lastError = error;
      } finally {
        body.destroy();
      }
    }
    throw new Error(`Could not save ${key} to durable storage after ${this.retryDelaysMs.length + 1} attempts: ${describeError(lastError)}`);
  }

  async download(key: string, localPath: string) {
    await mkdir(dirname(localPath), { recursive: true });
    const partial = `${localPath}.part-${randomUUID()}`;
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) throw new Error(`durable storage returned no data for ${key}`);
      await pipeline(response.Body as Readable, createWriteStream(partial));
      const written = (await stat(partial)).size;
      if (typeof response.ContentLength === 'number' && response.ContentLength !== written) throw new Error(`downloaded ${written} bytes of ${key} but the stored object has ${response.ContentLength}`);
      await rename(partial, localPath);
    } catch (error) {
      await rm(partial, { force: true });
      throw new Error(`Could not download ${key} from durable storage: ${describeError(error)}`);
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async selfTest() {
    const key = `_selftest/${randomUUID()}.txt`;
    const payload = Buffer.from(`short-form-video-studio storage self-test ${new Date().toISOString()}`);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: payload, ContentType: 'text/plain', ContentLength: payload.length }));
    try {
      const stored = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (Number(stored.ContentLength) !== payload.length) throw new Error(`self-test object has ${stored.ContentLength} bytes but ${payload.length} were written`);
      const read = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!(await readAll(read.Body)).equals(payload)) throw new Error('self-test object came back different from what was written');
    } finally {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
  }

  async getDownloadUrl(key: string, forceDownloadFilename?: string): Promise<string> {
    // Presigned GET so the browser downloads directly from R2 -- Node never has to
    // buffer or proxy the (potentially large) video file through itself. Without
    // ResponseContentDisposition, R2 serves the object with its plain video/mp4
    // content-type and browsers (mobile Chrome especially) just play it inline
    // instead of saving it -- so this is set only when an actual download was asked for.
    return getSignedUrl(this.signer, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentDisposition: forceDownloadFilename ? `attachment; filename="${forceDownloadFilename}"` : undefined,
    }), { expiresIn: 3600 });
  }
}

/** Local dev / R2-not-configured fallback: uploads are silently skipped, and the caller falls back to serving straight off local disk. */
export class NullStorage implements DurableStorage {
  readonly isDurable = false;
  async upload() { /* intentionally a no-op */ }
  async download(): Promise<void> { throw new Error('Durable storage is not configured, so there is nothing to download from.'); }
  async delete() { /* nothing is ever stored, so nothing to delete */ }
  async selfTest(): Promise<void> { throw new Error('Durable storage is not configured.'); }
  async getDownloadUrl(_key: string, _forceDownloadFilename?: string) { return null; }
}

type R2Settings = { R2_ACCOUNT_ID?: string; R2_BUCKET_NAME?: string; R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string };

/** Names (never values) of the R2 settings that are still missing. */
export function missingR2Settings(config: R2Settings): string[] {
  return (['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const).filter((name) => !config[name]);
}

export function createStorage(config: R2Settings): DurableStorage {
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = config;
  if (R2_ACCOUNT_ID && R2_BUCKET_NAME && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    return new R2Storage(R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
  }
  return new NullStorage();
}
