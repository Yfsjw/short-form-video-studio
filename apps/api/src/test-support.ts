import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StoredObjectMissingError, type DurableStorage } from './storage.js';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `accept(probe())` is true and returns what the probe saw; on timeout it fails and says what it last saw.
 * Background work (a job's clean-up, an abandoned upload being discarded) finishes a moment after the event a test
 * can observe, so tests wait for the outcome instead of assuming it is already there or sleeping for a guessed time.
 */
export async function eventually<T>(description: string, probe: () => T | Promise<T>, accept: (seen: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await probe();
    if (accept(seen)) return seen;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description} (last seen: ${JSON.stringify(seen)})`);
    await sleep(20);
  }
}

/** Durable storage kept in memory (a stand-in for Cloudflare R2 in tests), recording everything it is asked to do. */
export class MemoryStorage implements DurableStorage {
  readonly isDurable = true;
  /** What is stored right now. */
  readonly objects = new Map<string, Buffer>();
  /** Everything that was ever uploaded (what it contained when it arrived), even if it has since been deleted. */
  readonly uploaded = new Map<string, Buffer>();
  readonly log: string[] = [];
  /** Make every upload fail, like a storage outage. */
  failUploads = false;
  /** Make every delete fail. */
  failDeletes = false;
  /** Make every download fail (the objects are still there), like a storage outage that stops reads. */
  failDownloads = false;
  /** When set, every delete waits for this to settle before it does anything: a storage service that has stopped answering. */
  holdDeletes: Promise<void> | undefined;
  async upload(localPath: string, key: string) {
    this.log.push(`upload:${key}`);
    if (this.failUploads) throw new Error('simulated storage outage');
    const data = await readFile(localPath);
    this.objects.set(key, data);
    this.uploaded.set(key, data);
  }
  async download(key: string, localPath: string) {
    this.log.push(`download:${key}`);
    if (this.failDownloads) throw new Error('simulated storage outage');
    const data = this.objects.get(key);
    if (!data) throw new StoredObjectMissingError(`no such object ${key}`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, data);
  }
  async delete(key: string) {
    this.log.push(`delete:${key}`);
    if (this.holdDeletes) await this.holdDeletes;
    if (this.failDeletes) throw new Error('simulated storage outage');
    this.objects.delete(key);
  }
  async selfTest() { /* always healthy */ }
  async getDownloadUrl(key: string) { return `https://storage.test/${key}`; }
}

// ---------------------------------------------------------------------------------------------------------------------------
// A stand-in for whisper.cpp that behaves like the real program for the recording of speech that comes with the program.

const piece = (text: string, from: number, to: number) => ({ text, timestamps: { from: '00:00:00,000', to: '00:00:00,000' }, offsets: { from, to }, id: 1, p: 0.9, t_dtw: -1 });

/**
 * What whisper.cpp's full JSON (`-ojf`) holds for the 11 s recording: one segment of text and, when `tokens` is not false, every word as a piece with
 * its own times (milliseconds, spread evenly from `from` to `to` seconds), between the special pieces whisper.cpp puts around the words.
 */
export function speechSampleJson(options: { text?: string; tokens?: boolean; from?: number; to?: number } = {}): string {
  const text = options.text ?? 'And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.';
  const words = text.split(/\s+/);
  const from = options.from ?? 0.2; const step = ((options.to ?? 10.4) - from) / words.length;
  const tokens = options.tokens === false ? undefined : [piece('[_BEG_]', 0, 0), ...words.map((word, index) => piece(` ${word}`, Math.round((from + index * step) * 1000), Math.round((from + (index + 1) * step) * 1000))), piece('[_TT_550]', 11_000, 11_000)];
  return JSON.stringify({
    systeminfo: 'AVX = 1', model: { type: 'base' }, params: { language: 'en', translate: false }, result: { language: 'en' },
    transcription: [{ timestamps: { from: '00:00:00,000', to: '00:00:11,000' }, offsets: { from: 0, to: 11_000 }, text: ` ${text}`, ...(tokens ? { tokens } : {}) }],
  });
}

/**
 * A stand-in for the whisper.cpp program: it prints its usage text for `--help` and otherwise runs `body` (a shell script that knows `$base`, the
 * output name it was given with `-of`), by default writing `json` there. Every start for a recording is noted, one line each, in `argsLog`.
 */
export async function writeFakeWhisper(path: string, options: { json?: string; body?: string; argsLog?: string } = {}): Promise<void> {
  const body = options.body ?? `cat > "$base.json" <<'JSON'\n${options.json ?? speechSampleJson()}\nJSON`;
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "usage: ./whisper-cli [options] file0.wav"; exit 0; fi\nbase=""\nargs="$*"\nwhile [ $# -gt 0 ]; do case "$1" in -of) base="$2"; shift;; esac; shift; done\n${options.argsLog ? `echo "$args" >> '${options.argsLog}'\n` : ''}${body}\n`, { mode: 0o755 });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Real programs that take their time, for the tests of calling work off.

/** Whether a process with this number is still there. */
export const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A program that is started and does nothing for a minute, like a long FFmpeg or whisper.cpp run. */
export interface WaitingProgram {
  /** Its path: what a test gives to the code that is to start it. */
  path: string;
  /** Whether it has been started (it notes its process number in a file the moment it begins). */
  started(): Promise<boolean>;
  /** The number of its process (once it has been started). */
  pid(): Promise<number>;
}

/**
 * Makes programs that wait for a minute and then end by themselves, in `directory`. One that `ignoresTerm` also ignores the polite request to end
 * (SIGTERM), as a program that is busy may, and only a kill (SIGKILL) ends it. `killAll` ends every one that is still there, for the end of a test file.
 */
export function waitingPrograms(directory: string) {
  let made = 0; const all: WaitingProgram[] = [];
  return {
    async make(options: { ignoresTerm?: boolean } = {}): Promise<WaitingProgram> {
      made += 1;
      const path = join(directory, `waiting-${made}.sh`); const pidFile = join(directory, `waiting-${made}.pid`);
      // `exec` makes the waiting the very process that was started, so there is nothing left behind when it is killed.
      const body = options.ignoresTerm
        ? `trap '' TERM\necho $$ > '${pidFile}'\ni=0\nwhile [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done\n`
        : `echo $$ > '${pidFile}'\nexec sleep 60\n`;
      await writeFile(path, `#!/bin/sh\n${body}`);
      await chmod(path, 0o755);
      const read = async () => { try { const text = (await readFile(pidFile, 'utf8')).trim(); return /^\d+$/.test(text) ? Number(text) : undefined; } catch { return undefined; } };
      const program: WaitingProgram = { path, started: async () => (await read()) !== undefined, pid: async () => (await read())! };
      all.push(program);
      return program;
    },
    async killAll() {
      for (const program of all) { try { process.kill(await program.pid(), 'SIGKILL'); } catch { /* it is gone, or never started */ } }
    },
  };
}
