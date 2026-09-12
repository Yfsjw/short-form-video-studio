import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export interface ClipRenderRequest { sourcePath: string; startSeconds: number; endSeconds: number; outputPath: string; }
export interface RenderedClip { durationSeconds: number; sizeBytes: number; }
export interface ClipRenderer { render(request: ClipRenderRequest): Promise<RenderedClip>; }
export type FfmpegRunner = (binary: string, arguments_: string[], options: { maxBuffer: number; timeout: number; cwd: string }) => Promise<void>;

/** FFmpeg renderer: decodes from the requested timestamp and re-encodes browser-compatible MP4. */
export class FfmpegClipRenderer implements ClipRenderer {
  constructor(private readonly ffmpegPath: string, private readonly videoCodec: string, private readonly audioCodec: string, private readonly crf: number, private readonly preset: string, private readonly runner: FfmpegRunner = async (binary, arguments_, options) => { await execFileAsync(binary, arguments_, options); }) {}
  async render(request: ClipRenderRequest): Promise<RenderedClip> {
    const durationSeconds = request.endSeconds - request.startSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Clip range must have a positive duration.');
    try {
      await this.runner(this.ffmpegPath, ['-nostdin', '-y', '-i', request.sourcePath, '-ss', request.startSeconds.toFixed(3), '-t', durationSeconds.toFixed(3), '-map', '0:v:0', '-map', '0:a?', '-c:v', this.videoCodec, '-preset', this.preset, '-crf', String(this.crf), '-c:a', this.audioCodec, '-movflags', '+faststart', request.outputPath], { maxBuffer: 4 * 1024 * 1024, timeout: 30 * 60_000, cwd: dirname(request.outputPath) });
      const info = await stat(request.outputPath);
      if (!info.isFile() || info.size <= 0) throw new Error('FFmpeg completed without producing a non-empty MP4 file.');
      return { durationSeconds, sizeBytes: info.size };
    } catch (error) {
      await rm(request.outputPath, { force: true });
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).trim().slice(-2000) : '';
      const detail = error instanceof Error ? error.message : 'Unknown FFmpeg execution failure';
      throw new Error(`Clip extraction failed: ${detail}${stderr ? `; ffmpeg: ${stderr}` : ''}`);
    }
  }
}

export function isSafeClipIdentifier(value: string) { return /^[a-f0-9-]{36}$/i.test(value); }
export function resolveClipOutputPath(outputDir: string, jobId: string, clipId: string, outputFilename: string) {
  if (!isSafeClipIdentifier(jobId) || !isSafeClipIdentifier(clipId) || outputFilename !== `${clipId}.mp4`) return undefined;
  const jobDirectory = resolve(outputDir, jobId); const outputPath = resolve(jobDirectory, outputFilename);
  return outputPath.startsWith(`${jobDirectory}/`) ? outputPath : undefined;
}
