import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { StudioDatabase } from './database.js';
import type { FfmpegAdapter } from './ffmpeg.js';
import type { TranscriptionEngine } from './transcription.js';
import type { HighlightDetector, HighlightOptions } from './highlights.js';
import type { ClipRenderer } from './clips.js';
import type { ClipFramer } from './face-track.js';
import type { FramingResult } from './framing.js';
import type { GeneratedClip, VideoJob } from './domain.js';
import { writeAssCaptions, writeSrtCaptions } from './captions.js';
import { paddedRange } from './ranges.js';
import { highlightOptionsFor } from './options.js';
import { StageClock, stageProgress, totalMilliseconds } from './progress.js';
import { sourceKeyFor, StoredObjectMissingError, type DurableStorage } from './storage.js';

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
  /**
   * Even when nothing looks abandoned, look again this often for as long as the process lives. Another process (the old
   * instance during a zero-downtime redeploy) can accept a job after this one did its start-up check and then be shut down
   * before finishing it; without this nobody would notice until the next restart.
   */
  watchdogMs: number;
  /** How many times a job may be started in total (the first run included) before it is failed for good. */
  maxAttempts: number;
}

export const defaultRuntimeOptions: PipelineRuntimeOptions = { concurrency: 1, staleAfterMs: 60_000, heartbeatMs: 15_000, recheckMs: 30_000, watchdogMs: 180_000, maxAttempts: 3 };

export interface RecoverySummary {
  /** Jobs handed back to the pipeline because their video can still be obtained. */
  resumed: string[];
  /** Jobs given up on, each with an honest reason stored on the job. */
  failed: string[];
  /** Unfinished jobs that were touched recently, i.e. probably still owned by another live process. */
  waiting: number;
}

const isFile = (path: string) => stat(path).then((info) => info.isFile(), () => false);

/** The uploaded video is (as far as anyone knows) safe in durable storage but cannot be read back at this moment. That says nothing about the job itself. */
class SourceUnavailableForNow extends Error {}

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
  /** Times the stages of the jobs this process is working on right now. */
  private readonly clocks = new Map<string, StageClock>();
  private readonly lastProgress = new Map<string, { percent: number; at: number }>();
  /** The latest progress write of each running job; the next stage change waits for it so an old value can never overwrite a newer one. */
  private readonly progressWrites = new Map<string, Promise<void>>();
  private readonly slots: Semaphore;
  private recheckTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly db: PipelineStore, private readonly ffmpeg: MediaProcessor, private readonly transcriber: TranscriptionEngine, private readonly highlightDetector: HighlightDetector, private readonly highlightOptions: HighlightOptions, private readonly clipRenderer: ClipRenderer, private readonly maxClipCandidates: number, private readonly uploadDir: string, private readonly tempDir: string, private readonly outputDir: string, private readonly logger: Pick<Logger, 'info' | 'error'>, private readonly storage: DurableStorage, private readonly options: PipelineRuntimeOptions = defaultRuntimeOptions, private readonly framer?: ClipFramer) {
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
      this.scheduleRecheck(this.options.recheckMs);
    });
  }

  async run(jobId: string) {
    this.startHeartbeat(jobId);
    try { await this.process(jobId); } finally { this.stopHeartbeat(jobId); }
  }

  /**
   * Looks for jobs a dead process left unfinished and either resumes them or fails them with an
   * honest reason. Safe to call from several servers at once (the takeover is one atomic update),
   * and it keeps looking: soon again while some unfinished job still seems to be owned by another live process (so a job
   * orphaned by a redeploy is picked up as soon as its heartbeat goes quiet), and at a slow pace otherwise (so a job that
   * was orphaned after this check ran is found too).
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
          // The stored video of a job given up on is deleted by the clean-up below, not here. This loop settles the fate of every job and
          // only talks to the database: the storage service can be slow or silent, and the jobs further down the list must not wait
          // for it before they are resumed.
          if (await this.db.failStaleJob(job.id, staleBefore, decision.message)) {
            summary.failed.push(job.id);
            this.logger.error({ jobId: job.id, attempts: job.attempts }, `Gave up on an interrupted job: ${decision.message}`);
          }
        } else if (await this.db.claimJobForRecovery(job.id, staleBefore)) {
          summary.resumed.push(job.id);
          this.enqueue(job.id);
        }
      }
      await this.sweepFinishedSources(summary.failed);
    } catch (error) {
      this.logger.error({ err: error }, 'Looking for interrupted jobs failed; will try again shortly');
      this.scheduleRecheck(this.options.recheckMs);
      return summary;
    }
    this.scheduleRecheck(summary.waiting > 0 ? this.options.recheckMs : this.options.watchdogMs);
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
      return { resume: false, message: `Processing was interrupted ${job.attempts} times in a row (the server restarted, ran out of memory or could not reach its storage each time), so it was given up on. Please upload the video again.` };
    }
    const obtainable = (job.sourceStorageKey !== null && this.storage.isDurable) || await isFile(join(this.uploadDir, job.storedFilename));
    if (!obtainable) {
      return { resume: false, message: 'The server restarted before the uploaded video was saved to durable storage, so processing could not be resumed. Please upload the video again.' };
    }
    return { resume: true };
  }

  private scheduleRecheck(delayMs: number) {
    if (this.recheckTimer) { clearTimeout(this.recheckTimer); this.recheckTimer = undefined; }
    if (this.closed) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      void this.recoverInterruptedJobs();
    }, delayMs);
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
    let attempt = 0;
    const clock = new StageClock();
    this.clocks.set(jobId, clock);
    try {
      attempt = await this.db.beginAttempt(jobId);
      if (attempt > 1) this.logger.info({ jobId, attempt }, 'Resuming a job that was interrupted');
      await this.enterStage(jobId, 'preparing_source', { status: 'processing', errorMessage: null });
      await this.prepareSource(job, sourcePath);
      sourceIsSafe = true;
      // Everything up to here is plain file transfer and runs for every job at once, so a video is in
      // durable storage as early as possible even while another job occupies the CPU.
      if (this.slots.isFull) await this.enterStage(jobId, 'waiting_for_capacity', { status: 'queued' });
      await this.slots.acquire();
      try {
        await this.enterStage(jobId, 'probing_video', { status: 'processing' });
        await this.renderClips(job, sourcePath, jobOutputDir);
      } finally {
        this.slots.release();
      }
      reachedFinalState = true;
    } catch (error) {
      if (error instanceof SourceUnavailableForNow && attempt < this.options.maxAttempts) {
        // Failing the job would end it, delete the only copy of the customer's video and make them upload it all over again, for a
        // problem that is likely to pass (the storage service having a bad minute while the server restarted). So this attempt is
        // simply abandoned, like one whose process died: the job keeps looking unfinished, nothing refreshes it, and the periodic look
        // for abandoned jobs starts it again once it has gone quiet. The number of attempts is still bounded.
        this.logger.error({ err: error, jobId, attempt }, 'Could not read the uploaded video back from durable storage; the job will be tried again later');
        await this.db.updateJob(jobId, { stage: 'waiting_to_retry', stageTimings: clock.finish() });
      } else {
        const message = error instanceof Error ? error.message : 'Unexpected processing failure';
        this.logger.error({ err: error, jobId }, 'Video processing failed');
        await this.progressWrites.get(jobId)?.catch(() => undefined);
        await this.db.updateJob(jobId, { status: 'failed', stage: 'failed', errorMessage: message, stageTimings: clock.finish() });
        reachedFinalState = true;
      }
    } finally {
      // The local video is scratch space only once the outcome is recorded or a durable copy exists. A job that could not even
      // record its failure (database outage) will be resumed, and if its video never reached durable storage this file is all it has.
      await this.removeLocalCopies(sourcePath, jobOutputDir, { keepSource: !reachedFinalState && !sourceIsSafe });
      // Only once the outcome is safely recorded: a job that will be resumed still needs its stored video.
      if (reachedFinalState) await this.releaseStoredSource(jobId);
      this.clocks.delete(jobId); this.lastProgress.delete(jobId); this.progressWrites.delete(jobId);
    }
  }

  /** Moves a job into a stage: closes the timing of the stage before it and records the stage with its place on the progress scale. */
  private async enterStage(jobId: string, stage: string, fields: Partial<Pick<VideoJob, 'status' | 'errorMessage' | 'durationSeconds' | 'width' | 'height'>> = {}) {
    await this.progressWrites.get(jobId)?.catch(() => undefined);
    const clock = this.clocks.get(jobId);
    clock?.enter(stage);
    const progress = stageProgress(stage);
    this.lastProgress.set(jobId, { percent: progress, at: Date.now() });
    await this.db.updateJob(jobId, { ...fields, stage, progress, ...(clock ? { stageTimings: clock.snapshot() } : {}) });
  }

  /**
   * Moves the progress forward inside a long stage (whisper.cpp's percentage, clips finished). It never waits for the database
   * and never throws, only moves forward, and writes at most about once per percent point (or every ten seconds).
   */
  private reportProgress(jobId: string, percent: number) {
    const last = this.lastProgress.get(jobId);
    const now = Date.now();
    if (last && (percent <= last.percent || (percent < last.percent + 1 && now - last.at < 10_000))) return;
    this.lastProgress.set(jobId, { percent, at: now });
    const write = (this.progressWrites.get(jobId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.db.updateJob(jobId, { progress: percent }))
      .catch((error: unknown) => { this.logger.error({ err: error, jobId }, 'Could not record the progress of the job'); });
    this.progressWrites.set(jobId, write);
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

  /**
   * Deletes the stored video of every job that is over: the jobs recovery has just given up on (`justGivenUp`, which includes any whose
   * video was uploaded but never recorded), and those left behind because the process died, or storage failed, at the very moment the
   * job ended. Runs after the unfinished jobs have been dealt with, because it is the one step that waits on the storage service.
   */
  private async sweepFinishedSources(justGivenUp: readonly string[] = []) {
    if (!this.storage.isDurable) return;
    const leftBehind = new Set((await this.db.listFinishedJobsHoldingSource()).map((job) => job.id));
    let failuresInARow = 0;
    for (const jobId of new Set([...justGivenUp, ...leftBehind])) {
      if (this.heartbeats.has(jobId)) continue; // its own clean-up is still running
      if (await this.releaseStoredSource(jobId)) {
        failuresInARow = 0;
        if (leftBehind.has(jobId)) this.logger.info({ jobId }, 'Deleted a stored video that was left behind by a finished job');
      } else if (++failuresInARow >= 3) {
        // Storage is evidently in trouble. Every further attempt would take as long to fail as these did, and this runs while
        // the server is starting up; the next pass tries again, and nothing has been lost (the jobs still point at their videos).
        break;
      }
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
      await this.enterStage(job.id, 'restoring_source');
      try {
        await this.storage.download(job.sourceStorageKey, sourcePath);
      } catch (error) {
        // An object that is gone is gone; anything else (the store not answering, a transfer that keeps breaking) may well pass.
        if (error instanceof StoredObjectMissingError) throw new Error('The saved copy of the uploaded video no longer exists in durable storage, so processing cannot be resumed. Please upload the video again.');
        throw new SourceUnavailableForNow(`The uploaded video could not be read back from durable storage: ${error instanceof Error ? error.message : String(error)}`);
      }
      const restoredBytes = (await stat(sourcePath)).size;
      if (restoredBytes !== job.sizeBytes) {
        await rm(sourcePath, { force: true });
        throw new Error(`The video restored from durable storage has ${restoredBytes} bytes but ${job.sizeBytes} were uploaded.`);
      }
      this.logger.info({ jobId: job.id, key: job.sourceStorageKey }, 'Restored the uploaded video from durable storage');
      return;
    }
    if (!haveLocal) throw new Error('The uploaded video is no longer on the server and was never saved to durable storage. Please upload it again.');
    await this.enterStage(job.id, 'saving_source');
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

  /**
   * Plans where the picture of a clip is cut from when the person asked for a face to be followed. Never fails the clip: whatever goes wrong
   * (no face, too little of one, a video that cannot be sampled, a server where this is switched off) the clip is cut from the middle, and says so.
   */
  private async frameClip(jobId: string, sourcePath: string, range: { startSeconds: number; endSeconds: number }): Promise<FramingResult> {
    if (!this.framer) return { followed: false, note: 'Centred: following a face is switched off on this server.' };
    try {
      return await this.framer.frame({ sourcePath, startSeconds: range.startSeconds, endSeconds: range.endSeconds });
    } catch (error) {
      this.logger.error({ err: error, jobId }, 'Looking for a face to follow failed; the clip is cut from the middle instead');
      return { followed: false, note: 'Centred: the video could not be checked for a face.' };
    }
  }

  private async renderClips(job: VideoJob, sourcePath: string, jobOutputDir: string) {
    const jobId = job.id;
    await this.discardPreviousClips(jobId, jobOutputDir);
    const metadata = await this.ffmpeg.probe(sourcePath);
    await this.enterStage(jobId, 'extracting_audio', { ...metadata });
    const workDir = await mkdtemp(join(this.tempDir, `${jobId}-`));
    try {
      const audioPath = join(workDir, 'audio.wav');
      await this.ffmpeg.extractAudio(sourcePath, audioPath);
      await this.enterStage(jobId, 'transcribing');
      const segments = await this.transcriber.transcribe(audioPath, workDir, (fraction) => this.reportProgress(jobId, stageProgress('transcribing', fraction)));
      await this.db.replaceTranscript(jobId, segments);
      await this.enterStage(jobId, 'detecting_highlights');
      const options = job.options;
      const transcript = await this.db.listTranscript(jobId);
      const highlights = this.highlightDetector.detect({ segments: transcript, durationSeconds: metadata.durationSeconds, metadata: { width: metadata.width, height: metadata.height }, options: highlightOptionsFor(this.highlightOptions, options) });
      await this.db.replaceHighlights(jobId, highlights);
      const candidates = (await this.db.listHighlights(jobId)).slice(0, options.clipCount ?? this.maxClipCandidates);
      if (!candidates.length) throw new Error(transcript.length ? 'No stretch of the speech was long enough to make a clip from.' : 'No speech was recognised in this video, so there is nothing to base clips on. Try a video in which someone is talking.');
      await this.enterStage(jobId, 'extracting_clips');
      await mkdir(jobOutputDir, { recursive: true });
      let completedCount = 0; let framingMs = 0;
      for (const [candidateNumber, candidate] of candidates.entries()) {
        const clipId = randomUUID();
        const outputFilename = `${clipId}.mp4`;
        const outputPath = join(jobOutputDir, outputFilename);
        const captionPath = join(jobOutputDir, `${clipId}.srt`);
        const styledCaptionPath = join(jobOutputDir, `${clipId}.ass`);
        const now = new Date().toISOString();
        // The passage is cut with a little room before its first word and after its last, never into the words next to it.
        const range = paddedRange(candidate.startSeconds, candidate.endSeconds, transcript, metadata.durationSeconds);
        // Only when asked for: a few small pictures per second of the clip are checked for a face (which takes CPU time).
        let framing: FramingResult | undefined;
        if (options.framing === 'face') { const framingStarted = Date.now(); framing = await this.frameClip(jobId, sourcePath, range); framingMs += Date.now() - framingStarted; }
        const clip: GeneratedClip = { id: clipId, jobId, candidateId: candidate.id, startSeconds: range.startSeconds, endSeconds: range.endSeconds, durationSeconds: range.endSeconds - range.startSeconds, outputPath: join(jobId, outputFilename), outputFilename, status: 'queued', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now, title: candidate.title, score: candidate.score, reasons: candidate.reasons, framing: framing?.note ?? null };
        await this.db.createClip(clip); await this.db.updateClip(clipId, { status: 'processing' });
        try {
          // The .srt (short phrases) is kept with the clip; the .ass is the styled version that is burned into the picture, then thrown away.
          const captionStyle = options.captionStyle;
          let captionCount = 0; let styledCount = 0;
          if (captionStyle !== 'none') {
            captionCount = await writeSrtCaptions(captionPath, transcript, range.startSeconds, range.endSeconds);
            styledCount = await writeAssCaptions(styledCaptionPath, transcript, range.startSeconds, range.endSeconds, captionStyle);
          }
          const rendered = await this.clipRenderer.render({ sourcePath, startSeconds: range.startSeconds, endSeconds: range.endSeconds, outputPath, captionPath: styledCount ? styledCaptionPath : null, quality: options.quality, framing: framing?.followed ? framing.plan : null });
          await rm(styledCaptionPath, { force: true });
          await this.storage.upload(outputPath, clip.outputPath, 'video/mp4');
          if (captionCount) await this.storage.upload(captionPath, `${jobId}/${clipId}.srt`, 'application/x-subrip');
          await this.db.updateClip(clipId, { status: 'completed', durationSeconds: rendered.durationSeconds, errorMessage: null, captionPath }); completedCount += 1;
        } catch (error) {
          await rm(captionPath, { force: true }); await rm(styledCaptionPath, { force: true });
          const message = error instanceof Error ? error.message : 'Unexpected clip extraction failure'; await this.db.updateClip(clipId, { status: 'failed', errorMessage: message }); this.logger.error({ err: error, jobId, clipId, candidateId: candidate.id }, 'Clip extraction failed');
        }
        this.reportProgress(jobId, stageProgress('extracting_clips', (candidateNumber + 1) / candidates.length));
      }
      if (!completedCount) throw new Error(`Clip extraction failed for all ${candidates.length} ranked candidate(s).`);
      await this.progressWrites.get(jobId)?.catch(() => undefined);
      const stageTimings = this.clocks.get(jobId)?.finish() ?? {};
      await this.db.updateJob(jobId, { status: 'completed', stage: 'clip_extraction_complete', progress: 100, stageTimings });
      this.logger.info({ jobId, metadata, options, stageTimingsMs: stageTimings, totalMs: totalMilliseconds(stageTimings), transcriptSegmentCount: segments.length, highlightCandidateCount: highlights.length, completedClipCount: completedCount, ...(options.framing === 'face' ? { framingMs } : {}) }, 'Video processing, vertical rendering, and caption burn-in completed');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
