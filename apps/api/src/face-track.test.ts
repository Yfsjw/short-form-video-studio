import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FfmpegClipRenderer } from './clips.js';
import { FaceClipFramer, histogramDistance, meanAbsoluteDifference, readPgmPictures, type GrayPicture } from './face-track.js';
import { positionAt } from './framing.js';
import { detectFaces, loadFaceCascade } from './haar.js';

const PHOTO = fileURLToPath(new URL('../test-assets/astronaut-320.pgm', import.meta.url));
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const close = (actual: number, expected: number, tolerance: number, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} is not within ${tolerance} of ${expected}`);
const pgm = (width: number, height: number, fill: (x: number, y: number) => number) => Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`, 'latin1'), Buffer.from(Array.from({ length: width * height }, (_, index) => fill(index % width, Math.floor(index / width))))]);
async function* chunked(data: Buffer, size: number): AsyncGenerator<Uint8Array> { for (let offset = 0; offset < data.length; offset += size) yield data.subarray(offset, offset + size); }
const collect = async (source: AsyncIterable<GrayPicture>) => { const pictures: GrayPicture[] = []; for await (const picture of source) pictures.push(picture); return pictures; };

// ---- small pieces ---------------------------------------------------------------------------------------------------------------

test('pictures are read from FFmpeg\'s stream however the bytes are cut up', async () => {
  const first = pgm(6, 4, (x, y) => x * 10 + y); const second = pgm(6, 4, () => 200);
  for (const size of [1, 3, 7, 1000]) {
    const pictures = await collect(readPgmPictures(chunked(Buffer.concat([first, second]), size)));
    assert.equal(pictures.length, 2, `chunks of ${size} bytes`);
    assert.deepEqual([pictures[0].width, pictures[0].height], [6, 4]);
    assert.equal(pictures[0].pixels[3 * 6 + 5], 5 * 10 + 3);
    assert.ok(pictures[1].pixels.every((value) => value === 200));
  }
  assert.deepEqual(await collect(readPgmPictures(chunked(Buffer.alloc(0), 10))), []);
});

test('a stream that is not what was asked for is refused', async () => {
  await assert.rejects(collect(readPgmPictures(chunked(Buffer.from('this is not a picture at all, it is just some text that goes on'), 16))), /did not write pictures/);
  await assert.rejects(collect(readPgmPictures(chunked(Buffer.concat([Buffer.from('P5\n4 4\n65535\n'), Buffer.alloc(64)]), 16))), /size or depth/);
});

test('two pictures are told apart by how much they differ, and by their mix of dark and light', () => {
  const dark = new Uint8Array(64 * 64).fill(20); const light = new Uint8Array(64 * 64).fill(220);
  assert.equal(meanAbsoluteDifference(dark, dark, 64, 64), 0); assert.equal(histogramDistance(dark, dark, 64, 64), 0);
  assert.equal(meanAbsoluteDifference(dark, light, 64, 64), 200); assert.equal(histogramDistance(dark, light, 64, 64), 1);
  // The same bright square in two places: very different pixel by pixel, the same mix of dark and light.
  const square = (left: number) => { const picture = new Uint8Array(64 * 64).fill(20); for (let y = 8; y < 40; y += 1) for (let x = left; x < left + 32; x += 1) picture[y * 64 + x] = 220; return picture; };
  assert.ok(meanAbsoluteDifference(square(0), square(32), 64, 64) > 50);
  assert.equal(histogramDistance(square(0), square(32), 64, 64), 0);
});

// ---- real videos: a photo with a face, moved over a flat background -----------------------------------------------------------

let directory = '';
const video = (name: string) => join(directory, name);
const framer = () => new FaceClipFramer({ ffmpegPath: 'ffmpeg', outputAspect: 9 / 16 });
const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p'];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'framing-'));
  const background = (seconds: number) => ['-f', 'lavfi', '-i', `color=c=0x707070:s=640x360:r=10:d=${seconds}`, '-loop', '1', '-framerate', '10', '-i', PHOTO];
  // The face crosses the picture from left to right in ten seconds.
  ffmpeg([...background(10), '-filter_complex', "[0:v][1:v]overlay=x='(W-w)*t/10':y=20:shortest=1,format=yuv420p", '-t', '10', ...x264, video('walker.mp4')]);
  // Nothing in it that is a face.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=10:d=6', ...x264, video('empty.mp4')]);
  // Two faces side by side that do not move.
  ffmpeg([...background(6), '-filter_complex', '[0:v][1:v]overlay=x=0:y=20:shortest=1[a];[a][1:v]overlay=x=320:y=20,format=yuv420p', '-t', '6', ...x264, video('two.mp4')]);
  // Two shots with a cut at five seconds: the face on the left, then (a different brightness, as if from another camera) on the right.
  ffmpeg([...background(10), '-filter_complex', "[0:v][1:v]overlay=x='if(lt(t,5),0,320)':y=20:shortest=1,eq=brightness='if(lt(t,5),0,0.15)':eval=frame,format=yuv420p", '-t', '10', ...x264, video('cuts.mp4')]);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('a face walking across the picture is followed across it, smoothly', async () => {
  const result = await framer().frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10 });
  assert.ok(result.followed, result.note);
  assert.ok(result.seenShare >= 0.9, `${result.seenShare}`);
  const { keyframes } = result.plan;
  close(positionAt(keyframes, 0), 0.1, 0.06, 'at the start the window is at the left, where the face is');
  close(positionAt(keyframes, 10), 0.76, 0.06, 'at the end it is at the right');
  let previous = -1;
  for (let t = 0; t <= 10; t += 0.5) { const position = positionAt(keyframes, t); assert.ok(position >= previous - 1e-9, `it only goes right (${t} s)`); previous = position; }
  assert.equal(result.tracksFollowed, 1, 'a person walking is not mistaken for a cut');
  assert.match(result.note, /^Followed a face, seen in \d+% of the moments checked/);
});

test('the shape of a clip can be given with the request: a landscape clip from a landscape video has nothing to follow, a square one has a wider window to move', async () => {
  const landscape = await framer().frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10, outputAspect: 16 / 9 });
  assert.equal(landscape.followed, false);
  assert.match(landscape.note, /nothing to follow/);

  const vertical = await framer().frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10 });
  const square = await framer().frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10, outputAspect: 1 });
  assert.ok(vertical.followed && square.followed);
  // The face starts the walk a quarter of the way across the picture. A window a third of the picture wide can be centred on it; one more than half of the
  // picture wide cannot (its middle cannot be nearer the edge than a quarter of its width), so it has to stand against the left edge. The walk ends nearer the
  // right edge for the wider window as well.
  assert.ok(positionAt(vertical.plan.keyframes, 0) > 0.03, `${positionAt(vertical.plan.keyframes, 0)}`);
  assert.ok(positionAt(square.plan.keyframes, 0) < 0.02, `${positionAt(square.plan.keyframes, 0)}`);
  assert.ok(positionAt(square.plan.keyframes, 10) > positionAt(vertical.plan.keyframes, 10), `${positionAt(square.plan.keyframes, 10)} against ${positionAt(vertical.plan.keyframes, 10)}`);
});

test('a picture without a face leaves the clip centred and says so', async () => {
  const result = await framer().frame({ sourcePath: video('empty.mp4'), startSeconds: 0, endSeconds: 6 });
  assert.equal(result.followed, false);
  assert.match(result.note, /^Centred: no face was found/);
});

test('two faces that stay where they are give one steady shot, on one of them', async () => {
  const result = await framer().frame({ sourcePath: video('two.mp4'), startSeconds: 0, endSeconds: 6 });
  assert.ok(result.followed, result.note);
  assert.equal(result.plan.keyframes.length, 1);
  const position = result.plan.keyframes[0].position;
  assert.ok(Math.abs(position - 0.09) < 0.05 || Math.abs(position - 0.82) < 0.05, `position ${position}`);
});

test('a cut in the video moves the window at once, and a stretch that starts after the cut is counted from its own start', async () => {
  const whole = await framer().frame({ sourcePath: video('cuts.mp4'), startSeconds: 0, endSeconds: 10 });
  assert.ok(whole.followed, whole.note);
  close(positionAt(whole.plan.keyframes, 4.8), 0.09, 0.05, 'before the cut');
  close(positionAt(whole.plan.keyframes, 5.2), 0.82, 0.05, 'after the cut');
  assert.equal(whole.tracksFollowed, 2);

  // The same video from four seconds in: the cut is one second into this stretch.
  const later = await framer().frame({ sourcePath: video('cuts.mp4'), startSeconds: 4, endSeconds: 10 });
  assert.ok(later.followed, later.note);
  close(positionAt(later.plan.keyframes, 0.8), 0.09, 0.05, 'in the first second');
  close(positionAt(later.plan.keyframes, 1.3), 0.82, 0.05, 'after the cut');

  // And from after the cut: one steady shot.
  const after = await framer().frame({ sourcePath: video('cuts.mp4'), startSeconds: 6, endSeconds: 10 });
  assert.ok(after.followed, after.note);
  assert.equal(after.plan.keyframes.length, 1);
  close(after.plan.keyframes[0].position, 0.82, 0.05);
});

test('a long clip gets fewer pictures per second, so that it never takes more than the limit', async () => {
  const result = await new FaceClipFramer({ ffmpegPath: 'ffmpeg', outputAspect: 9 / 16, maxPictures: 5 }).frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10 });
  assert.ok(result.followed, result.note);
  close(positionAt(result.plan.keyframes, 10), 0.76, 0.1);
});

test('problems with the video or with FFmpeg are reported, not hidden', async () => {
  await assert.rejects(framer().frame({ sourcePath: video('nothing-here.mp4'), startSeconds: 0, endSeconds: 5 }), /could not take pictures from the video.*nothing-here\.mp4/s);
  await assert.rejects(new FaceClipFramer({ ffmpegPath: join(directory, 'no-such-ffmpeg'), outputAspect: 9 / 16 }).frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 5 }), /ENOENT/);
  await assert.rejects(framer().frame({ sourcePath: video('walker.mp4'), startSeconds: 5, endSeconds: 5 }), /positive length/);
  await assert.rejects(framer().frame({ sourcePath: video('walker.mp4'), startSeconds: 50, endSeconds: 55 }), /No picture could be taken/);
});

test('FFmpeg is told how many threads to use for the pictures, in the places FFmpeg means them for, and the face is followed all the same; without a number it is told nothing', async () => {
  const log = video('recorded-calls.log');
  const recorder = video('recording-ffmpeg');
  await writeFile(recorder, `#!${process.execPath}
const { spawnSync } = require('node:child_process'); const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = spawnSync('ffmpeg', process.argv.slice(2), { stdio: 'inherit' });
process.exitCode = result.status === null ? 1 : result.status;
`, { mode: 0o755 });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const result = await new FaceClipFramer({ ffmpegPath: recorder, outputAspect: 9 / 16, threads: 2 }).frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10 });
  assert.ok(result.followed, result.note);
  assert.ok(result.seenShare >= 0.9, `${result.seenShare}`);
  const [given] = await calls();
  assert.equal(given[given.indexOf('-filter_threads') + 1], '2', 'the filters');
  assert.deepEqual(given.slice(given.indexOf('-i') - 2, given.indexOf('-i')), ['-threads', '2'], 'the decoder: an input option, so in front of the input');
  assert.equal(given.filter((argument) => argument === '-threads').length, 1);
  await new FaceClipFramer({ ffmpegPath: recorder, outputAspect: 9 / 16 }).frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10 });
  const all = await calls();
  assert.equal(all.length, 2);
  assert.ok(!all[1].includes('-threads') && !all[1].includes('-filter_threads'), 'no number, no option');
});

test('FFmpeg is stopped when it takes too long', async () => {
  await assert.rejects(new FaceClipFramer({ ffmpegPath: 'ffmpeg', outputAspect: 9 / 16, timeoutMs: 1 }).frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10 }), /exit code null|could not take pictures|No picture/);
});

// ---- the whole thing: plan the camera, render along it, look at the result ------------------------------------------------------

test('a clip cut along the plan keeps the walking face in the middle of the picture; one cut from the middle loses it', async () => {
  const cascade = await loadFaceCascade();
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 28, 'ultrafast', 360, 640);
  const result = await framer().frame({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10 });
  assert.ok(result.followed, result.note);
  await renderer.render({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10, outputPath: video('framed.mp4'), framing: result.plan });
  await renderer.render({ sourcePath: video('walker.mp4'), startSeconds: 0, endSeconds: 10, outputPath: video('centred.mp4') });

  /** Where the face is across the picture (0 to 1) at a moment of a clip, or undefined when none is seen. */
  const faceAt = async (path: string, seconds: number) => {
    const bytes = ffmpeg(['-ss', String(seconds), '-i', path, '-frames:v', '1', '-pix_fmt', 'gray', '-c:v', 'pgm', '-f', 'image2pipe', 'pipe:1']);
    const [picture] = await collect(readPgmPictures(chunked(Buffer.from(bytes), 65536)));
    assert.deepEqual([picture.width, picture.height], [360, 640]);
    const [face] = detectFaces(cascade, picture.pixels, picture.width, picture.height, { scaleFactor: 1.15, minNeighbors: 5, minSize: 32 });
    return face ? (face.x + face.width / 2) / picture.width : undefined;
  };
  for (const seconds of [1, 3, 5, 7, 9]) {
    const framed = await faceAt(video('framed.mp4'), seconds);
    assert.ok(framed !== undefined && framed > 0.3 && framed < 0.7, `framed clip, ${seconds} s: the face is at ${framed}`);
  }
  // From the middle, the face is out of the picture at the start and at the end (it passes the middle at five seconds).
  for (const seconds of [1, 9]) {
    const centred = await faceAt(video('centred.mp4'), seconds);
    assert.ok(centred === undefined || centred < 0.2 || centred > 0.8, `centred clip, ${seconds} s: the face is at ${centred}`);
  }
});
