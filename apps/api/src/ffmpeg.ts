import { PlainFailure, plainWords } from './failures.js';
import { execFileUntilStopped } from './stopping.js';
import { hdrKindOf, type HdrKind } from './hdr.js';

export interface VideoMetadata { durationSeconds: number; width: number; height: number; }
/**
 * What looking at a file tells: its size and length, whether it has any sound at all (left out by a stand-in that does not know), and the kind of
 * HDR its picture is in when it is (left out for an ordinary picture).
 */
export type ProbeResult = VideoMetadata & { hasAudio?: boolean; hdr?: HdrKind };

/** A program that is not there is the server's problem, not the video's: it must not be told as "this file could not be read". */
const isMissingProgram = (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

export class FfmpegAdapter {
  /** Keep both binary locations here so extraction/reframing can be added without changing callers. */
  constructor(private readonly ffprobePath: string, readonly ffmpegPath: string) {}
  /** `signal` (optional) kills the program when it is aborted, and then the failure is its reason (a stopped job is not an unreadable video). */
  async probe(inputPath: string, signal?: AbortSignal): Promise<ProbeResult> {
    let data: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; color_transfer?: string }> };
    try {
      // Every stream is listed (not only the first video stream) so that one look also tells whether the file has sound.
      const { stdout } = await execFileUntilStopped(this.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,color_transfer', '-of', 'json', inputPath], { timeout: 30_000, maxBuffer: 1024 * 1024 }, signal);
      data = JSON.parse(stdout) as typeof data;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isMissingProgram(error)) throw error;
      throw new PlainFailure(plainWords.unreadableVideo, { cause: error });
    }
    const streams = data.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video'); const durationSeconds = Number(data.format?.duration);
    if (!video?.width || !video.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new PlainFailure(plainWords.unreadableVideo, { cause: new Error('the file does not contain a readable video stream') });
    const hdr = hdrKindOf(video.color_transfer);
    return { durationSeconds, width: video.width, height: video.height, hasAudio: streams.some((stream) => stream.codec_type === 'audio'), ...(hdr ? { hdr } : {}) };
  }
  async extractAudio(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    try {
      await execFileUntilStopped(this.ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath], { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 }, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isMissingProgram(error)) throw error;
      throw new PlainFailure(plainWords.unreadableSound, { cause: error });
    }
  }
}
