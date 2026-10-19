import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildCaptionChunks, renderAss, type CaptionSegmentInput } from './captions.js';
import { BUNDLED_FONTS_DIRECTORY, FfmpegClipRenderer } from './clips.js';

const run = promisify(execFile);

/** What a frame of the finished clip looks like: how many pixels are the white of plain captions, how many the gold of a lit word, and where the gold is. */
async function look(video: string, seconds: number) {
  const width = 270; const height = 480;
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-nostdin', '-ss', String(seconds), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: width * height * 3 + 4096 });
  assert.equal(stdout.length, width * height * 3, `no frame could be read at ${seconds}s`);
  let white = 0; let gold = 0; let goldX = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const r = stdout[pixel * 3]; const g = stdout[pixel * 3 + 1]; const b = stdout[pixel * 3 + 2];
    if (r > 235 && g > 235 && b > 235) white += 1;
    else if (r > 230 && g > 180 && g < 235 && b < 80) { gold += 1; goldX += pixel % width; }
  }
  return { white, gold, goldCentreX: gold ? goldX / gold : null };
}

async function makeSource(root: string) {
  const source = join(root, 'source.mp4');
  // A plain dark-blue picture: the only white and gold in the finished clip is the captions.
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x203060:s=640x360:r=25:d=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', source]);
  return source;
}

const words = (...items: Array<[string, number, number]>): CaptionSegmentInput[] => [{ startSeconds: 0, endSeconds: 8, text: items.map((item) => item[0]).join(' '), words: items.map(([text, startSeconds, endSeconds]) => ({ text, startSeconds, endSeconds })) }];

test('the font the captions are drawn with ships with the program, together with its licence', () => {
  assert.ok(existsSync(join(BUNDLED_FONTS_DIRECTORY, 'Inter-ExtraBold.otf')), `the caption font is missing from ${BUNDLED_FONTS_DIRECTORY}`);
  assert.ok(existsSync(join(BUNDLED_FONTS_DIRECTORY, 'Inter-OFL.txt')), 'the licence that allows shipping the font must travel with it');
});

test('captions are drawn on a machine that has no fonts at all, because the font ships with the program', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-render-'));
  const previous = process.env.FONTCONFIG_FILE;
  try {
    // A font configuration that lists no fonts: the situation of a bare server. Only the bundled directory can supply the letters.
    const noFonts = join(root, 'no-fonts.conf');
    await writeFile(noFonts, '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig></fontconfig>\n', 'utf8');
    process.env.FONTCONFIG_FILE = noFonts;
    const source = await makeSource(root); const captions = join(root, 'captions.ass'); const output = join(root, 'clip.mp4');
    await writeFile(captions, renderAss(buildCaptionChunks(words(['Captions', 0.5, 1.5], ['that', 1.5, 2.2], ['show', 2.2, 3]), 0, 4, 'classic'), 'classic'), 'utf8');
    await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 360, 640).render({ sourcePath: source, startSeconds: 0, endSeconds: 4, outputPath: output, captionPath: captions });
    const during = await look(output, 1.0); const before = await look(output, 0.2);
    assert.equal(before.white, 0, 'nothing is drawn before the first word');
    assert.ok(during.white > 80, `the captions were not drawn: only ${during.white} white pixels`);
  } finally {
    if (previous === undefined) delete process.env.FONTCONFIG_FILE; else process.env.FONTCONFIG_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('highlighted captions light the word being spoken, moving along the line with the speech', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-render-'));
  try {
    const source = await makeSource(root); const captions = join(root, 'captions.ass'); const output = join(root, 'clip.mp4');
    const segments = words(['One', 0.5, 1.5], ['two', 1.5, 2.5], ['six', 2.5, 3.5], ['ten', 3.5, 4.5]);
    const chunks = buildCaptionChunks(segments, 0, 6, 'highlight');
    assert.equal(chunks.length, 1, 'four short words are one group, on one line');
    await writeFile(captions, renderAss(chunks, 'highlight'), 'utf8');
    await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 360, 640).render({ sourcePath: source, startSeconds: 0, endSeconds: 6, outputPath: output, captionPath: captions });
    const centres: number[] = [];
    for (const second of [1.0, 2.0, 3.0, 4.0]) {
      const frame = await look(output, second);
      assert.ok(frame.gold > 20, `no word is lit at ${second}s (${frame.gold} gold pixels)`);
      assert.ok(frame.white > 20, `the other words are not shown in white at ${second}s`);
      centres.push(frame.goldCentreX!);
    }
    for (let index = 1; index < centres.length; index += 1) assert.ok(centres[index] > centres[index - 1] + 10, `the lit word did not move to the right: ${centres.map((value) => Math.round(value)).join(', ')}`);
    assert.equal((await look(output, 5.5)).gold, 0, 'once the group is over nothing is lit');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the .ass file that is burned in keeps its look at the faster, smaller size too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-render-'));
  try {
    const source = await makeSource(root); const captions = join(root, 'captions.ass'); const output = join(root, 'clip.mp4');
    await writeFile(captions, renderAss(buildCaptionChunks(words(['Same', 0.5, 1.5], ['look', 1.5, 2.5]), 0, 4, 'pop'), 'pop'), 'utf8');
    await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 1080, 1920).render({ sourcePath: source, startSeconds: 0, endSeconds: 4, outputPath: output, captionPath: captions, quality: 'standard' });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', output]);
    assert.equal(stdout.trim(), '720,1280');
    const frame = await look(output, 1.0);
    assert.ok(frame.gold > 60, `the lit word is too small or missing: ${frame.gold} gold pixels`);
    assert.ok((await readFile(captions, 'utf8')).includes('PlayResY: 1920'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
