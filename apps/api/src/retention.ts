/**
 * How long clips are kept, and how a job is deleted: when a person asks for it, or when it is older than CLIP_RETENTION_DAYS.
 *
 * Deleting a job removes everything that was made from the person's video: the clips and their caption files from storage, the job's rows
 * from the database (clips, transcript, highlights), and the transcript that was kept for reuse from the same sound (see transcript-cache.ts).
 * Nothing is ever deleted from under a job that is still being worked on, and nothing is removed from the database before everything stored for
 * it is gone, so that a deletion that fails halfway can simply be asked for again (deleting what is not there is not an error).
 */
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isSafeClipIdentifier } from './clips.js';
import type { StudioDatabase } from './database.js';
import { sourceKeyFor, type DurableStorage } from './storage.js';

/** What came of a deletion: it was done; there is no such job (any more); the job is still being worked on; or a stored file could not be deleted (nothing was removed from the list then). */
export type EraseOutcome = 'erased' | 'missing' | 'not finished' | 'storage failed';
/** Who asked: a person (the button, the API) or the clock (CLIP_RETENTION_DAYS). */
export type EraseReason = 'requested' | 'expired';

export interface RetentionLog {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface JobEraserParts {
  db: Pick<StudioDatabase, 'getJob' | 'listClips' | 'deleteFinishedJob'>;
  storage: DurableStorage;
  /** Where the server keeps what was uploaded and what it made, on its own disk (the copies in storage are the real ones when storage is durable). */
  uploadDir: string;
  outputDir: string;
  logger: RetentionLog;
}

export class JobEraser {
  constructor(private readonly parts: JobEraserParts) {}

  async erase(jobId: string, reason: EraseReason): Promise<EraseOutcome> {
    const { db, storage, logger } = this.parts;
    const job = await db.getJob(jobId);
    if (!job) return 'missing';
    if (job.status !== 'completed' && job.status !== 'failed') return 'not finished';

    // Everything in storage that can hold something of this job. The caption file is named by its job and clip, as the pipeline names it, and also by the
    // path the database recorded for it; the video the person uploaded is normally gone by now, but a job that ended while storage was failing may still hold it.
    const clips = await db.listClips(jobId);
    const keys = new Set<string>();
    for (const clip of clips) {
      keys.add(clip.outputPath); keys.add(`${jobId}/${clip.id}.srt`);
      if (clip.captionPath) keys.add(clip.captionPath);
    }
    if (job.sourceStorageKey) keys.add(job.sourceStorageKey); else keys.add(sourceKeyFor(job.id, job.storedFilename));
    if (storage.isDurable) {
      let failed = 0;
      for (const key of keys) {
        try { await storage.delete(key); } catch (error) { failed += 1; logger.error({ err: error, jobId, key }, 'Could not delete a stored file of a job that is being deleted'); }
      }
      // The list is kept while anything is left in storage: with the rows gone nothing would ever point at what remains.
      if (failed) return 'storage failed';
    }

    // False here means that the job went in the meantime (another deletion got there first): there is nothing left to do.
    if (!(await db.deleteFinishedJob(jobId))) return 'missing';
    await this.removeLocalFiles(jobId, job.storedFilename);
    logger.info({ jobId, reason, clipCount: clips.length }, reason === 'expired' ? 'Deleted a job whose clips had been kept for as long as they are kept' : 'Deleted a job at the request of the person who made it');
    return 'erased';
  }

  /** The copies on the server's own disk (the only ones when there is no durable storage). Best effort: what remains here is scratch space that a restart wipes anyway. */
  private async removeLocalFiles(jobId: string, storedFilename: string) {
    const { uploadDir, outputDir } = this.parts;
    if (isSafeClipIdentifier(jobId)) await rm(join(outputDir, jobId), { recursive: true, force: true }).catch(() => undefined);
    if (storedFilename && basename(storedFilename) === storedFilename) await rm(join(uploadDir, storedFilename), { force: true }).catch(() => undefined);
  }
}

export interface SweepResult { erased: number; failed: number; }

export interface RetentionOptions {
  /** CLIP_RETENTION_DAYS: jobs that finished longer ago than this are deleted; 0 keeps everything until a person deletes it. */
  days: number;
  /** How often to look (an hour), and how long after the start before the first look (a minute, so that a server that is starting has its hands free). */
  intervalMs?: number;
  firstSweepMs?: number;
  /** How many jobs are deleted before the database is asked again, and how many such rounds one look may make at most. */
  batchSize?: number;
  maxBatches?: number;
  now?: () => number;
}

const DAY_MS = 86_400_000;

export class RetentionSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<SweepResult> | undefined;
  private stopped = false;

  constructor(
    private readonly parts: { db: Pick<StudioDatabase, 'listFinishedJobsOlderThan'>; eraser: Pick<JobEraser, 'erase'>; logger: RetentionLog },
    private readonly options: RetentionOptions,
  ) {}

  get enabled() { return this.options.days > 0; }

  /**
   * One look: deletes the jobs that finished more than `days` ago, oldest first. Never two at once. When a deletion fails (a storage service that is
   * down, most likely) the look ends after that round instead of asking again for the same jobs; the next look tries them again.
   */
  sweep(): Promise<SweepResult> {
    this.running ??= this.sweepOnce().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async sweepOnce(): Promise<SweepResult> {
    const result: SweepResult = { erased: 0, failed: 0 };
    if (!this.enabled) return result;
    const { db, eraser, logger } = this.parts;
    const cutoff = new Date((this.options.now ?? Date.now)() - this.options.days * DAY_MS).toISOString();
    for (let round = 0; round < (this.options.maxBatches ?? 20); round += 1) {
      const due = await db.listFinishedJobsOlderThan(cutoff, this.options.batchSize ?? 25);
      if (!due.length) break;
      for (const job of due) {
        const outcome = await eraser.erase(job.id, 'expired');
        if (outcome === 'erased') result.erased += 1;
        else if (outcome === 'storage failed') result.failed += 1;
      }
      if (result.failed) break;
    }
    if (result.erased || result.failed) logger.info({ ...result, retentionDays: this.options.days }, result.failed ? 'Deleted the clips that are older than they are kept; some could not be deleted and are tried again next time' : 'Deleted the clips that are older than they are kept');
    return result;
  }

  start() {
    if (!this.enabled || this.timer || this.stopped) return;
    this.schedule(this.options.firstSweepMs ?? 60_000);
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sweep().catch((error: unknown) => this.parts.logger.error({ err: error }, 'Looking for clips that are older than they are kept failed; it is tried again next time'))
        .finally(() => { if (!this.stopped) this.schedule(this.options.intervalMs ?? 3_600_000); });
    }, delayMs);
    this.timer.unref();
  }

  /** Stops looking, and waits for a look that is in progress to end (so that the database is not closed under it). */
  async stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.running?.catch(() => undefined);
  }
}
