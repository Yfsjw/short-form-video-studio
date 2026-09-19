import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { StudioDatabase } from './database.js';
import type { FfmpegAdapter } from './ffmpeg.js';
import type { TranscriptionEngine } from './transcription.js';
import type { HighlightDetector, HighlightOptions } from './highlights.js';
import type { ClipRenderer } from './clips.js';
import type { GeneratedClip } from './domain.js';
import { writeSrtCaptions } from './captions.js';
import type { DurableStorage } from './storage.js';

type PipelineStore = Pick<StudioDatabase, 'getJob' | 'updateJob' | 'replaceTranscript' | 'listTranscript' | 'replaceHighlights' | 'listHighlights' | 'createClip' | 'updateClip'>;
type MediaProcessor = Pick<FfmpegAdapter, 'probe' | 'extractAudio'>;

/** Orchestrates real processing stages, including 9:16 rendering and transcript-synced captions. */
export class VideoPipeline {
  constructor(private readonly db: PipelineStore, private readonly ffmpeg: MediaProcessor, private readonly transcriber: TranscriptionEngine, private readonly highlightDetector: HighlightDetector, private readonly highlightOptions: HighlightOptions, private readonly clipRenderer: ClipRenderer, private readonly maxClipCandidates: number, private readonly uploadDir: string, private readonly tempDir: string, private readonly outputDir: string, private readonly logger: Pick<Logger, 'info' | 'error'>, private readonly storage: DurableStorage) {}
  enqueue(jobId: string) { void this.run(jobId); }
  async run(jobId: string) {
    const job = await this.db.getJob(jobId); if (!job) return;
    try {
      await this.db.updateJob(jobId, { status: 'processing', stage: 'probing_video', errorMessage: null });
      const metadata = await this.ffmpeg.probe(join(this.uploadDir, job.storedFilename));
      await this.db.updateJob(jobId, { stage: 'extracting_audio', ...metadata });
      const workDir = await mkdtemp(join(this.tempDir, `${jobId}-`));
      try {
        const audioPath = join(workDir, 'audio.wav');
        await this.ffmpeg.extractAudio(join(this.uploadDir, job.storedFilename), audioPath);
        await this.db.updateJob(jobId, { stage: 'transcribing' });
        const segments = await this.transcriber.transcribe(audioPath, workDir);
        await this.db.replaceTranscript(jobId, segments);
        await this.db.updateJob(jobId, { stage: 'detecting_highlights' });
        const highlights = this.highlightDetector.detect({ segments: await this.db.listTranscript(jobId), durationSeconds: metadata.durationSeconds, metadata: { width: metadata.width, height: metadata.height }, options: this.highlightOptions });
        await this.db.replaceHighlights(jobId, highlights);
        const candidates = (await this.db.listHighlights(jobId)).slice(0, this.maxClipCandidates);
        if (!candidates.length) throw new Error('Highlight detection produced no valid candidate ranges for clip extraction.');
        await this.db.updateJob(jobId, { stage: 'extracting_clips' });
        const jobOutputDir = join(this.outputDir, jobId); await mkdir(jobOutputDir, { recursive: true });
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
            const rendered = await this.clipRenderer.render({ sourcePath: join(this.uploadDir, job.storedFilename), startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds, outputPath, captionPath: captionCount ? captionPath : null });
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected processing failure';
      await this.db.updateJob(jobId, { status: 'failed', stage: 'failed', errorMessage: message });
      this.logger.error({ err: error, jobId }, 'Video processing failed');
    }
  }
}
