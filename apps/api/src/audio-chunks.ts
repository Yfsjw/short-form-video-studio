import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runProgram } from './transcription.js';

const execFileAsync = promisify(execFile);

/** A stretch of silence in the audio, in seconds. */
export interface Silence { startSeconds: number; endSeconds: number; }
/** A piece of the audio to be sent on its own, in seconds from the start of the whole. */
export interface ChunkPlan { startSeconds: number; endSeconds: number; }

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Reads the silences from what FFmpeg's `silencedetect` filter prints ("silence_start: 5.2", "silence_end: 6.4 | silence_duration: 1.2").
 * A silence that is still going when the audio ends has no end and is left out: nobody needs to cut there.
 */
export function parseSilences(text: string): Silence[] {
  const silences: Silence[] = [];
  let started: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) { started = Math.max(0, Number(start[1])); continue; }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end && started !== null) { const endSeconds = Number(end[1]); if (endSeconds > started) silences.push({ startSeconds: started, endSeconds }); started = null; }
  }
  return silences;
}

/**
 * How to cut audio into pieces of about `targetSeconds` for a service that takes a limited amount at a time. Every cut is made in the
 * middle of the longest silence close to where the piece should end (so no word is cut in half); where there is no silence to be found
 * the cut is made at the target. The pieces follow each other exactly, none is shorter than about 70 % of the target, none is longer
 * than about 130 % of it (at most 60 s over), and audio that fits in one piece is not cut at all.
 */
export function planChunks(durationSeconds: number, silences: Silence[], targetSeconds: number): ChunkPlan[] {
  if (!(durationSeconds > 0)) return [];
  const target = Math.max(1, targetSeconds);
  const reach = Math.min(target * 0.3, 60);
  const plan: ChunkPlan[] = [];
  let start = 0;
  while (durationSeconds - start > target + reach) {
    const desired = start + target;
    let best: Silence | null = null;
    for (const silence of silences) {
      const middle = (silence.startSeconds + silence.endSeconds) / 2;
      if (middle < desired - reach || middle > desired + reach || middle <= start) continue;
      const length = silence.endSeconds - silence.startSeconds;
      const bestLength = best ? best.endSeconds - best.startSeconds : -1;
      if (length > bestLength || (length === bestLength && best && Math.abs(middle - desired) < Math.abs((best.startSeconds + best.endSeconds) / 2 - desired))) best = silence;
    }
    const cut = round(best ? (best.startSeconds + best.endSeconds) / 2 : desired);
    plan.push({ startSeconds: round(start), endSeconds: cut });
    start = cut;
  }
  plan.push({ startSeconds: round(start), endSeconds: round(durationSeconds) });
  return plan;
}

/** The silences of an audio file: pauses of at least `minSeconds` that are quieter than `noiseDb`. */
export async function detectSilences(ffmpegPath: string, audioPath: string, options: { noiseDb?: number; minSeconds?: number; timeoutMs?: number } = {}): Promise<Silence[]> {
  const noise = options.noiseDb ?? -35; const minimum = options.minSeconds ?? 0.3;
  let carry = ''; const lines: string[] = [];
  // The report is read as it is printed: a long recording has thousands of lines, more than the tail runProgram would keep.
  const onStderr = (text: string) => {
    carry += text;
    const parts = carry.split(/\r?\n/);
    carry = parts.pop() ?? '';
    for (const line of parts) if (line.includes('silence_')) lines.push(line);
  };
  await runProgram(ffmpegPath, ['-nostdin', '-hide_banner', '-i', audioPath, '-vn', '-af', `silencedetect=noise=${noise}dB:d=${minimum}`, '-f', 'null', '-'], { cwd: process.cwd(), timeoutMs: options.timeoutMs ?? 5 * 60_000, onStderr });
  if (carry.includes('silence_')) lines.push(carry);
  return parseSilences(lines.join('\n'));
}

/** Writes one piece of the audio as compressed mono speech (AAC at 48 kbit/s in an .m4a file, about 21 MB per hour). */
export async function encodeChunk(ffmpegPath: string, audioPath: string, chunk: ChunkPlan, outputPath: string, timeoutMs = 2 * 60_000): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(chunk.startSeconds), '-t', String(round(chunk.endSeconds - chunk.startSeconds)), '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', outputPath], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new Error(`Could not prepare the audio for the speech recognition service: ${error instanceof Error ? error.message : 'unknown FFmpeg failure'}`);
  }
}

/** How long an audio file lasts, in seconds. */
export async function audioDuration(ffprobePath: string, audioPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const seconds = Number(stdout.trim());
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  } catch { /* reported below */ }
  throw new Error('Could not read how long the audio is.');
}
