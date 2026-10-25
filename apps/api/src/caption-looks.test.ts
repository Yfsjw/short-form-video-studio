import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { buildCaptionChunks, captionCanvas, captionLookFor, renderAss, type CaptionChoices, type CaptionSegmentInput, type VisibleCaptionStyle } from './captions.js';
import { FfmpegClipRenderer } from './clips.js';
import { aspectChoices, captionAccents, captionPositions, captionSizes, type AspectChoice, type CaptionAccent, type CaptionPosition, type CaptionSize } from './domain.js';

// These tests run the real FFmpeg (and its caption renderer) for every colour, place and size of captions and read the result from single pixels:
// where the text is, what colour the spoken word is and how tall the letters are.
const run = promisify(execFile);

let directory = '';
const path = (name: string) => join(directory, name);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-caption-looks-'));
  // A dark-blue picture with a tone: the only white or bright colour in a finished clip is the captions.
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x203060:s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path('dark.mp4')]);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const choose = (choices: Partial<CaptionChoices>): CaptionChoices => ({ accent: 'gold', position: 'lower', size: 'medium', ...choices });
const words = (...items: Array<[string, number, number]>): CaptionSegmentInput[] => [{ startSeconds: 0, endSeconds: 4, text: items.map((item) => item[0]).join(' '), words: items.map(([text, startSeconds, endSeconds]) => ({ text, startSeconds, endSeconds })) }];
/** One short word, on screen from half a second to two and a half: one line in every shape and size, so its height is the height of a line of letters. */
const HOME = words(['HOME', 0.5, 2.5]);

interface Frame { width: number; height: number; pixel: (x: number, y: number) => { r: number; g: number; b: number } }
async function frameOf(file: string, seconds: number): Promise<Frame> {
  const { stdout: size } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [width, height] = size.trim().split(',').map(Number);
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-nostdin', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: width * height * 3 + 4096 });
  assert.equal(stdout.length, width * height * 3, `no whole frame could be read at ${seconds}s`);
  return { width, height, pixel: (x, y) => { const at = (y * width + x) * 3; return { r: stdout[at], g: stdout[at + 1], b: stdout[at + 2] }; } };
}

/** Where the pixels that satisfy a test are: the box around them, how many there are, and their middle. */
function find(frame: Frame, wanted: (r: number, g: number, b: number) => boolean) {
  let left = frame.width; let right = -1; let top = frame.height; let bottom = -1; let count = 0; let sumX = 0; let sumY = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    const { r, g, b } = frame.pixel(x, y);
    if (!wanted(r, g, b)) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); count += 1; sumX += x; sumY += y;
  }
  return { left, right, top, bottom, count, centreX: count ? sumX / count : NaN, centreY: count ? sumY / count : NaN };
}
const isWhite = (r: number, g: number, b: number) => r > 235 && g > 235 && b > 235;

/** The hue of a colour in degrees, and whether it is a strong colour at all (not white, grey, black or the dark blue of the picture). */
function hueOf(r: number, g: number, b: number) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  if (max < 140 || (max - min) / max < 0.5) return null;
  const delta = max - min;
  const hue = max === r ? 60 * (((g - b) / delta + 6) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  return hue;
}
/** The hues the accents are meant to have (gold, green, cyan, pink, red): a rendered colour is called by the nearest of these. */
const ACCENT_HUES: Record<CaptionAccent, number> = { gold: 51, green: 130, cyan: 186, pink: 331, red: 3 };
function accentOf(r: number, g: number, b: number): CaptionAccent | null {
  const hue = hueOf(r, g, b);
  if (hue === null) return null;
  const distance = (accent: CaptionAccent) => { const gap = Math.abs(hue - ACCENT_HUES[accent]); return Math.min(gap, 360 - gap); };
  return [...captionAccents].sort((a, b) => distance(a) - distance(b))[0];
}

async function render(name: string, base: { width: number; height: number }, aspect: AspectChoice, style: VisibleCaptionStyle, segments: CaptionSegmentInput[], choices: CaptionChoices) {
  const captions = path(`${name}.ass`); const output = path(`${name}.mp4`);
  await writeFile(captions, renderAss(buildCaptionChunks(segments, 0, 4, style, choices.size), style, aspect, choices), 'utf8');
  await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', base.width, base.height).render({ sourcePath: path('dark.mp4'), startSeconds: 0, endSeconds: 4, outputPath: output, aspect, captionPath: captions });
  return output;
}

test('plain and highlighted captions go where they were asked to in every shape: the lower part, the middle or the top', async () => {
  for (const aspect of aspectChoices) {
    const centres: Partial<Record<CaptionPosition, number>> = {};
    for (const position of captionPositions) {
      for (const style of ['classic', 'highlight'] as const) {
        const file = await render(`position-${aspect}-${position}-${style}`, { width: 360, height: 640 }, aspect, style, HOME, choose({ position }));
        const frame = await frameOf(file, 1.5);
        const text = find(frame, (r, g, b) => isWhite(r, g, b) || accentOf(r, g, b) !== null);
        assert.ok(text.count > 50 && text.bottom > text.top, `${aspect} ${position} ${style}: no captions were drawn`);
        const look = captionLookFor(style, aspect, choose({ position }));
        const canvasHeight = captionCanvas[aspect].height;
        if (position === 'lower') {
          const lineBottom = (1 - look.marginV / canvasHeight) * frame.height;
          assert.ok(text.bottom <= lineBottom + 1 && text.bottom >= lineBottom - 0.06 * frame.height, `${aspect} ${style}: the lower text ends at ${(text.bottom / frame.height * 100).toFixed(1)}% of the height, expected just above ${(lineBottom / frame.height * 100).toFixed(1)}%`);
        }
        if (position === 'top') {
          const lineTop = (look.marginV / canvasHeight) * frame.height;
          assert.ok(text.top >= lineTop - 1 && text.top <= lineTop + 0.06 * frame.height, `${aspect} ${style}: the top text starts at ${(text.top / frame.height * 100).toFixed(1)}% of the height, expected just below ${(lineTop / frame.height * 100).toFixed(1)}%`);
        }
        if (position === 'middle') assert.ok(Math.abs((text.top + text.bottom) / 2 / frame.height - 0.5) < 0.04, `${aspect} ${style}: the middle text is centred at ${((text.top + text.bottom) / 2 / frame.height * 100).toFixed(1)}%`);
        assert.ok(text.left > 0.03 * frame.width && text.right < 0.97 * frame.width, `${aspect} ${position} ${style}: the text runs into the side edge`);
        assert.ok(Math.abs((text.left + text.right) / 2 - frame.width / 2) < 0.04 * frame.width, `${aspect} ${position} ${style}: the text is not in the middle of the width`);
        if (style === 'classic') centres[position] = (text.top + text.bottom) / 2 / frame.height;
      }
    }
    assert.ok(centres.top! + 0.08 < centres.middle! && centres.middle! + 0.08 < centres.lower!, `${aspect}: top, middle and lower are not in that order, clearly apart (${captionPositions.map((position) => `${position} ${(centres[position]! * 100).toFixed(0)}%`).join(', ')})`);
  }
});

test('the big pop-in words go where they were asked to as well', async () => {
  for (const aspect of ['vertical', 'square', 'landscape'] as const) {
    const centres: Partial<Record<CaptionPosition, number>> = {};
    for (const position of captionPositions) {
      const file = await render(`pop-position-${aspect}-${position}`, { width: 360, height: 640 }, aspect, 'pop', HOME, choose({ position }));
      // The word has finished popping in a moment after it appears.
      const frame = await frameOf(file, 1.5);
      const text = find(frame, (r, g, b) => isWhite(r, g, b) || accentOf(r, g, b) !== null);
      assert.ok(text.count > 50, `${aspect} ${position}: no captions were drawn`);
      centres[position] = (text.top + text.bottom) / 2 / frame.height;
      assert.ok(text.top > 0.02 * frame.height && text.bottom < 0.98 * frame.height, `${aspect} ${position}: the words run into the top or bottom edge`);
      assert.ok(text.left > 0.03 * frame.width && text.right < 0.97 * frame.width, `${aspect} ${position}: the words run into the side edge`);
    }
    assert.ok(Math.abs(centres.middle! - 0.5) < 0.04, `${aspect}: the middle is at ${(centres.middle! * 100).toFixed(1)}%`);
    assert.ok(centres.top! + 0.08 < centres.middle! && centres.middle! + 0.04 < centres.lower!, `${aspect}: not in the order top, middle, lower (${captionPositions.map((position) => `${position} ${(centres[position]! * 100).toFixed(0)}%`).join(', ')})`);
  }
});

test('the spoken word is lit in the colour that was chosen, the other words stay white, and the lit word moves along with the speech', async () => {
  const spoken = words(['HOME', 0.5, 1.5], ['NOW', 1.5, 2.5]);
  for (const style of ['highlight', 'pop'] as const) {
    for (const accent of captionAccents) {
      const file = await render(`accent-${style}-${accent}`, { width: 540, height: 960 }, 'vertical', style, spoken, choose({ accent }));
      const first = await frameOf(file, 1.0); const second = await frameOf(file, 2.0);
      for (const [frame, which] of [[first, 'first'], [second, 'second']] as const) {
        const counts = new Map<CaptionAccent, number>();
        const lit = find(frame, (r, g, b) => { const colour = accentOf(r, g, b); if (colour) counts.set(colour, (counts.get(colour) ?? 0) + 1); return colour !== null; });
        const white = find(frame, isWhite);
        assert.ok((counts.get(accent) ?? 0) >= 120, `${style} ${accent}, ${which} word: only ${counts.get(accent) ?? 0} pixels are ${accent} (${[...counts].map(([name, count]) => `${name} ${count}`).join(', ')})`);
        assert.ok((counts.get(accent) ?? 0) >= 0.85 * lit.count, `${style} ${accent}, ${which} word: other colours are drawn too (${[...counts].map(([name, count]) => `${name} ${count}`).join(', ')})`);
        assert.ok(white.count >= 100, `${style} ${accent}, ${which} word: the other word is not white (${white.count} white pixels)`);
        if (which === 'first') assert.ok(lit.centreX < white.centreX, `${style} ${accent}: the first word is lit, so the colour is to the left of the white`);
        else assert.ok(lit.centreX > white.centreX, `${style} ${accent}: the second word is lit, so the colour is to the right of the white`);
      }
    }
  }
});

test('plain phrases stay white whatever colour is chosen, because no word is lit', async () => {
  const file = await render('classic-pink', { width: 540, height: 960 }, 'vertical', 'classic', words(['HOME', 0.5, 1.5], ['NOW', 1.5, 2.5]), choose({ accent: 'pink' }));
  const frame = await frameOf(file, 1.0);
  assert.equal(find(frame, (r, g, b) => accentOf(r, g, b) !== null).count, 0, 'no colour is drawn');
  assert.ok(find(frame, isWhite).count >= 200, 'the phrase is white');
});

test('the letters are as large as the size that was chosen, in every shape, and the text never runs off the picture', async () => {
  const heights: Partial<Record<CaptionSize, number>> = {};
  for (const size of captionSizes) {
    const file = await render(`size-${size}`, { width: 540, height: 960 }, 'vertical', 'classic', HOME, choose({ size }));
    const text = find(await frameOf(file, 1.5), isWhite);
    assert.ok(text.count > 100, `${size}: no captions were drawn`);
    heights[size] = text.bottom - text.top + 1;
  }
  const small = heights.small! / heights.medium!; const large = heights.large! / heights.medium!;
  assert.ok(small > 0.72 && small < 0.88, `small letters are ${small.toFixed(2)} times as tall as the usual ones (${heights.small} and ${heights.medium} pixels)`);
  assert.ok(large > 1.15 && large < 1.35, `large letters are ${large.toFixed(2)} times as tall as the usual ones (${heights.large} and ${heights.medium} pixels)`);

  // The largest letters, the widest words, the edges of every shape and every place: nothing is cut off.
  const wide = words(['Telecommunications', 0.5, 2.5]);
  const sentence = words(['International', 0.5, 1], ['businesses', 1, 1.5], ['understand', 1.5, 2], ['responsibility', 2, 2.5], ['differently', 2.5, 3]);
  for (const aspect of aspectChoices) {
    for (const position of captionPositions) {
      for (const [segments, label, seconds] of [[wide, 'a very long word', 1.5], [sentence, 'a long sentence', 1.2]] as const) {
        const style: VisibleCaptionStyle = label === 'a very long word' ? 'classic' : 'highlight';
        const file = await render(`edges-${aspect}-${position}-${label === 'a very long word' ? 'word' : 'sentence'}`, { width: 360, height: 640 }, aspect, style, segments, choose({ position, size: 'large' }));
        const frame = await frameOf(file, seconds);
        const text = find(frame, (r, g, b) => isWhite(r, g, b) || accentOf(r, g, b) !== null);
        assert.ok(text.count > 50, `${aspect} ${position}, ${label}: no captions were drawn`);
        assert.ok(text.left > 0.02 * frame.width && text.right < 0.98 * frame.width, `${aspect} ${position}, ${label}, large: runs into the side edge (${text.left}..${text.right} of ${frame.width})`);
        assert.ok(text.top > 0.02 * frame.height && text.bottom < 0.98 * frame.height, `${aspect} ${position}, ${label}, large: runs into the top or bottom edge (${text.top}..${text.bottom} of ${frame.height})`);
      }
    }
  }
});
