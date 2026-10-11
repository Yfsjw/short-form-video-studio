import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DurableStorage } from './storage.js';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `accept(probe())` is true and returns what the probe saw; on timeout it fails and says what it last saw.
 * Background work (a job's clean-up, an abandoned upload being discarded) finishes a moment after the event a test
 * can observe, so tests wait for the outcome instead of assuming it is already there or sleeping for a guessed time.
 */
export async function eventually<T>(description: string, probe: () => T | Promise<T>, accept: (seen: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await probe();
    if (accept(seen)) return seen;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description} (last seen: ${JSON.stringify(seen)})`);
    await sleep(20);
  }
}

/** Durable storage kept in memory (a stand-in for Cloudflare R2 in tests), recording everything it is asked to do. */
export class MemoryStorage implements DurableStorage {
  readonly isDurable = true;
  /** What is stored right now. */
  readonly objects = new Map<string, Buffer>();
  /** Everything that was ever uploaded (what it contained when it arrived), even if it has since been deleted. */
  readonly uploaded = new Map<string, Buffer>();
  readonly log: string[] = [];
  /** Make every upload fail, like a storage outage. */
  failUploads = false;
  /** Make every delete fail. */
  failDeletes = false;
  async upload(localPath: string, key: string) {
    this.log.push(`upload:${key}`);
    if (this.failUploads) throw new Error('simulated storage outage');
    const data = await readFile(localPath);
    this.objects.set(key, data);
    this.uploaded.set(key, data);
  }
  async download(key: string, localPath: string) {
    this.log.push(`download:${key}`);
    const data = this.objects.get(key);
    if (!data) throw new Error(`no such object ${key}`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, data);
  }
  async delete(key: string) {
    this.log.push(`delete:${key}`);
    if (this.failDeletes) throw new Error('simulated storage outage');
    this.objects.delete(key);
  }
  async selfTest() { /* always healthy */ }
  async getDownloadUrl(key: string) { return `https://storage.test/${key}`; }
}
