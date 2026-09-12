import { writeFile } from 'node:fs/promises';

export interface CaptionSegmentInput {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/** Builds a UTF-8 SRT file with clip-relative timestamps. */
export async function writeSrtCaptions(path: string, segments: CaptionSegmentInput[], clipStartSeconds: number, clipEndSeconds: number) {
  const relevant = segments
    .filter((segment) => segment.endSeconds > clipStartSeconds && segment.startSeconds < clipEndSeconds && segment.text.trim())
    .map((segment) => ({
      startSeconds: Math.max(segment.startSeconds, clipStartSeconds) - clipStartSeconds,
      endSeconds: Math.min(segment.endSeconds, clipEndSeconds) - clipStartSeconds,
      text: segment.text.trim(),
    }))
    .filter((segment) => segment.endSeconds > segment.startSeconds);

  const body = relevant.map((segment, index) => `${index + 1}\n${formatSrtTime(segment.startSeconds)} --> ${formatSrtTime(segment.endSeconds)}\n${segment.text}\n`).join('\n');
  await writeFile(path, body, 'utf8');
  return relevant.length;
}

export function formatSrtTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

function pad(value: number, width: number) { return String(value).padStart(width, '0'); }
