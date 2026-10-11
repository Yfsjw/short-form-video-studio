import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { StudioDatabase } from './database.js';
import type { FfmpegAdapter } from './ffmpeg.js';
import type { TranscriptionEngine } from './transcription.js';
import type { HighlightDetector, HighlightOptions } from './highlights.js';
import type { ClipRenderer } from './clips.js';
import type { GeneratedClip, VideoJob } from './domain.js';
import { writeSrtCaptions } from './captions.js';
import { sourceKeyFor, type DurableStorage } from './storage.js';

type PipelineStore = Pick<StudioDatabase, 'getJob' | 'updateJob' | 'replaceTranscript' | 'listTranscript' | 'replaceHighlights' | 'listHighlights' | 'createClip' | 'updateClip' | 'beginAttempt' | 'touchJob' | 'listUnfinishedJobs' | 'listFinishedJobsHoldingSource' | 'claimJobForRecovery' | 'failStaleJob' | 'deleteClipsForJob'>;
type MediaProcessor = Pick<FfmpegAdapter, 'probe' | 'extractAudio'>;

export interface PipelineRuntimeOptions {
  /** How many jobs may be in their CPU/memory-heavy stages (transcription, rendering) at the same time. A 512 MB instance should keep this at 1. */
  concurrency: number;
  /** A queued/processing job whose row nothing has touched for this long belongs to a process that died. */
  staleAfterMs: number;
  /** How often a live job refreshes its row so it is never mistaken for an abandoned one. Keep it well below staleAfterMs. */
  heartbeatMs: number;
  /** While a job still looks like another live process owns it, look again this often. */
  recheckMs: number;
  /** How many times a job may be started in total (the first run included) before it is failed for good. */
  maxAttempts: number;
}

export const defaultRuntimeOptions: PipelineRuntimeOptions = { concurrency: 1, staleAfterMs: 60_000, heartbeatMs: 15_000, recheckMs: 30_000, maxAttempts: 3 };

export interface RecoverySummary {
  /** Jobs handed back to the pipeline because their video can still be obtained. */
  resumed: string[];
  /** Jobs given up on, each with an honest reason stored on the job. */
  failed: string[];
  /** Unfinished jobs that were touched recently, i.e. probably still owned by another live process. */
  waiting: number;
}

const isFile = (path: string) => stat(path).then((info) => info.isFile(), () => false);

/** Lets a fixed number of jobs into the heavy stages at once; the rest wait their turn in arrival order. */
class Semaphore {
  private held = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  get isFull() { return this.held >= this.limit; }
  async acquire() {
    if (this.held < this.limit) { this.held += 1; return; }
    // The slot is handed over by whoever releases it, so `held` stays the same.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next(); else this.held -= 1;
  }
}

/**
 * Orchestrates real processing stages, including 9:16 rendering and transcript-synced captions.
 *
 * Jobs run inside this process, but nothing about a job depends on the process surviving:
 * the uploaded video is copied to durable storage first, every job refreshes a heartbeat while
 * it runs, and a process that finds jobs abandoned by a dead one (restart, redeploy, the free
 * tier going to sleep, an out-of-memory kill) resumes them from the durable copy, up to
 * `maxAttempts` times.
 */
export class VideoPipeline {
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly slots: Semaphore;
  private recheckTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly db: PipelineStore, private readonly ffmpeg: MediaProcessor, private readonly transcriber: TranscriptionEngine, private readonly highlightDetector: HighlightDetector, private readonly highlightOptions: HighlightOptions, private readonly clipRenderer: ClipRenderer, private readonly maxClipCandidates: number, private readonly uploadDir: string, private readonly tempDir: string, private readonly outputDir: string, private readonly logger: Pick<Logger, 'info' | 'error'>, private readonly storage: DurableStorage, private readonly options: PipelineRuntimeOptions = defaultRuntimeOptions) {
    this.slots = new Semaphore(options.concurrency);
  }

  /** Jobs this process is working on right now, their final clean-up included (a job's status already reads "completed" a moment before this drops). */
  get activeJobCount() { return this.heartbeats.size; }

  /** Starts processing in the background. Never throws and never leaves a rejected promise behind that could take the process down. */
  enqueue(jobId: string) {
    if (this.closed || this.heartbeats.has(jobId)) return;
    void this.run(jobId).catch((error) => {
      this.logger.error({ err: error, jobId }, 'Unexpected error while processing job');
      // Typically the database was unreachable, so not even the failure could be written down. The job is
      // left in its last saved state with nobody refreshing it; look again shortly, and once it has gone
      // quiet it is resumed (or failed for good if it has already used up its attempts).
      this.scheduleRecheck(true);
    });
  }

  async run(jobId: string) {
    this.startHeartbeat(jobId);
    try { await this.process(jobId); } finally { this.stopHeartbeat(jobId); }
  }

  /**
   * Looks for jobs a dead process left unfinished and either resumes them or fails them with an
   * honest reason. Safe to call from several servers at once (the takeover is one atomic update),
   * and it keeps looking while some unfinished job still seems to be owned by another live process,
   * so a job orphaned by a redeploy is picked up as soon as its heartbeat goes quiet.
   */
  async recoverInterruptedJobs(): Promise<RecoverySummary> {
    const summary: RecoverySummary = { resumed: [], failed: [], waiting: 0 };
    try {
      const staleBefore = new Date(Date.now() - this.options.staleAfterMs).toISOString();
      for (const job of await this.db.listUnfinishedJobs()) {
        if (this.heartbeats.has(job.id)) continue; // being handled right here, right now
        if (job.updatedAt >= staleBefore) { summary.waiting += 1; continue; }
        const decision = await this.decideRecovery(job);
        if (!decision.resume) {
          if (await this.db.failStaleJob(job.id, staleBefore, decision.message)) {
            summary.failed.push(job.id);
            this.logger.error({ jobId: job.id, attempts: job.attempts }, `Gave up on an interrupted job: ${decision.message}`);
            await this.releaseStoredSource(job.id);
          }
        } else if (await this.db.claimJobForRecovery(job.id, staleBefore)) {
          summary.resumed.push(job.id);
          this.enqueue(job.id);
        }
      }
      await this.sweepFinishedSources();
    } catch (error) {
      this.logger.error({ err: error }, 'Looking for interrupted jobs failed; will try again shortly');
      this.scheduleRecheck(true);
      return summary;
    }
    this.scheduleRecheck(summary.waiting > 0);
    return summary;
  }

  /** Stops the background timers (used by tests and when shutting down). Work already in flight is not cancelled. */
  close() {
    this.closed = true;
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
  }

  private async decideRecovery(job: VideoJob): Promise<{ resume: true } | { resume: false; message: string }> {
    if (job.attempts >= this.options.maxAttempts) {
      return { resume: false, message: `Processing was interrupted ${job.attempts} times in a row (the server restarted or ran out of memory each time), so it was given up on. Please upload the video again.` };
    }
    const obtainable = (job.sourceStorageKey !== null && this.storage.isDurable) || await isFile(join(this.uploadDir, job.storedFilename));
    if (!obtainable) {
      return { resume: false, message: 'The server restarted before the uploaded video was saved to durable storage, so processing could not be resumed. Please upload the video again.' };
    }
    return { resume: true };
  }

  private scheduleRecheck(needed: boolean) {
    if (this.recheckTimer) { clearTimeout(this.recheckTimer); this.recheckTimer = undefined; }
    if (!needed || this.closed) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      void this.recoverInterruptedJobs();
    }, this.options.recheckMs);
    this.recheckTimer.unref();
  }

  private startHeartbeat(jobId: string) {
    if (this.closed || this.heartbeats.has(jobId)) return;
    const timer = setInterval(() => {
      this.db.touchJob(jobId).catch((error) => this.logger.error({ err: error, jobId }, 'Could not refresh the job heartbeat'));
    }, this.options.heartbeatMs);
    timer.unref();
    this.heartbeats.set(jobId, timer);
  }

  private stopHeartbeat(jobId: string) {
    const timer = this.heartbeats.get(jobId);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(jobId);
  }

  private async process(jobId: string) {
    const job = await this.db.getJob(jobId); if (!job) return;
    const sourcePath = join(this.uploadDir, job.storedFilename);
    const jobOutputDir = join(this.outputDir, jobId);
    let reachedFinalState = false;
    let sourceIsSafe = job.sourceStorageKey !== null;
    try {
      const attempt = await this.db.beginAttempt(jobId);
      if (attempt > 1) this.logger.info({ jobId, attempt }, 'Resuming a job that was interrupted');
      await this.db.updateJob(jobId, { status: 'processing', stage: 'preparing_source', errorMessage: null });
      await this.prepareSource(job, sourcePath);
      sourceIsSafe = true;
      // Everything up to here is plain file transfer and runs for every job at once, so a video is in
      // durable storage as early as possible even while another job occupies the CPU.
      if (this.slots.isFull) await this.db.updateJob(jobId, { status: 'queued', stage: 'waiting_for_capacity' });
      await this.slots.acquire();
      try {
        await this.db.updateJob(jobId, { status: 'processing', stage: 'probing_video' });
        await this.renderClips(job, sourcePath, jobOutputDir);
      } finally {
        this.slots.release();
      }
      reachedFinalState = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected processing failure';
      this.logger.error({ err: error, jobId }, 'Video processing failed');
      await this.db.updateJob(jobId, { status: 'failed', stage: 'failed', errorMessage: message });
      reachedFinalState = true;
    } finally {
      // The local video is scratch space only once the outcome is recorded or a durable copy exists. A job that could not even
      // record its failure (database outage) will be resumed, and if its video never reached durable storage this file is all it has.
      await this.removeLocalCopies(sourcePath, jobOutputDir, { keepSource: !reachedFinalState && !sourceIsSafe });
      // Only once the outcome is safely recorded: a job that will be resumed still needs its stored video.
      if (reachedFinalState) await this.releaseStoredSource(jobId);
    }
  }

  /**
   * The durable copy of an upload exists so that an unfinished job can be resumed. Once the job is over
   * (completed, or failed for good) nothing needs it any more, so it is deleted: storage cost stays bounded
   * by the jobs in flight, and customers' videos are not kept longer than the work needs them.
   * Best effort: a failure here is logged and never changes the outcome of the job. Returns whether the stored copy is gone.
   */
  private async releaseStoredSource(jobId: string): Promise<boolean> {
    if (!this.storage.isDurable) return false;
    try {
      const job = await this.db.getJob(jobId);
      if (!job) return false;
      // Normally the job records where its video is. If the process died between uploading the video and recording that, the object
      // still sits at the key it was going to get; deleting a key that holds nothing is harmless.
      await this.storage.delete(job.sourceStorageKey ?? sourceKeyFor(job.id, job.storedFilename));
      if (job.sourceStorageKey) await this.db.updateJob(jobId, { sourceStorageKey: null });
      return true;
    } catch (error) {
      this.logger.error({ err: error, jobId }, 'Could not delete the stored copy of the uploaded video');
      return false;
    }
  }

  /** Catches stored videos that outlived their job: the process died, or storage failed, at the very moment the job ended. */
  private async sweepFinishedSources() {
    if (!this.storage.isDurable) return;
    for (const job of await this.db.listFinishedJobsHoldingSource()) {
      if (this.heartbeats.has(job.id)) continue; // its own clean-up is still running
      if (await this.releaseStoredSource(job.id)) this.logger.info({ jobId: job.id }, 'Deleted a stored video that was left behind by a finished job');
    }
  }

  /** Makes sure a durable copy of the uploaded video exists (when durable storage is configured) and that a local copy is on disk to work from. */
  private async prepareSource(job: VideoJob, sourcePath: string) {
    const haveLocal = await isFile(sourcePath);
    if (!this.storage.isDurable) {
      if (!haveLocal) throw new Error('The uploaded video is no longer on the server, and durable storage is not configured to restore it from.');
      return;
    }
    if (job.sourceStorageKey) {
      if (haveLocal) return;
      await this.db.updateJob(job.id, { stage: 'restoring_source' });
      await this.storage.download(job.sourceStorageKey, sourcePath);
      const restoredBytes = (await stat(sourcePath)).size;
      if (restoredBytes !== job.sizeBytes) {
        await rm(sourcePath, { force: true });
        throw new Error(`The video restored from durable storage has ${restoredBytes} bytes but ${job.sizeBytes} were uploaded.`);
      }
      this.logger.info({ jobId: job.id, key: job.sourceStorageKey }, 'Restored the uploaded video from durable storage');
      return;
    }
    if (!haveLocal) throw new Error('The uploaded video is no longer on the server and was never saved to durable storage. Please upload it again.');
    await this.db.updateJob(job.id, { stage: 'saving_source' });
    const key = sourceKeyFor(job.id, job.storedFilename);
    await this.storage.upload(sourcePath, key, job.mimeType || 'application/octet-stream');
    await this.db.updateJob(job.id, { sourceStorageKey: key });
    this.logger.info({ jobId: job.id, key, sizeBytes: job.sizeBytes }, 'Saved the uploaded video to durable storage');
  }

  /** An interrupted earlier attempt may have left clip rows and files behind; the new attempt starts from a clean slate. */
  private async discardPreviousClips(jobId: string, jobOutputDir: string) {
    const leftovers = await this.db.deleteClipsForJob(jobId);
    await rm(jobOutputDir, { recursive: true, force: true });
    if (!leftovers.length) return;
    if (this.storage.isDurable) {
      for (const clip of leftovers) {
        for (const key of [clip.outputPath, `${jobId}/${clip.id}.srt`]) {
          try { await this.storage.delete(key); }
          catch (error) { this.logger.error({ err: error, jobId, key }, 'Could not delete a leftover object from an interrupted attempt'); }
        }
      }
    }
    this.logger.info({ jobId, discardedClipCount: leftovers.length }, 'Discarded clips left behind by an interrupted attempt');
  }

  /** With durable storage the local copies are only scratch space (the disk is wiped on restart anyway), so free them as soon as the job is over. */
  private async removeLocalCopies(sourcePath: string, jobOutputDir: string, options: { keepSource: boolean }) {
    if (!this.storage.isDurable) return;
    try {
      if (!options.keepSource) await rm(sourcePath, { force: true });
      await rm(jobOutputDir, { recursive: true, force: true });
    } catch { /* freeing disk space is best effort */ }
  }

  private async renderClips(job: VideoJob, sourcePath: string, jobOutputDir: string) {
    const jobId = job.id;
    await this.discardPreviousClips(jobId, jobOutputDir);
    const metadata = await this.ffmpeg.probe(sourcePath);
    await this.db.updateJob(jobId, { stage: 'extracting_audio', ...metadata });
    const workDir = await mkdtemp(join(this.tempDir, `${jobId}-`));
    try {
      const audioPath = join(workDir, 'audio.wav');
      await this.ffmpeg.extractAudio(sourcePath, audioPath);
      await this.db.updateJob(jobId, { stage: 'transcribing' });
      const segments = await this.transcriber.transcribe(audioPath, workDir);
      await this.db.replaceTranscript(jobId, segments);
      await this.db.updateJob(jobId, { stage: 'detecting_highlights' });
      const highlights = this.highlightDetector.detect({ segments: await this.db.listTranscript(jobId), durationSeconds: metadata.durationSeconds, metadata: { width: metadata.width, height: metadata.height }, options: this.highlightOptions });
      await this.db.replaceHighlights(jobId, highlights);
      const candidates = (await this.db.listHighlights(jobId)).slice(0, this.maxClipCandidates);
      if (!candidates.length) throw new Error('Highlight detection produced no valid candidate ranges for clip extraction.');
      await this.db.updateJob(jobId, { stage: 'extracting_clips' });
      await mkdir(jobOutputDir, { recursive: true });
      let completedCount = 0;
      for (const candidate of candidates) {
        const clipId = randomUUID();
        const outputFilename = `${clipId}.mp4`;
        const outputPath = join(jobOutputDir, outputFilename);
        const captionPath = join(jobOutputDir, `${clipId}.srt`);
        const now = new Date().toISOString();
        const clip: GeneratedClip = { id: clipId, jobId, candidateId: candidate.id, startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds, durationSeconds: candidate.endSeconds - candidate.startSeconds, outputPath: join(jobId, outputFilename), outputFilename, status: 'queued', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now };
        await this.db.createClip(clip); await this.db.updateClip(clipId, { status: 'processing' });
        try {
          const transcriptSegments = await this.db.listTranscript(jobId);
          const captionCount = await writeSrtCaptions(captionPath, transcriptSegments, candidate.startSeconds, candidate.endSeconds);
          const rendered = await this.clipRenderer.render({ sourcePath, startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds, outputPath, captionPath: captionCount ? captionPath : null });
          await this.storage.upload(outputPath, clip.outputPath, 'video/mp4');
          if (captionCount) await this.storage.upload(captionPath, `${jobId}/${clipId}.srt`, 'application/x-subrip');
          await this.db.updateClip(clipId, { status: 'completed', durationSeconds: rendered.durationSeconds, errorMessage: null, captionPath }); completedCount += 1;
        } catch (error) {
          await rm(captionPath, { force: true });
          const message = error instanceof Error ? error.message : 'Unexpected clip extraction failure'; await this.db.updateClip(clipId, { status: 'failed', errorMessage: message }); this.logger.error({ err: error, jobId, clipId, candidateId: candidate.id }, 'Clip extraction failed');
        }
      }
      if (!completedCount) throw new Error(`Clip extraction failed for all ${candidates.length} ranked candidate(s).`);
      await this.db.updateJob(jobId, { status: 'completed', stage: 'clip_extraction_complete' });
      this.logger.info({ jobId, metadata, transcriptSegmentCount: segments.length, highlightCandidateCount: highlights.length, completedClipCount: completedCount }, 'Video processing, vertical rendering, and caption burn-in completed');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
