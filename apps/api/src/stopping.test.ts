import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { audioDuration, detectSilences, encodeChunk } from './audio-chunks.js';
import { FfmpegClipRenderer, type FfmpegRunner } from './clips.js';
import { JobStopped, PlainFailure } from './failures.js';
import { FaceClipFramer } from './face-track.js';
import { FfmpegAdapter } from './ffmpeg.js';
import { OpenAiCompatibleTranscriber, type HostedTranscriptionSettings } from './hosted-transcription.js';
import { execFileUntilStopped, waitOrStop } from './stopping.js';
import { eventually, isAlive, waitingPrograms, writeFakeWhisper, type WaitingProgram } from './test-support.js';
import { WhisperCppTranscriber, runProgram } from './transcription.js';

/**
 * What calling work off really does. Every program here is a real process (one that does nothing for a minute, like a long FFmpeg or whisper.cpp run),
 * and what is checked is that it is gone moments after the signal, and that the work fails with the reason of the signal and with nothing of its own.
 * Two kinds of program are used: one that ends when it is asked to, and one that ignores the request, as a busy program may (only a kill ends that one).
 */
let directory: string;
let programs: ReturnType<typeof waitingPrograms>;
before(async () => { directory = await mkdtemp(join(tmpdir(), 'studio-stopping-')); programs = waitingPrograms(directory); });
after(async () => { await programs.killAll(); await rm(directory, { recursive: true, force: true }); });

/** A test that hangs (a program that was not ended) fails after this long instead of holding up everything. */
const slow = { timeout: 30_000 };
const kinds = [{ ignoresTerm: false }, { ignoresTerm: true }];

/** Starts `work` when the program runs, calls it off with `reason`, and checks that it ended with that reason, quickly, and that the program is gone. */
async function endsWhenCalledOff(program: WaitingProgram, work: (signal: AbortSignal) => Promise<unknown>, reason: unknown = new JobStopped()) {
  const controller = new AbortController();
  const outcome = work(controller.signal);
  const settled = assert.rejects(outcome, (error) => error === reason, 'the work must fail with the reason of the signal, not with a failure of its own');
  await eventually('the program to start', () => program.started(), (started) => started);
  const pid = await program.pid();
  assert.ok(isAlive(pid), 'the program runs until it is called off');
  const calledOffAt = Date.now();
  controller.abort(reason);
  await settled;
  assert.ok(Date.now() - calledOffAt < 5000, 'it ended in moments, not after the minute the program would have taken');
  await eventually('the program to be gone', () => isAlive(pid), (stillThere) => !stillThere, 5000);
}

/** Work that is called off already must not start its program at all. */
async function neverStartsWhenAlreadyCalledOff(program: WaitingProgram, work: (signal: AbortSignal) => Promise<unknown>) {
  const reason = new JobStopped();
  await assert.rejects(work(AbortSignal.abort(reason)), (error) => error === reason);
  assert.equal(await program.started(), false, 'the program was started although the work was already called off');
}

test('a program started for a job is killed, not asked to end, the moment the job is stopped: one that ignores the request is gone too, and nothing is left listening', slow, async () => {
  for (const kind of kinds) {
    const program = await programs.make(kind); const controller = new AbortController();
    const running = execFileUntilStopped(program.path, [], { timeout: 120_000, maxBuffer: 1024 }, controller.signal);
    const settled = assert.rejects(running, (error: Error & { signal?: string }) => error.signal === 'SIGKILL', 'a program that is called off fails as one that was killed does');
    await eventually('the program to start', () => program.started(), (started) => started);
    const pid = await program.pid();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'the signal is listened to while the program runs');
    controller.abort(new JobStopped());
    await settled;
    await eventually(`the program (${JSON.stringify(kind)}) to be gone`, () => isAlive(pid), (stillThere) => !stillThere, 5000);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'nothing is left listening');
  }
});

test('a program started for a job behaves as execFile does when nothing calls it off: its output, its own failures, its time limit, and no listener left behind', slow, async () => {
  assert.deepEqual(await execFileUntilStopped('echo', ['hello'], { timeout: 10_000, maxBuffer: 1024 }), { stdout: 'hello\n', stderr: '' });
  const signal = new AbortController().signal;
  assert.deepEqual(await execFileUntilStopped('echo', ['again'], { timeout: 10_000, maxBuffer: 1024 }, signal), { stdout: 'again\n', stderr: '' });
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'a program that ended by itself leaves nothing listening');
  await assert.rejects(execFileUntilStopped('false', [], { timeout: 10_000, maxBuffer: 1024 }, signal), (error: Error & { code?: number }) => error.code === 1, 'a program that fails by itself fails as it did');
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'and leaves nothing listening either');
  const waiting = await programs.make();
  await assert.rejects(execFileUntilStopped(waiting.path, [], { timeout: 200, maxBuffer: 1024 }, signal), (error: Error & { killed?: boolean }) => error.killed === true, 'the time limit still works with a signal');
});

test('work that is called off already never starts its program', slow, async () => {
  const program = await programs.make();
  // The time limit is short so that a program that was started after all ends the test quickly, and not as a pass.
  await neverStartsWhenAlreadyCalledOff(program, (signal) => execFileUntilStopped(program.path, [], { timeout: 3000, maxBuffer: 1024 }, signal));
});

test('a wait ends when its time is up, or at once with the reason of the signal, and leaves nothing listening either way', slow, async () => {
  const signal = new AbortController().signal;
  const waited: number[] = [];
  await waitOrStop(async (ms) => { waited.push(ms); }, 1234, signal);
  assert.deepEqual(waited, [1234]);
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'a wait that ran its course leaves no listener on the signal');

  const controller = new AbortController(); const reason = new JobStopped();
  const during = waitOrStop(() => new Promise<void>(() => undefined), 60_000, controller.signal);
  const settled = assert.rejects(during, (error) => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(reason);
  await settled;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

  let slept = 0;
  await assert.rejects(waitOrStop(async () => { slept += 1; }, 10, AbortSignal.abort(reason)), (error) => error === reason);
  assert.equal(slept, 0, 'a wait that is called off already does not even begin');
});

test('runProgram kills the program the moment its signal is aborted, fails with the reason of the signal once the program is gone, and leaves nothing listening', slow, async () => {
  for (const kind of kinds) {
    const program = await programs.make(kind);
    await endsWhenCalledOff(program, (signal) => runProgram(program.path, [], { cwd: directory, timeoutMs: 120_000, signal }));
  }
  const controller = new AbortController();
  await runProgram('true', [], { cwd: directory, timeoutMs: 10_000, signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'a program that ended by itself leaves no listener');
  const idle = await programs.make();
  await neverStartsWhenAlreadyCalledOff(idle, (signal) => runProgram(idle.path, [], { cwd: directory, timeoutMs: 120_000, signal }));
});

test('a program that fails by itself is still a failure of its own, signal or no signal', slow, async () => {
  const signal = new AbortController().signal;
  await assert.rejects(runProgram('false', [], { cwd: directory, timeoutMs: 10_000, signal }), /Command failed: false \(exit code 1\)/);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  await assert.rejects(runProgram(join(directory, 'no-such-program'), [], { cwd: directory, timeoutMs: 10_000, signal }), /Could not start/);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  const waiting = await programs.make();
  await assert.rejects(runProgram(waiting.path, [], { cwd: directory, timeoutMs: 100, signal }), (error: Error & { timedOut?: boolean }) => error.timedOut === true, 'the time limit still works with a signal');
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('the speech recognition program is killed when its job is stopped, and that is not told as the program being killed by the server', slow, async () => {
  for (const kind of kinds) {
    const program = await programs.make(kind);
    const transcriber = new WhisperCppTranscriber(program.path, join(directory, 'no-model.bin'), 'en', 120_000);
    await endsWhenCalledOff(program, (signal) => transcriber.transcribe(join(directory, 'audio.wav'), directory, undefined, signal));
  }
  const idle = await programs.make();
  await neverStartsWhenAlreadyCalledOff(idle, (signal) => new WhisperCppTranscriber(idle.path, join(directory, 'no-model.bin'), 'en', 120_000).transcribe(join(directory, 'audio.wav'), directory, undefined, signal));

  // Without a stop everything is as before: a program that is killed by the system is still the words about memory.
  const killed = join(directory, 'killed-whisper.sh');
  await writeFakeWhisper(killed, { body: 'kill -9 $$' }); await chmod(killed, 0o755);
  await assert.rejects(new WhisperCppTranscriber(killed, join(directory, 'no-model.bin'), 'en', 120_000).transcribe(join(directory, 'audio.wav'), directory, undefined, new AbortController().signal), (error) => error instanceof PlainFailure && /ran out of memory/.test(error.message));
});

test('looking at a video, and taking its sound out, end when their job is stopped, and are not told as a video that cannot be read', slow, async () => {
  for (const kind of kinds) {
    const looking = await programs.make(kind);
    await endsWhenCalledOff(looking, (signal) => new FfmpegAdapter(looking.path, 'ffmpeg').probe(join(directory, 'video.mp4'), signal));
    const extracting = await programs.make(kind);
    await endsWhenCalledOff(extracting, (signal) => new FfmpegAdapter('ffprobe', extracting.path).extractAudio(join(directory, 'video.mp4'), join(directory, 'audio.wav'), signal));
  }
  const never = await programs.make();
  await neverStartsWhenAlreadyCalledOff(never, (signal) => new FfmpegAdapter(never.path, 'ffmpeg').probe(join(directory, 'video.mp4'), signal));
  await neverStartsWhenAlreadyCalledOff(never, (signal) => new FfmpegAdapter('ffprobe', never.path).extractAudio(join(directory, 'video.mp4'), join(directory, 'audio.wav'), signal));
  // A file that cannot be read is still told as one when nobody stopped anything.
  await assert.rejects(new FfmpegAdapter('false', 'ffmpeg').probe(join(directory, 'video.mp4'), new AbortController().signal), (error) => error instanceof PlainFailure && /could not be read as a video/.test(error.message), 'a program that fails without a stop is a video that cannot be read');
  await assert.rejects(new FfmpegAdapter('ffprobe', 'false').extractAudio(join(directory, 'video.mp4'), join(directory, 'audio.wav'), new AbortController().signal), (error) => error instanceof PlainFailure, 'and so is a sound that cannot be taken out');
});

test('the pieces of speech recognition by a hosted service (the length of the audio, the silences, the cutting into pieces) end when their job is stopped', slow, async () => {
  const audio = join(directory, 'audio.wav'); const piece = join(directory, 'piece.m4a'); const chunk = { startSeconds: 0, endSeconds: 5 };
  for (const kind of kinds) {
    const measuring = await programs.make(kind);
    await endsWhenCalledOff(measuring, (signal) => audioDuration(measuring.path, audio, signal));
    const listening = await programs.make(kind);
    await endsWhenCalledOff(listening, (signal) => detectSilences(listening.path, audio, { signal }));
    const cutting = await programs.make(kind);
    await endsWhenCalledOff(cutting, (signal) => encodeChunk(cutting.path, audio, chunk, piece, undefined, signal));
  }
  const never = await programs.make();
  await neverStartsWhenAlreadyCalledOff(never, (signal) => audioDuration(never.path, audio, signal));
  await neverStartsWhenAlreadyCalledOff(never, (signal) => detectSilences(never.path, audio, { signal }));
  await neverStartsWhenAlreadyCalledOff(never, (signal) => encodeChunk(never.path, audio, chunk, piece, undefined, signal));
  // Without a stop, a program that fails is still a failure of its own, signal or no signal.
  await assert.rejects(audioDuration('false', audio, new AbortController().signal), /Could not read how long the audio is/);
  await assert.rejects(encodeChunk('false', audio, chunk, piece, undefined, new AbortController().signal), /Could not prepare/);
});

/** A stand-in ffprobe that says, at once, that the audio lasts `seconds`. */
async function ffprobeSaying(seconds: number): Promise<string> {
  const path = join(directory, `ffprobe-saying-${seconds}.sh`);
  await writeFile(path, `#!/bin/sh\necho ${seconds}\n`); await chmod(path, 0o755);
  return path;
}

test('a recognition of speech by a hosted service that is stopped while one of its programs runs ends at once: the program is killed, the failure is the stop, and nothing is sent', slow, async () => {
  const audio = join(directory, 'hosted-audio.wav'); await writeFile(audio, 'not really audio: the stand-in programs do not read it');
  const workDir = await mkdtemp(join(directory, 'hosted-'));
  const hosted = (overrides: Partial<HostedTranscriptionSettings>) => new OpenAiCompatibleTranscriber({ apiUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key-0123456789abcdef', model: 'whisper-1', language: 'en', timeoutMs: 20_000, chunkSeconds: 600, concurrency: 3, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', ...overrides }, { retryDelayMs: 1 });
  const long = await ffprobeSaying(900);  // longer than a piece: the silences are looked for next
  const short = await ffprobeSaying(5);   // one piece: it is cut next
  for (const kind of kinds) {
    const measuring = await programs.make(kind);
    await endsWhenCalledOff(measuring, (signal) => hosted({ ffprobePath: measuring.path }).transcribe(audio, workDir, undefined, signal));
    const listening = await programs.make(kind);
    await endsWhenCalledOff(listening, (signal) => hosted({ ffprobePath: long, ffmpegPath: listening.path }).transcribe(audio, workDir, undefined, signal));
    const cutting = await programs.make(kind);
    await endsWhenCalledOff(cutting, (signal) => hosted({ ffprobePath: short, ffmpegPath: cutting.path }).transcribe(audio, workDir, undefined, signal));
  }
});

test('rendering a clip: FFmpeg is killed when the job is stopped, nothing of the clip is left, and the colour conversion is not tried again without it', slow, async () => {
  const request = (outputPath: string, signal?: AbortSignal) => ({ sourcePath: join(directory, 'video.mp4'), startSeconds: 0, endSeconds: 5, outputPath, ...(signal ? { signal } : {}) });
  for (const kind of kinds) {
    const program = await programs.make(kind); const outputPath = join(directory, `clip-killed-${kind.ignoresTerm}.mp4`);
    await writeFile(outputPath, 'half a clip');
    await endsWhenCalledOff(program, (signal) => new FfmpegClipRenderer(program.path, 'libx264', 'aac', 23, 'veryfast', 360, 640).render(request(outputPath, signal)));
    await assert.rejects(access(outputPath), 'the half of a clip is removed');
  }
  const idle = await programs.make();
  await neverStartsWhenAlreadyCalledOff(idle, (signal) => new FfmpegClipRenderer(idle.path, 'libx264', 'aac', 23, 'veryfast', 360, 640).render(request(join(directory, 'never.mp4'), signal)));

  // A failure of the colour conversion is tried again without it; one that comes with a stop is not.
  const controller = new AbortController(); const reason = new JobStopped(); const seen: Array<AbortSignal | undefined> = [];
  const runner: FfmpegRunner = async (_binary, _args, options) => {
    seen.push(options.signal);
    controller.abort(reason);
    throw Object.assign(new Error('Command failed'), { stderr: 'Impossible to convert between the formats supported by the filter (zscale)' });
  };
  const hdr = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 360, 640, runner, undefined, undefined, true);
  await assert.rejects(hdr.render({ ...request(join(directory, 'hdr.mp4'), controller.signal), hdr: 'hlg' }), (error) => error === reason);
  assert.equal(seen.length, 1, 'the clip was not made again without the colour conversion');
  assert.equal(seen[0], controller.signal, 'the runner is given the signal');
  // And without a signal the same failure is tried again, as before.
  let tries = 0;
  const again: FfmpegRunner = async (_binary, args) => { tries += 1; if (tries === 1) throw Object.assign(new Error('Command failed'), { stderr: 'zscale failed' }); await writeFile(args[args.length - 1], 'a clip'); };
  await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 360, 640, again, undefined, undefined, true).render({ ...request(join(directory, 'retried.mp4')), hdr: 'hlg' });
  assert.equal(tries, 2);
});

test('looking for a face: FFmpeg is killed when the job is stopped, and the failure is the stop, not a broken stream', slow, async () => {
  const video = join(directory, 'video.mp4');
  for (const kind of kinds) {
    const program = await programs.make(kind);
    const framer = new FaceClipFramer({ ffmpegPath: program.path, outputAspect: 9 / 16 });
    await endsWhenCalledOff(program, (signal) => framer.frame({ sourcePath: video, startSeconds: 0, endSeconds: 5, signal }));
  }
  const idle = await programs.make();
  await neverStartsWhenAlreadyCalledOff(idle, (signal) => new FaceClipFramer({ ffmpegPath: idle.path, outputAspect: 9 / 16 }).frame({ sourcePath: video, startSeconds: 0, endSeconds: 5, signal }));
});
