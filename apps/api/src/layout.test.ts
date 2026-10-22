import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FfmpegClipRenderer } from './clips.js';

// These tests run the real FFmpeg on a picture made of three bands of colour (red, green, blue from left to right), so that what a layout
// shows can be read from single pixels: a cut from the middle sees only green, the whole picture sees all three.
const run = promisify(execFile);

const WIDTH = 360; const HEIGHT = 640;
type Colour = 'red' | 'green' | 'blue';
const dominant = (pixel: { r: number; g: number; b: number }): Colour | 'other' => {
  if (pixel.r > 150 && pixel.g < 100 && pixel.b < 100) return 'red';
  if (pixel.g > 150 && pixel.r < 100 && pixel.b < 100) return 'green';
  if (pixel.b > 150 && pixel.r < 100 && pixel.g < 100) return 'blue';
  return 'other';
};

async function firstFrame(path: string) {
  const { stdout } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(stdout.length, WIDTH * HEIGHT * 3, 'one whole picture of the expected size');
  return (x: number, y: number) => { const at = (y * WIDTH + x) * 3; return { r: stdout[at], g: stdout[at + 1], b: stdout[at + 2] }; };
}

async function bands(directory: string, size: { width: number; height: number }, name = 'bands.mp4') {
  const part = (colour: string, width: number) => ['-f', 'lavfi', '-i', `color=c=${colour}:s=${width}x${size.height}:r=10:d=2`];
  const third = Math.round(size.width / 3);
  const path = join(directory, name);
  await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...part('red', third), ...part('lime', size.width - 2 * third), ...part('blue', third), '-filter_complex', '[0:v][1:v][2:v]hstack=inputs=3,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', path]);
  return path;
}

test('"fill" cuts the middle out of the picture, "fit" shows the whole picture over a blurred copy of it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-layout-'));
  try {
    const source = await bands(directory, { width: 640, height: 360 });
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'ultrafast', WIDTH, HEIGHT);
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 1.5, outputPath: join(directory, 'fill.mp4') });
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 1.5, outputPath: join(directory, 'fit.mp4'), layout: 'fit' });
    const size = async (file: string) => (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', file])).stdout.trim();
    assert.equal(await size(join(directory, 'fill.mp4')), `${WIDTH},${HEIGHT},yuv420p`);
    assert.equal(await size(join(directory, 'fit.mp4')), `${WIDTH},${HEIGHT},yuv420p`, 'both are normal vertical clips');

    const fill = await firstFrame(join(directory, 'fill.mp4'));
    for (const x of [8, 180, 351]) assert.equal(dominant(fill(x, 320)), 'green', `fill: only the middle of the picture is there (x=${x})`);

    const fit = await firstFrame(join(directory, 'fit.mp4'));
    assert.equal(dominant(fit(8, 320)), 'red', 'fit: the left edge of the picture is there');
    assert.equal(dominant(fit(180, 320)), 'green');
    assert.equal(dominant(fit(351, 320)), 'blue', 'fit: and the right edge');
    // The picture is 360 x 203 here, so the first and last 200 rows are only the blurred copy, which is made of the middle of the picture.
    for (const [x, y] of [[8, 40], [180, 40], [351, 40], [8, 600], [351, 600]]) assert.equal(dominant(fit(x, y)), 'green', `fit: the empty space is filled with a copy of the picture, not left black (x=${x}, y=${y})`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('"fit" works for any shape of video: wider, squarer, narrower and the same as the clip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-layout-shapes-'));
  try {
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'ultrafast', WIDTH, HEIGHT);
    for (const shape of [{ width: 840, height: 360 }, { width: 480, height: 480 }, { width: 360, height: 640 }, { width: 270, height: 640 }, { width: 642, height: 362 }]) {
      const source = await bands(directory, shape, `${shape.width}x${shape.height}.mp4`);
      const output = join(directory, `fit-${shape.width}x${shape.height}.mp4`);
      await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 1, outputPath: output, layout: 'fit' });
      const frame = await firstFrame(output); // also checks the size
      assert.equal(dominant(frame(WIDTH / 2, HEIGHT / 2)), 'green', `${shape.width}x${shape.height}: the middle of the picture is in the middle of the clip`);
      if (shape.width / shape.height >= WIDTH / HEIGHT) { // not narrower than the clip: the whole width is used
        assert.equal(dominant(frame(4, HEIGHT / 2)), 'red', `${shape.width}x${shape.height}: the left edge reaches the left edge of the clip`);
        assert.equal(dominant(frame(WIDTH - 5, HEIGHT / 2)), 'blue', `${shape.width}x${shape.height}: and the right edge the right one`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a video stored sideways and turned when played (as phones do) is laid out by the picture people see, not by the stored one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-layout-turned-'));
  try {
    const stored = await bands(directory, { width: 640, height: 360 });
    const turned = join(directory, 'turned.mp4');
    await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-display_rotation', '90', '-i', stored, '-c', 'copy', turned]);
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'ultrafast', WIDTH, HEIGHT);
    await renderer.render({ sourcePath: turned, startSeconds: 0, endSeconds: 1, outputPath: join(directory, 'turned-fit.mp4'), layout: 'fit' });
    const frame = await firstFrame(join(directory, 'turned-fit.mp4'));
    // Turned by 90 degrees the bands lie on their sides: from the top red (left of the stored picture), green, blue; the clip is all picture, no blurred bands.
    assert.equal(dominant(frame(180, 20)), 'blue', 'the picture people see fills the clip');
    assert.equal(dominant(frame(180, 320)), 'green');
    assert.equal(dominant(frame(180, 620)), 'red');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
