import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { TranscriptSegment } from './domain.js';
import { wordsFromTokens, type RawToken } from './words.js';

export type TranscriptInput = Array<Omit<TranscriptSegment, 'id' | 'jobId' | 'createdAt'>>;
export interface TranscriptionEngine {
  /** `onProgress` (optional) is told how far along the work is, as a fraction from 0 to 1, whenever the engine knows. */
  transcribe(audioPath: string, workDir: string, onProgress?: (fraction: number) => void): Promise<TranscriptInput>;
}

type WhisperTimes = { offsets?: { from?: unknown; to?: unknown }; timestamps?: { from?: unknown; to?: unknown } };
type WhisperJson = { transcription?: Array<WhisperTimes & { text?: unknown; tokens?: unknown }> };

/** The pieces of one segment from whisper.cpp's full JSON (`-ojf`), with the times it reported for each. */
function readTokens(tokens: unknown): RawToken[] {
  if (!Array.isArray(tokens)) return [];
  return tokens.flatMap((token: WhisperTimes & { text?: unknown }) => {
    if (!token || typeof token !== 'object' || typeof token.text !== 'string') return [];
    return [{ text: token.text, startSeconds: parseTimestamp(token.offsets?.from ?? token.timestamps?.from), endSeconds: parseTimestamp(token.offsets?.to ?? token.timestamps?.to) }];
  });
}

/** Parses whisper.cpp JSON output (plain or full). Offset values are milliseconds; timestamp strings are a fallback. A segment gets `words` only when the output has usable per-word timing. */
export function parseWhisperCppJson(raw: string): TranscriptInput {
  const document = JSON.parse(raw) as WhisperJson;
  if (!Array.isArray(document.transcription)) throw new Error('whisper.cpp did not produce a transcription array.');
  return document.transcription.map((item, segmentIndex) => {
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const startSeconds = parseTimestamp(item.offsets?.from ?? item.timestamps?.from);
    const endSeconds = parseTimestamp(item.offsets?.to ?? item.timestamps?.to);
    if (!text) throw new Error(`whisper.cpp returned an empty transcript segment at index ${segmentIndex}.`);
    if (startSeconds === undefined || endSeconds === undefined || endSeconds < startSeconds) throw new Error(`whisper.cpp returned invalid timestamps at segment ${segmentIndex}.`);
    const words = wordsFromTokens(readTokens(item.tokens), startSeconds, endSeconds);
    return words ? { segmentIndex, startSeconds, endSeconds, text, words } : { segmentIndex, startSeconds, endSeconds, text };
  });
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value / 1000;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

/** How much of a program's output is kept for error messages: the end of it, which is where the reason for a failure is. */
const KEPT_OUTPUT_CHARS = 64 * 1024;

/**
 * Runs a program and hands everything it prints on stderr to `onStderr` as it happens (so progress can be followed),
 * keeping only the tail of both outputs. Unlike execFile with a size limit, a program that prints a lot is not killed for it.
 * A failure carries `stdout` and `stderr`, like execFile's.
 */
export function runProgram(executable: string, args: string[], options: { cwd: string; timeoutMs: number; onStderr?: (text: string) => void }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false; let finished = false;
    const keepTail = (kept: string, text: string) => { const joined = kept + text; return joined.length > KEPT_OUTPUT_CHARS ? joined.slice(-KEPT_OUTPUT_CHARS) : joined; };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout = keepTail(stdout, text); });
    child.stderr.on('data', (text: string) => { stderr = keepTail(stderr, text); try { options.onStderr?.(text); } catch { /* a listener must never break the run */ } });
    const fail = (message: string) => { if (finished) return; finished = true; clearTimeout(timer); reject(Object.assign(new Error(message), { stdout, stderr })); };
    child.on('error', (error) => fail(`Could not start ${executable}: ${error.message}`));
    child.on('close', (code, signal) => {
      if (finished) return;
      if (timedOut) return fail(`${basename(executable)} was stopped after the ${Math.round(options.timeoutMs / 1000)} s time limit`);
      if (code !== 0) return fail(`Command failed: ${basename(executable)} (${signal ? `signal ${signal}` : `exit code ${code}`})`);
      finished = true; clearTimeout(timer); resolve({ stdout, stderr });
    });
  });
}

/** Follows whisper.cpp's `-pp` lines ("progress =  45%") in the text it prints, even when a line arrives in pieces. */
export function createProgressListener(onProgress: ((fraction: number) => void) | undefined) {
  let carry = '';
  let highest = -1;
  return (text: string) => {
    if (!onProgress) return;
    carry += text;
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const match = /progress\s*=\s*(\d{1,3})\s*%/.exec(line);
      if (!match) continue;
      const percent = Math.min(100, Number(match[1]));
      if (percent > highest) { highest = percent; onProgress(percent / 100); }
    }
  };
}

function trimDiagnostic(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '(no output)';
  return trimmed.length > 4000 ? `${trimmed.slice(-4000)}\n...[truncated]` : trimmed;
}

export class WhisperCppTranscriber implements TranscriptionEngine {
  constructor(private readonly executablePath: string, private readonly modelPath: string, private readonly language: string, private readonly timeoutMs: number) {}
  async transcribe(audioPath: string, workDir: string, onProgress?: (fraction: number) => void): Promise<TranscriptInput> {
    const outputBase = join(workDir, basename(audioPath, '.wav'));
    let stdout = '';
    let stderr = '';
    try {
      // Render's free service is CPU-only. Force whisper.cpp to stay on CPU instead of
      // attempting GPU initialization, which makes the process fail before transcription.
      // `-pp` makes whisper.cpp report its percentage on stderr, which is what the progress bar follows.
      // `-ojf` writes the JSON with the pieces of every segment and their own times (that is what makes word-by-word captions possible).
      const result = await runProgram(this.executablePath, ['-m', this.modelPath, '-f', audioPath, '-l', this.language, '-ng', '-nfa', '-pp', '-ojf', '-of', outputBase], { timeoutMs: this.timeoutMs, cwd: dirname(audioPath), onStderr: createProgressListener(onProgress) });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const execError = error as { message?: string; stdout?: string; stderr?: string };
      stdout = typeof execError.stdout === 'string' ? execError.stdout : '';
      stderr = typeof execError.stderr === 'string' ? execError.stderr : '';
      const detail = execError.message ?? 'Unknown whisper.cpp execution failure';
      throw new Error(`Local whisper.cpp transcription failed: ${detail}\nwhisper stdout:\n${trimDiagnostic(stdout)}\nwhisper stderr:\n${trimDiagnostic(stderr)}`);
    }

    try {
      await access(`${outputBase}.json`);
    } catch {
      throw new Error(`whisper.cpp exited without creating JSON output.\naudio: ${audioPath}\noutput: ${outputBase}.json\nwhisper stdout:\n${trimDiagnostic(stdout)}\nwhisper stderr:\n${trimDiagnostic(stderr)}`);
    }

    try { return parseWhisperCppJson(await readFile(`${outputBase}.json`, 'utf8')); }
    catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown output parsing failure';
      throw new Error(`Could not read whisper.cpp JSON output: ${detail}\nwhisper stdout:\n${trimDiagnostic(stdout)}\nwhisper stderr:\n${trimDiagnostic(stderr)}`);
    }
  }
}
