import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { TranscriptSegment } from './domain.js';

const execFileAsync = promisify(execFile);
export type TranscriptInput = Array<Omit<TranscriptSegment, 'id' | 'jobId' | 'createdAt'>>;
export interface TranscriptionEngine { transcribe(audioPath: string, workDir: string): Promise<TranscriptInput>; }

type WhisperJson = { transcription?: Array<{ text?: unknown; offsets?: { from?: unknown; to?: unknown }; timestamps?: { from?: unknown; to?: unknown } }> };

/** Parses whisper.cpp JSON output. Offset values are milliseconds; timestamp strings are a fallback. */
export function parseWhisperCppJson(raw: string): TranscriptInput {
  const document = JSON.parse(raw) as WhisperJson;
  if (!Array.isArray(document.transcription)) throw new Error('whisper.cpp did not produce a transcription array.');
  return document.transcription.map((item, segmentIndex) => {
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const startSeconds = parseTimestamp(item.offsets?.from ?? item.timestamps?.from);
    const endSeconds = parseTimestamp(item.offsets?.to ?? item.timestamps?.to);
    if (!text) throw new Error(`whisper.cpp returned an empty transcript segment at index ${segmentIndex}.`);
    if (startSeconds === undefined || endSeconds === undefined || endSeconds < startSeconds) throw new Error(`whisper.cpp returned invalid timestamps at segment ${segmentIndex}.`);
    return { segmentIndex, startSeconds, endSeconds, text };
  });
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value / 1000;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export class WhisperCppTranscriber implements TranscriptionEngine {
  constructor(private readonly executablePath: string, private readonly modelPath: string, private readonly language: string, private readonly timeoutMs: number) {}
  async transcribe(audioPath: string, workDir: string): Promise<TranscriptInput> {
    const outputBase = join(workDir, basename(audioPath, '.wav'));
    try {
      // Render's free service is CPU-only. Force whisper.cpp to stay on CPU instead of
      // attempting GPU initialization, which makes the process fail before transcription.
      await execFileAsync(this.executablePath, ['-m', this.modelPath, '-f', audioPath, '-l', this.language, '-ngl', '0', '-oj', '-of', outputBase], { timeout: this.timeoutMs, maxBuffer: 1024 * 1024, cwd: dirname(audioPath) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown whisper.cpp execution failure';
      throw new Error(`Local whisper.cpp transcription failed: ${detail}`);
    }
    try { return parseWhisperCppJson(await readFile(`${outputBase}.json`, 'utf8')); }
    catch (error) { const detail = error instanceof Error ? error.message : 'Unknown output parsing failure'; throw new Error(`Could not read whisper.cpp JSON output: ${detail}`); }
  }
}

export function createTranscriptionEngine(config: { TRANSCRIPTION_ENGINE: 'whisper_cpp'; WHISPER_CPP_PATH: string; WHISPER_MODEL_PATH: string; TRANSCRIPTION_LANGUAGE: string; TRANSCRIPTION_TIMEOUT_MS: number }): TranscriptionEngine {
  switch (config.TRANSCRIPTION_ENGINE) {
    case 'whisper_cpp': return new WhisperCppTranscriber(config.WHISPER_CPP_PATH, config.WHISPER_MODEL_PATH, config.TRANSCRIPTION_LANGUAGE, config.TRANSCRIPTION_TIMEOUT_MS);
  }
}
