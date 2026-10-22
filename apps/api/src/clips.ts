import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { QualityChoice } from './domain.js';
import { cropXExpression, type FramingPlan } from './framing.js';
import { outputSizeFor } from './options.js';

const execFileAsync = promisify(execFile);

/**
 * The font the captions are drawn with ships with the program (apps/api/assets/fonts, with its licence) instead of being looked up on the
 * server: a server without the font would draw captions in whatever it has, or with missing letters. The same relative path works for the
 * source files (src/) and the compiled ones (dist/).
 */
export const BUNDLED_FONTS_DIRECTORY = fileURLToPath(new URL('../assets/fonts', import.meta.url));
export interface ClipRenderRequest {
  sourcePath: string; startSeconds: number; endSeconds: number; outputPath: string; captionPath?: string | null;
  /** `standard` renders at two thirds of the configured size; the default is the configured size. */
  quality?: QualityChoice;
  /** Where the picture of the clip is cut from when the video is wider than the clip: a path over the clip's own time (see framing.ts). Without it, from the middle. */
  framing?: FramingPlan | null;
}
export interface RenderedClip { durationSeconds: number; sizeBytes: number; }
export interface ClipRenderer { render(request: ClipRenderRequest): Promise<RenderedClip>; }
export type FfmpegRunner = (binary: string, arguments_: string[], options: { maxBuffer: number; timeout: number; cwd: string }) => Promise<void>;

/** FFmpeg renderer for platform-ready 9:16 MP4 clips with optional burned-in captions. */
export class FfmpegClipRenderer implements ClipRenderer {
  constructor(
    private readonly ffmpegPath: string,
    private readonly videoCodec: string,
    private readonly audioCodec: string,
    private readonly crf: number,
    private readonly preset: string,
    private readonly verticalWidth: number,
    private readonly verticalHeight: number,
    private readonly runner: FfmpegRunner = async (binary, arguments_, options) => { await execFileAsync(binary, arguments_, options); },
    private readonly fontsDirectory: string = BUNDLED_FONTS_DIRECTORY,
  ) {}

  async render(request: ClipRenderRequest): Promise<RenderedClip> {
    const durationSeconds = request.endSeconds - request.startSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Clip range must have a positive duration.');
    const size = outputSizeFor({ width: this.verticalWidth, height: this.verticalHeight }, request.quality ?? 'hd');
    const videoFilter = this.buildVideoFilter(request.captionPath, size, request.framing);
    const args = [
      // `-ss` goes BEFORE `-i` on purpose. Placed after it, FFmpeg decodes everything from the start of the file and cuts at the very end
      // of the filter chain, so the caption filter would see the ORIGINAL timeline (a clip that starts 40 s into the video would look for
      // its captions at 40 s onwards while ours are counted from the start of the clip, and they would never show up or show at the wrong
      // moment). Placed before it, the seek is still frame-accurate, the clip's own timeline starts at 0, and a clip deep inside a long video
      // no longer costs the time of decoding everything before it.
      '-nostdin', '-y', '-ss', request.startSeconds.toFixed(3), '-i', request.sourcePath,
      '-t', durationSeconds.toFixed(3),
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', videoFilter,
      '-c:v', this.videoCodec, '-preset', this.preset, '-crf', String(this.crf),
      '-c:a', this.audioCodec, '-movflags', '+faststart', request.outputPath,
    ];
    try {
      await this.runner(this.ffmpegPath, args, { maxBuffer: 4 * 1024 * 1024, timeout: 30 * 60_000, cwd: dirname(request.outputPath) });
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

  private buildVideoFilter(captionPath: string | null | undefined, size: { width: number; height: number }, framing?: FramingPlan | null) {
    // The picture is enlarged until it covers the clip, and the clip is cut out of it: from the middle, unless a plan says where the window
    // goes at every moment (its `x` is an expression FFmpeg works out for every frame from `t`, the time counted from the start of the clip).
    const window = framing ? `crop=${size.width}:${size.height}:x='${cropXExpression(framing.keyframes)}':y='(in_h-out_h)/2'` : `crop=${size.width}:${size.height}`;
    const crop = `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,${window}`;
    if (!captionPath) return crop;
    const escapedPath = escapeFilterPath(captionPath);
    // A styled caption file (.ass) brings its own look and is drawn with the bundled font; a plain .srt gets the fixed look below.
    if (captionPath.toLowerCase().endsWith('.ass')) return `${crop},ass='${escapedPath}':fontsdir='${escapeFilterPath(this.fontsDirectory)}'`;
    return `${crop},subtitles='${escapedPath}':force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=110'`;
  }
}

function escapeFilterPath(path: string) {
  return path.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

export function isSafeClipIdentifier(value: string) { return /^[a-f0-9-]{36}$/i.test(value); }
export function resolveClipOutputPath(outputDir: string, jobId: string, clipId: string, outputFilename: string) {
  if (!isSafeClipIdentifier(jobId) || !isSafeClipIdentifier(clipId) || outputFilename !== `${clipId}.mp4`) return undefined;
  const jobDirectory = resolve(outputDir, jobId); const outputPath = resolve(jobDirectory, outputFilename);
  return outputPath.startsWith(`${jobDirectory}/`) ? outputPath : undefined;
}
