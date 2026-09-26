import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { QcReport } from './types.js';

const execFileAsync = promisify(execFile);

export async function inspectRenderedVideo(
  videoPath: string,
  expectedWidth = 1080,
  expectedHeight = 1920,
): Promise<QcReport> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; codec_name?: string }>; format?: { duration?: string; format_name?: string } };
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(data.format?.duration);
  const checks = [
    { name: 'file_has_video', passed: Boolean(video), details: video ? `codec=${video.codec_name ?? 'unknown'}` : 'No video stream' },
    { name: 'file_has_audio', passed: Boolean(audio), details: audio ? `codec=${audio.codec_name ?? 'unknown'}` : 'No audio stream' },
    { name: 'vertical_1080x1920', passed: video?.width === expectedWidth && video?.height === expectedHeight, details: `${video?.width ?? 0}x${video?.height ?? 0}` },
    { name: 'positive_duration', passed: Number.isFinite(durationSeconds) && durationSeconds > 0, details: `${durationSeconds}s` },
    { name: 'mp4_container', passed: (data.format?.format_name ?? '').split(',').includes('mov,mp4,m4a,3gp,3g2,mj2') || (data.format?.format_name ?? '').includes('mp4'), details: data.format?.format_name ?? 'unknown' },
  ];
  return {
    passed: checks.every((check) => check.passed),
    durationSeconds,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    checks,
  };
}
