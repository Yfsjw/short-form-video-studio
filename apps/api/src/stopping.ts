import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Helpers for the work that can be called off. A job that a person stops has an AbortSignal (see `VideoPipeline.stop`); the programs and the
 * waits that the job is made of end as soon as it is aborted, and what they fail with is then the reason of the signal, never a failure of
 * their own (a video that "could not be read" because FFmpeg was ended would be a lie).
 */

const execFileAsync = promisify(execFile);

/**
 * Runs a program like `execFile` and kills it, at once and for good (SIGKILL), the moment `signal` is aborted: whatever a stopped job was making is
 * thrown away, so there is nothing to finish tidily. `execFile`'s own `signal` option is not used on purpose: it only asks the program to end (SIGTERM),
 * which a program can ignore or take its time over, and the job would then be told as stopped with a program still running behind it. A program that
 * was killed fails as `execFile` fails; whoever called this looks at the signal to tell that the stop is the reason (and then fails with its reason).
 * A signal that is aborted already never starts the program.
 */
export async function execFileUntilStopped(file: string, args: readonly string[], options: { timeout: number; maxBuffer: number; cwd?: string }, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const running = execFileAsync(file, [...args], { ...options, encoding: 'utf8' });
  if (!signal) return running;
  const callOff = () => { running.child.kill('SIGKILL'); };
  signal.addEventListener('abort', callOff, { once: true });
  try { return await running; }
  finally { signal.removeEventListener('abort', callOff); }
}

/** Waits `ms` milliseconds with `sleep` (the clock, which tests replace), or fails with the reason of `signal` as soon as it is aborted. */
export async function waitOrStop(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
  try { await Promise.race([sleep(ms), aborted]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}
