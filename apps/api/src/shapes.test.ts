import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { buildCaptionChunks, captionCanvas, captionLookFor, renderAss, type CaptionSegmentInput } from './captions.js';
import { FfmpegClipRenderer } from './clips.js';
import { aspectChoices, type AspectChoice } from './domain.js';
import { aspectRatios, outputSizeFor } from './options.js';

// These tests run the real FFmpeg for every shape of clip and read the result from single pixels: the size of the picture, which part of the source
// it shows, and where the captions are.
const run = promisify(execFile);

let directory = '';
const path = (name: string) => join(directory, name);

const sizeOf = async (file: string) => {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [width, height] = stdout.trim().split(',').map(Number);
  return { width, height };
};

/** One frame of a finished clip, as a picture whose pixels can be asked for. */
async function frameOf(file: string, seconds: number) {
  const { width, height } = await sizeOf(file);
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-nostdin', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: width * height * 3 + 4096 });
  assert.equal(stdout.length, width * height * 3, `no whole frame could be read at ${seconds}s`);
  const pixel = (x: number, y: number) => { const at = (Math.floor(y) * width + Math.floor(x)) * 3; return { r: stdout[at], g: stdout[at + 1], b: stdout[at + 2] }; };
  return { width, height, pixel, pixels: stdout };
}
type Colour = 'red' | 'green' | 'blue' | 'other';
const colourOf = (pixel: { r: number; g: number; b: number }): Colour => {
  if (pixel.r > 150 && pixel.g < 100 && pixel.b < 100) return 'red';
  if (pixel.g > 150 && pixel.r < 100 && pixel.b < 100) return 'green';
  if (pixel.b > 150 && pixel.r < 100 && pixel.g < 100) return 'blue';
  return 'other';
};

/** Three bands of colour, red, green and blue from left to right, so that what a clip shows of it can be read from a pixel. */
async function bands(name: string, width: number, height: number) {
  const part = (colour: string, size: number) => ['-f', 'lavfi', '-i', `color=c=${colour}:s=${size}x${height}:r=10:d=2`];
  const third = Math.round(width / 3);
  await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...part('red', third), ...part('lime', width - 2 * third), ...part('blue', third), '-filter_complex', '[0:v][1:v][2:v]hstack=inputs=3,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', path(name)]);
  return path(name);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-shapes-'));
  await bands('wide.mp4', 640, 360); // 16:9
  await bands('tall.mp4', 270, 480); // 9:16, as a phone makes it
  // A dark-blue picture with a tone: the only white in a finished clip is the captions.
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x203060:s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path('dark.mp4')]);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const render = (renderer: FfmpegClipRenderer, source: string, output: string, extra: Partial<Parameters<FfmpegClipRenderer['render']>[0]> = {}) =>
  renderer.render({ sourcePath: path(source), startSeconds: 0, endSeconds: 1, outputPath: path(output), ...extra });

test('every shape comes out at exactly its own size at both qualities, and the face-follower and the captions can rely on that', async () => {
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 1080, 1920);
  for (const aspect of aspectChoices) {
    for (const quality of ['hd', 'standard'] as const) {
      await render(renderer, 'wide.mp4', `size-${aspect}-${quality}.mp4`, { aspect, quality });
      const size = await sizeOf(path(`size-${aspect}-${quality}.mp4`));
      assert.deepEqual(size, outputSizeFor({ width: 1080, height: 1920 }, quality, aspect), `${aspect} ${quality}`);
      assert.equal(size.width / size.height, aspectRatios[aspect], `${aspect} ${quality}: exactly the proportions asked for`);
    }
  }
  await render(renderer, 'wide.mp4', 'size-default.mp4');
  assert.deepEqual(await sizeOf(path('size-default.mp4')), { width: 1080, height: 1920 }, 'a clip asked for without a shape is the vertical one it always was');
});

test('filling the clip keeps the middle of the picture, and the squarer the shape, the more of the sides', async () => {
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 360, 640);
  // The source is 640x360 with a red, a green and a blue third. What each shape keeps of it, from the middle:
  // vertical about a third of the width (all green), 4:5 and 1:1 a little more than that (green with a sliver of red and of blue at the sides), landscape all of it.
  const expected: Record<AspectChoice, { size: { width: number; height: number }; at: Array<[number, Colour]> }> = {
    vertical: { size: { width: 360, height: 640 }, at: [[10, 'green'], [180, 'green'], [350, 'green']] },
    portrait: { size: { width: 360, height: 450 }, at: [[10, 'red'], [180, 'green'], [350, 'blue']] },
    square: { size: { width: 360, height: 360 }, at: [[10, 'red'], [180, 'green'], [350, 'blue']] },
    landscape: { size: { width: 640, height: 360 }, at: [[10, 'red'], [320, 'green'], [630, 'blue']] },
  };
  for (const aspect of aspectChoices) {
    await render(renderer, 'wide.mp4', `fill-${aspect}.mp4`, { aspect, layout: 'fill' });
    const frame = await frameOf(path(`fill-${aspect}.mp4`), 0.3);
    assert.deepEqual({ width: frame.width, height: frame.height }, expected[aspect].size, aspect);
    for (const [x, colour] of expected[aspect].at) assert.equal(colourOf(frame.pixel(x, frame.height / 2)), colour, `${aspect}: x=${x}`);
  }
});

test('the whole picture is shown in every shape, over a blurred copy of itself', async () => {
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 360, 640);
  for (const aspect of aspectChoices) {
    await render(renderer, 'wide.mp4', `fit-${aspect}.mp4`, { aspect, layout: 'fit' });
    const frame = await frameOf(path(`fit-${aspect}.mp4`), 0.3);
    const middle = frame.height / 2;
    // A landscape picture in any shape that is not wider than it reaches both sides of the clip, with all three colours in order.
    assert.equal(colourOf(frame.pixel(4, middle)), 'red', `${aspect}: the left edge of the picture reaches the left edge of the clip`);
    assert.equal(colourOf(frame.pixel(frame.width / 2, middle)), 'green', `${aspect}: the middle is the middle`);
    assert.equal(colourOf(frame.pixel(frame.width - 5, middle)), 'blue', `${aspect}: and the right edge reaches the right edge`);
  }

  // A tall picture (as a phone makes it) in a landscape clip: nothing is cut off at the top or the bottom, and the empty sides are filled, not left black.
  await render(renderer, 'tall.mp4', 'fit-tall-in-landscape.mp4', { aspect: 'landscape', layout: 'fit' });
  const frame = await frameOf(path('fit-tall-in-landscape.mp4'), 0.3);
  assert.deepEqual({ width: frame.width, height: frame.height }, { width: 640, height: 360 });
  // The picture is 360 tall and so 202 wide, in the middle: x from 219 to 421, a third of it red, a third green, a third blue.
  assert.deepEqual([250, 320, 390].map((x) => colourOf(frame.pixel(x, 180))), ['red', 'green', 'blue'], 'the picture is in the middle, whole');
  for (const x of [30, 610]) { const { r, g, b } = frame.pixel(x, 180); assert.ok(r + g + b > 120, `the side at x=${x} is filled with the blurred picture, not black`); }
});

const SAMPLE: CaptionSegmentInput[] = [{ startSeconds: 0, endSeconds: 4, text: 'Nobody tells you this', words: [{ text: 'Nobody', startSeconds: 0.5, endSeconds: 1 }, { text: 'tells', startSeconds: 1, endSeconds: 1.5 }, { text: 'you', startSeconds: 1.5, endSeconds: 2 }, { text: 'this', startSeconds: 2, endSeconds: 2.5 }] }];

test('captions sit where each shape puts them: readable, in the middle of the width and clear of the edges', async () => {
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 360, 640);
  for (const aspect of aspectChoices) {
    const captions = path(`captions-${aspect}.ass`);
    await writeFile(captions, renderAss(buildCaptionChunks(SAMPLE, 0, 4, 'classic'), 'classic', aspect), 'utf8');
    await render(renderer, 'dark.mp4', `captioned-${aspect}.mp4`, { aspect, endSeconds: 4, captionPath: captions });
    const frame = await frameOf(path(`captioned-${aspect}.mp4`), 1.5);
    let left = frame.width; let right = -1; let top = frame.height; let bottom = -1;
    for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
      const { r, g, b } = frame.pixel(x, y);
      if (r > 235 && g > 235 && b > 235) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    assert.ok(right > left && bottom > top, `${aspect}: no captions were drawn`);
    // Where the text should end: the line box ends MarginV above the bottom of the picture, and the letters end a little before that.
    const look = captionLookFor('classic', aspect);
    const lineBottom = (1 - look.marginV / captionCanvas[aspect].height) * frame.height;
    assert.ok(bottom <= lineBottom + 1 && bottom >= lineBottom - 0.06 * frame.height, `${aspect}: the text ends at ${(bottom / frame.height * 100).toFixed(1)}% of the height, expected just above ${(lineBottom / frame.height * 100).toFixed(1)}%`);
    assert.ok(left > 0.03 * frame.width && right < 0.97 * frame.width, `${aspect}: the text runs into the edge (${left}..${right} of ${frame.width})`);
    assert.ok(Math.abs((left + right) / 2 - frame.width / 2) < 0.04 * frame.width, `${aspect}: the text is not in the middle`);
    assert.ok(bottom - top > 0.02 * frame.height, `${aspect}: the text is too small to read`);
  }
});

test('the text is as big on a landscape picture as on the others in proportion to its height, not lost in its width', async () => {
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 360, 640);
  const heightShare: Partial<Record<AspectChoice, number>> = {};
  for (const aspect of ['square', 'landscape'] as const) {
    const captions = path(`share-${aspect}.ass`);
    // One short word: one line in every shape, so its height is the height of a line of text.
    await writeFile(captions, renderAss(buildCaptionChunks([{ startSeconds: 0, endSeconds: 4, text: 'HOME', words: [{ text: 'HOME', startSeconds: 0.5, endSeconds: 2.5 }] }], 0, 4, 'classic'), 'classic', aspect), 'utf8');
    await render(renderer, 'dark.mp4', `share-${aspect}.mp4`, { aspect, endSeconds: 4, captionPath: captions });
    const frame = await frameOf(path(`share-${aspect}.mp4`), 1.5);
    let top = frame.height; let bottom = -1;
    for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) { const { r, g, b } = frame.pixel(x, y); if (r > 235 && g > 235 && b > 235) { top = Math.min(top, y); bottom = Math.max(bottom, y); } }
    heightShare[aspect] = (bottom - top + 1) / frame.height;
  }
  // Capital letters of a 92-pixel font on a 1080-pixel-tall picture (square) against 74 on 1080 (landscape): the landscape text is about 0.8 as tall.
  const ratio = heightShare.landscape! / heightShare.square!;
  assert.ok(ratio > 0.72 && ratio < 0.88, `the landscape text is ${ratio.toFixed(2)} times as tall as the square one`);
});
