import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { PlainFailure, plainWords } from './failures.js';
import { FfmpegAdapter } from './ffmpeg.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
// On a developer machine without ffmpeg these tests are skipped; in CI they must never be skipped silently.
if (!hasFfmpeg && process.env.CI) throw new Error('ffmpeg must be installed in CI so that the looking at videos is really tried.');
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg is not installed on this machine' };

let dir = '';
before(async () => { dir = await mkdtemp(join(tmpdir(), 'studio-ffmpeg-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const ffmpeg = (...args: string[]) => run('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...args]);
const adapter = new FfmpegAdapter('ffprobe', 'ffmpeg');
const lavfiVideo = ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10'];
const lavfiSound = (hz: number) => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`];
const encodeVideo = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

/** Makes a file of the kind named and says where it is. */
async function make(name: string, kind: 'with-sound' | 'sound-first' | 'silent' | 'two-sounds' | 'sound-only' | 'cut-short' | 'garbage'): Promise<string> {
  const path = join(dir, name);
  if (kind === 'with-sound') await ffmpeg(...lavfiVideo, ...lavfiSound(440), ...encodeVideo, '-c:a', 'aac', '-shortest', path);
  else if (kind === 'sound-first') await ffmpeg(...lavfiVideo, ...lavfiSound(440), '-map', '1:a', '-map', '0:v', ...encodeVideo, '-c:a', 'aac', '-shortest', path);
  else if (kind === 'silent') await ffmpeg(...lavfiVideo, ...encodeVideo, path);
  else if (kind === 'two-sounds') await ffmpeg(...lavfiVideo, ...lavfiSound(440), ...lavfiSound(880), '-map', '0:v', '-map', '1:a', '-map', '2:a', ...encodeVideo, '-c:a', 'aac', '-shortest', path);
  else if (kind === 'sound-only') await ffmpeg(...lavfiSound(440), '-c:a', 'pcm_s16le', path);
  else if (kind === 'cut-short') { await ffmpeg(...lavfiVideo, ...lavfiSound(440), ...encodeVideo, '-c:a', 'aac', '-shortest', path); await truncate(path, Math.floor((await stat(path)).size / 2)); }
  else await writeFile(path, 'this is not a video at all, whatever the name of the file says');
  return path;
}

/** The failure a person is told about, checked to be in plain words and to have kept the real reason. */
async function plainFailure(attempt: Promise<unknown>, words: string, path: string): Promise<PlainFailure> {
  const error = await attempt.then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof PlainFailure, `a failure to be told in plain words, not ${String(error)}`);
  assert.equal(error.message, words);
  assert.ok(!error.message.includes(dir) && !error.message.includes(path), 'no folder of the server in what a person reads');
  assert.ok(error.cause instanceof Error && error.cause.message.length > 0, 'what really happened is kept for the log');
  return error;
}

test('looking at a video tells its size, its length and whether it has any sound', needsFfmpeg, async () => {
  const withSound = await adapter.probe(await make('with-sound.mp4', 'with-sound'));
  assert.deepEqual({ width: withSound.width, height: withSound.height, hasAudio: withSound.hasAudio }, { width: 160, height: 120, hasAudio: true });
  assert.ok(Math.abs(withSound.durationSeconds - 2) < 0.3, `the length: ${withSound.durationSeconds}`);

  const silent = await adapter.probe(await make('silent.mp4', 'silent'));
  assert.deepEqual({ width: silent.width, height: silent.height, hasAudio: silent.hasAudio }, { width: 160, height: 120, hasAudio: false }, 'a video with no sound at all says so');
  assert.ok(Math.abs(silent.durationSeconds - 2) < 0.3);

  assert.equal((await adapter.probe(await make('two-sounds.mp4', 'two-sounds'))).hasAudio, true, 'more than one sound is still sound');

  const soundFirst = await adapter.probe(await make('sound-first.mp4', 'sound-first'));
  assert.deepEqual({ width: soundFirst.width, height: soundFirst.height, hasAudio: soundFirst.hasAudio }, { width: 160, height: 120, hasAudio: true }, 'the picture and the sound are found wherever they are in the file, not only in the first place');
});

test('a file that is not a video, is cut short, or has only sound is told as such, in words a person can act on, with the real reason kept', needsFfmpeg, async () => {
  for (const [kind, name] of [['garbage', 'garbage.mp4'], ['cut-short', 'cut-short.mp4']] as const) {
    const path = await make(name, kind);
    const error = await plainFailure(adapter.probe(path), plainWords.unreadableVideo, path);
    assert.match((error.cause as Error).message, /moov atom not found|Invalid data|could not|Error/i, `${kind}: what ffprobe said`);
  }
  const soundOnly = await make('sound-only.wav', 'sound-only');
  const error = await plainFailure(adapter.probe(soundOnly), plainWords.unreadableVideo, soundOnly);
  assert.match((error.cause as Error).message, /does not contain a readable video stream/, 'a recording is not a video, and the reason says why');
});

test('the sound of a video is taken out as 16 kHz mono, and a video without sound, or a file with none to read, is told in plain words', needsFfmpeg, async () => {
  const video = await make('extract.mp4', 'with-sound');
  const wav = join(dir, 'extract.wav');
  await adapter.extractAudio(video, wav);
  const facts = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', wav])).stdout) as { streams: Array<{ codec_name: string; sample_rate: string; channels: number }> };
  assert.deepEqual(facts.streams[0], { codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 });

  const soundFirst = join(dir, 'extract-sound-first.wav');
  await adapter.extractAudio(await make('extract-sound-first.mp4', 'sound-first'), soundFirst);
  assert.ok((await stat(soundFirst)).size > 16_000, 'the sound of a file whose sound comes before its picture is taken out too');

  const silent = await make('extract-silent.mp4', 'silent');
  const error = await plainFailure(adapter.extractAudio(silent, join(dir, 'extract-silent.wav')), plainWords.unreadableSound, silent);
  assert.match((error.cause as Error).message, /matches no streams|Stream map|0:a:0/i, 'FFmpeg said there was no sound to map');
  assert.ok(!(error.cause as Error).message.includes('ffmpeg version'), 'and the long banner of the program is not in what is kept');

  const garbage = await make('extract-garbage.mp4', 'garbage');
  await plainFailure(adapter.extractAudio(garbage, join(dir, 'extract-garbage.wav')), plainWords.unreadableSound, garbage);
});

test('a program that is not installed is the server\'s trouble, not the video\'s: it is not told as a fault of the file', needsFfmpeg, async () => {
  const video = await make('missing-tools.mp4', 'with-sound');
  const nowhere = join(dir, 'no-such-program');
  const missing = new FfmpegAdapter(nowhere, nowhere);
  for (const attempt of [missing.probe(video), missing.extractAudio(video, join(dir, 'missing-tools.wav'))]) {
    const error = await attempt.then(() => undefined, (failure: unknown) => failure);
    assert.ok(error instanceof Error && !(error instanceof PlainFailure), 'a plain error, so that the job says it is the server\'s trouble');
    assert.equal((error as { code?: string }).code, 'ENOENT');
  }
  assert.ok(await readFile(video), 'and the video is untouched');
});

test('whatever the program that looks at a file prints, the file is taken for a video only when it has a picture of a size and a length, and anything else is told as a file that cannot be read', async () => {
  const probeSaying = async (name: string, output: string) => {
    const script = join(dir, `ffprobe-${name}`);
    await writeFile(script, `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`, { mode: 0o755 });
    return new FfmpegAdapter(script, 'ffmpeg').probe(join(dir, 'whatever.mp4'));
  };
  const picture = { codec_type: 'video', width: 160, height: 120 };
  const sound = { codec_type: 'audio' };
  const say = (streams: unknown[], duration?: string) => JSON.stringify({ streams, format: duration === undefined ? {} : { duration } });

  assert.deepEqual(await probeSaying('picture', say([picture], '2.5')), { durationSeconds: 2.5, width: 160, height: 120, hasAudio: false });
  assert.deepEqual(await probeSaying('both', say([sound, picture], '2.5')), { durationSeconds: 2.5, width: 160, height: 120, hasAudio: true });

  const unreadable: Array<[string, string]> = [
    ['no streams at all', say([], '2.5')], ['no length', say([picture])], ['a length that is not a number', say([picture], 'N/A')], ['a length of nothing', say([picture], '0')], ['a negative length', say([picture], '-3')],
    ['a picture without a width', say([{ codec_type: 'video', height: 120 }], '2.5')], ['a picture without a height', say([{ codec_type: 'video', width: 160 }], '2.5')],
    ['only sound', say([sound], '2.5')], ['something that is not JSON', 'this is not JSON'], ['nothing at all', ''],
  ];
  for (const [index, [what, output]] of unreadable.entries()) {
    await assert.rejects(probeSaying(`unreadable-${index}`, output), (error: unknown) => error instanceof PlainFailure && error.message === plainWords.unreadableVideo && error.cause instanceof Error, what);
  }
});
