import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface DurableStorage {
  /** Uploads a local file under `key` (a relative path, e.g. "jobId/clipId.mp4"). No-op when storage isn't configured. */
  upload(localPath: string, key: string, contentType: string): Promise<void>;
  /** True when this storage actually persists uploads (vs. the local-disk-only fallback). */
  readonly isDurable: boolean;
  /** A URL the browser can fetch `key` from directly, or null when nothing was ever uploaded under it (fallback mode). Pass forceDownloadFilename to make the browser save the file instead of playing/rendering it inline. */
  getDownloadUrl(key: string, forceDownloadFilename?: string): Promise<string | null>;
}

/** Real persistence: Cloudflare R2 via its S3-compatible API. */
export class R2Storage implements DurableStorage {
  readonly isDurable = true;
  private readonly client: S3Client;
  constructor(accountId: string, private readonly bucket: string, accessKeyId: string, secretAccessKey: string) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async upload(localPath: string, key: string, contentType: string) {
    const { size } = await stat(localPath);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: createReadStream(localPath), ContentType: contentType, ContentLength: size,
    }));
  }

  async getDownloadUrl(key: string, forceDownloadFilename?: string): Promise<string> {
    // Presigned GET so the browser downloads directly from R2 -- Node never has to
    // buffer or proxy the (potentially large) video file through itself. Without
    // ResponseContentDisposition, R2 serves the object with its plain video/mp4
    // content-type and browsers (mobile Chrome especially) just play it inline
    // instead of saving it -- so this is set only when an actual download was asked for.
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentDisposition: forceDownloadFilename ? `attachment; filename="${forceDownloadFilename}"` : undefined,
    }), { expiresIn: 3600 });
  }
}

/** Local dev / R2-not-configured fallback: uploads are silently skipped, and the caller falls back to serving straight off local disk. */
export class NullStorage implements DurableStorage {
  readonly isDurable = false;
  async upload() { /* intentionally a no-op */ }
  async getDownloadUrl(_key: string, _forceDownloadFilename?: string) { return null; }
}

export function createStorage(config: { R2_ACCOUNT_ID?: string; R2_BUCKET_NAME?: string; R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string }): DurableStorage {
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = config;
  if (R2_ACCOUNT_ID && R2_BUCKET_NAME && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    return new R2Storage(R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
  }
  return new NullStorage();
}
