import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { audioDuration, detectSilences, encodeChunk, parseSilences, planChunks, type Silence } from './audio-chunks.js';

const run = promisify(execFile);
const silence = (startSeconds: number, endSeconds: number): Silence => ({ startSeconds, endSeconds });

test('the silences are read from what the FFmpeg filter prints; one that has not ended when the audio does is left out', () => {
  const report = `
[silencedetect @ 0x55d] silence_start: -0.000667
[silencedetect @ 0x55d] silence_end: 1.00006 | silence_duration: 1.00073
size=N/A time=00:00:05.00 bitrate=N/A speed= 300x
[silencedetect @ 0x55d] silence_start: 6.2
[silencedetect @ 0x55d] silence_end: 7.45 | silence_duration: 1.25
[silencedetect @ 0x55d] silence_start: 17.9`;
  assert.deepEqual(parseSilences(report), [silence(0, 1.00006), silence(6.2, 7.45)]);
  assert.deepEqual(parseSilences(''), []);
});

test('audio that fits in one piece is not cut; a longer recording is cut in the middle of the pauses nearest to where each piece should end', () => {
  assert.deepEqual(planChunks(0, [], 600), []);
  assert.deepEqual(planChunks(590, [silence(300, 301)], 600), [{ startSeconds: 0, endSeconds: 590 }]);
  assert.deepEqual(planChunks(650, [], 600), [{ startSeconds: 0, endSeconds: 650 }], 'a little over the target (up to 60 s) still goes in one piece, rather than leaving a tiny piece over');
  assert.deepEqual(planChunks(700, [], 600), [{ startSeconds: 0, endSeconds: 600 }, { startSeconds: 600, endSeconds: 700 }]);

  const plan = planChunks(1500, [silence(100, 101), silence(590, 592), silence(640, 641), silence(1190, 1191.5)], 600);
  assert.deepEqual(plan, [{ startSeconds: 0, endSeconds: 591 }, { startSeconds: 591, endSeconds: 1190.75 }, { startSeconds: 1190.75, endSeconds: 1500 }], 'the longest pause in reach, in its middle');
});

test('with no pause to cut at the pieces are cut at the target, and they always follow each other exactly with no overlap and no gap', () => {
  const plan = planChunks(2000, [], 600);
  assert.deepEqual(plan.map((piece) => piece.endSeconds), [600, 1200, 1800, 2000]);
  for (const duration of [61, 599, 601, 1300, 3599, 7200.4, 10_000]) {
    for (const target of [60, 600, 900]) {
      const pieces = planChunks(duration, [silence(target - 5, target - 4)], target);
      assert.equal(pieces[0].startSeconds, 0);
      assert.equal(pieces.at(-1)?.endSeconds, Math.round(duration * 1000) / 1000);
      pieces.forEach((piece, index) => {
        if (index) assert.equal(piece.startSeconds, pieces[index - 1].endSeconds, `a gap or an overlap before piece ${index}`);
        const length = piece.endSeconds - piece.startSeconds;
        assert.ok(length > 0 && length <= target + Math.min(target * 0.3, 60) + 0.001, `piece ${index} lasts ${length} s (target ${target})`);
        if (index < pieces.length - 1) assert.ok(length >= target - Math.min(target * 0.3, 60) - 0.001, `piece ${index} is too short: ${length} s`);
      });
    }
  }
});

test('with real FFmpeg: the pauses of a recording are found, the cuts fall in them, and a piece is written as small compressed audio of the right length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-chunks-'));
  try {
    const wav = join(dir, 'audio.wav');
    // 18 s of a tone with a pause during the first second of every 6: pauses at 0-1 s, 6-7 s and 12-13 s.
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t)*gt(mod(t\\,6)\\,1):s=16000:d=18', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    assert.ok(Math.abs(await audioDuration('ffprobe', wav) - 18) < 0.05);

    const silences = await detectSilences('ffmpeg', wav);
    assert.equal(silences.length, 3, JSON.stringify(silences));
    silences.forEach((found, index) => { assert.ok(Math.abs(found.startSeconds - index * 6) < 0.1 && Math.abs(found.endSeconds - (index * 6 + 1)) < 0.1, `pause ${index}: ${JSON.stringify(found)}`); });

    const plan = planChunks(18, silences, 8);
    assert.equal(plan.length, 3);
    assert.ok(Math.abs(plan[0].endSeconds - 6.5) < 0.1 && Math.abs(plan[1].endSeconds - 12.5) < 0.1, JSON.stringify(plan));

    const piece = join(dir, 'piece.m4a');
    await encodeChunk('ffmpeg', wav, plan[1], piece);
    assert.ok(Math.abs(await audioDuration('ffprobe', piece) - (plan[1].endSeconds - plan[1].startSeconds)) < 0.15, 'the piece lasts as long as planned');
    assert.ok((await stat(piece)).size < 6 * 6500, 'about 48 kbit/s: far smaller than the 32 kB per second of the WAV');
    await assert.rejects(encodeChunk('ffmpeg', join(dir, 'missing.wav'), plan[0], join(dir, 'x.m4a')), /Could not prepare the audio/);
    await assert.rejects(audioDuration('ffprobe', join(dir, 'missing.wav')), /Could not read how long/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
