import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export interface VideoMetadata { durationSeconds: number; width: number; height: number; }
export class FfmpegAdapter {
  /** Keep both binary locations here so extraction/reframing can be added without changing callers. */
  constructor(private readonly ffprobePath: string, readonly ffmpegPath: string) {}
  async probe(inputPath: string): Promise<VideoMetadata> {
    const { stdout } = await execFileAsync(this.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', inputPath], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number }> };
    const stream = data.streams?.[0]; const durationSeconds = Number(data.format?.duration);
    if (!stream?.width || !stream.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('The file does not contain a readable video stream.');
    return { durationSeconds, width: stream.width, height: stream.height };
  }
  async extractAudio(inputPath: string, outputPath: string): Promise<void> {
    try {
      await execFileAsync(this.ffmpegPath, ['-nostdin', '-y', '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath], { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown FFmpeg execution failure';
      throw new Error(`Could not extract mono 16 kHz WAV audio: ${detail}`);
    }
  }
}
