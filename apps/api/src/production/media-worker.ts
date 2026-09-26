import { execFile } from 'node:child_process';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ArtifactRef, AssetSpec, ProductionManifest, VoiceSpec } from './types.js';

const execFileAsync = promisify(execFile);

export interface MediaWorkerOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  outputDir: string;
  width?: number;
  height?: number;
}

export interface MediaRenderResult {
  video: ArtifactRef;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export class ProductionMediaWorker {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly width: number;
  private readonly height: number;

  constructor(private readonly options: MediaWorkerOptions) {
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.width = options.width ?? 1080;
    this.height = options.height ?? 1920;
  }

  async render(manifest: ProductionManifest, workDir: string): Promise<MediaRenderResult> {
    if (!manifest.scenes.length) throw new Error('Cannot render a production manifest without scenes.');
    await mkdir(workDir, { recursive: true });
    await mkdir(this.options.outputDir, { recursive: true });

    const sceneFiles: string[] = [];
    for (const scene of manifest.scenes) {
      const asset = manifest.assets.find((candidate) => candidate.sceneId === scene.id && candidate.localPath);
      if (!asset) throw new Error(`Scene ${scene.id} has no materialized local asset.`);
      const voice = manifest.voice.find((candidate) => candidate.sceneId === scene.id && candidate.localPath);
      if (!voice) throw new Error(`Scene ${scene.id} has no materialized local voice asset.`);
      const sceneOutput = join(workDir, `${scene.id}.mp4`);
      await this.renderScene(asset, voice, scene.estimatedDurationSeconds, sceneOutput);
      sceneFiles.push(sceneOutput);
    }

    const concatFile = join(workDir, 'concat.txt');
    const concat = sceneFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(concatFile, concat + '\n', 'utf8'));

    const outputPath = join(this.options.outputDir, `${manifest.jobId}.mp4`);
    await this.run(this.ffmpegPath, ['-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-movflags', '+faststart', outputPath], 30 * 60_000);
    const probe = await this.probe(outputPath);
    if (!probe.hasVideo || !probe.hasAudio) throw new Error('Final render is missing a required video or audio stream.');
    if (probe.width !== this.width || probe.height !== this.height) throw new Error(`Final render dimensions are ${probe.width}x${probe.height}; expected ${this.width}x${this.height}.`);

    const info = await stat(outputPath);
    if (info.size <= 0) throw new Error('Final render is empty.');
    return {
      video: { type: 'video', path: outputPath, sizeBytes: info.size },
      durationSeconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      hasVideo: probe.hasVideo,
    };
  }

  private async renderScene(asset: AssetSpec, voice: VoiceSpec, duration: number, outputPath: string) {
    const source = asset.localPath!;
    const audio = voice.localPath!;
    const safeDuration = Math.max(0.5, duration);
    const ext = source.toLowerCase().endsWith('.mp4') || source.toLowerCase().endsWith('.mov') ? 'video' : 'image';
    const args = ext === 'image'
      ? ['-nostdin', '-y', '-loop', '1', '-i', source, '-i', audio, '-t', safeDuration.toFixed(3), '-vf', this.imageFilter(), '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', outputPath]
      : ['-nostdin', '-y', '-i', source, '-i', audio, '-t', safeDuration.toFixed(3), '-vf', this.imageFilter(), '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', outputPath];
    await this.run(this.ffmpegPath, args, 10 * 60_000);
  }

  private imageFilter() {
    return `scale=${this.width}:${this.height}:force_original_aspect_ratio=increase,crop=${this.width}:${this.height},format=yuv420p`;
  }

  private async probe(path: string) {
    const { stdout } = await execFileAsync(this.ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
    const video = data.streams?.find((stream) => stream.codec_type === 'video');
    const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
    const durationSeconds = Number(data.format?.duration);
    if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('ffprobe could not read the rendered video.');
    return { durationSeconds, width: Number(video.width), height: Number(video.height), hasVideo: true, hasAudio: Boolean(audio) };
  }

  private async run(binary: string, args: string[], timeout: number) {
    try {
      await execFileAsync(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024, cwd: dirname(args.at(-1)!) });
    } catch (error) {
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).slice(-4000) : '';
      const detail = error instanceof Error ? error.message : 'Unknown media command failure';
      throw new Error(`${binary} failed: ${detail}${stderr ? `\n${stderr}` : ''}`);
    }
  }
}
