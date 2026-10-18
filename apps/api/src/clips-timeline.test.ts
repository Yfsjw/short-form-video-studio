import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FfmpegClipRenderer } from './clips.js';

const run = promisify(execFile);

/** The colour of one pixel of the frame that is on screen `seconds` into `video`. */
async function pixelAt(video: string, seconds: number, x: number, y: number) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-nostdin', '-ss', String(seconds), '-i', video, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 });
  assert.equal(stdout.length, 3, `no frame could be read at ${seconds}s`);
  return { r: stdout[0], g: stdout[1], b: stdout[2] };
}

const isWhite = (pixel: { r: number; g: number; b: number }) => pixel.r > 200 && pixel.g > 200 && pixel.b > 200;
const isBlue = (pixel: { r: number; g: number; b: number }) => pixel.r < 70 && pixel.g < 70 && pixel.b > 150;

/**
 * A caption file whose only cue (0.5 s to 1.5 s, counted from the start of the clip) paints the whole frame white. A drawing is
 * used instead of text so the test does not depend on which fonts the machine happens to have: what is being checked is WHEN
 * the cue is on screen.
 */
const WHITE_FLASH_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 360
PlayResY: 640

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,{\\p1\\an7\\pos(0,0)\\1c&HFFFFFF&\\bord0\\shad0}m 0 0 l 360 0 360 640 0 640{\\p0}
`;

test('captions follow the clip: a cue 0.5 s into a clip that starts 6.4 s into the video is shown 0.5 s into the clip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-timeline-'));
  try {
    const source = join(root, 'source.mp4'); const captions = join(root, 'flash.ass'); const output = join(root, 'clip.mp4');
    // A plain blue video (12 s, a key frame every second) with a tone, so there is audio to cut as well.
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-shortest', source]);
    await writeFile(captions, WHITE_FLASH_ASS, 'utf8');
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 30, 'ultrafast', 360, 640);
    // 6.4 s is deliberately not on a key frame.
    await renderer.render({ sourcePath: source, startSeconds: 6.4, endSeconds: 10.4, outputPath: output, captionPath: captions });

    assert.ok(isBlue(await pixelAt(output, 0.2, 180, 320)), 'before the cue the picture is plain');
    assert.ok(isWhite(await pixelAt(output, 1.0, 180, 320)), 'the cue must be on screen 1.0 s into the clip');
    assert.ok(isBlue(await pixelAt(output, 2.5, 180, 320)), 'after the cue the picture is plain again');
    assert.ok(isBlue(await pixelAt(output, 3.5, 180, 320)), 'the cue must not come back later in the clip');
  } finally { await rm(root, { recursive: true, force: true }); }
});
