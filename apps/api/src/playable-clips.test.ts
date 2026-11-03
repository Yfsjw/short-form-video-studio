import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { writeAssCaptions } from './captions.js';
import { FfmpegClipRenderer } from './clips.js';
import { FfmpegAdapter } from './ffmpeg.js';
import { SAYS_HLG, SAYS_PQ, probeToneMapping, saysColours, type HdrKind } from './hdr.js';

/**
 * The clips of every kind of video a phone or a camera makes, made by the real renderer with the real FFmpeg of this machine and looked at again with
 * ffprobe: they have to be pictures and sounds that play everywhere. The videos are made up here (FFV1 and PCM in Matroska, which every FFmpeg can write),
 * saying what an iPhone, an Android phone, a camera or a cinema recording say about themselves.
 */
const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
// On a developer machine without ffmpeg these tests are skipped; in CI they must never be skipped silently.
if (!hasFfmpeg && process.env.CI) throw new Error('ffmpeg must be installed in CI so that clips are really made from every kind of video.');
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg is not installed on this machine' };

let dir = '';
before(async () => { dir = await mkdtemp(join(tmpdir(), 'studio-playable-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const ffmpeg = (...args: string[]) => run('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...args]);
const SIZE = { width: 144, height: 256 };
/** A dark picture with a white bar down its left edge, two seconds long. */
const picture = (conversion: string) => ['-f', 'lavfi', '-i', `color=c=0x202020:s=320x180:r=10:d=2,drawbox=x=0:y=0:w=24:h=180:color=white:t=fill,${conversion}`];
const sound = (hz: number) => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`];
/** What the pictures say about their colours (see `saysColours`: encoder options are not enough on FFmpeg 8, and tags given where the picture is made are lost by FFmpeg 5.1). */
const HLG = ['-vf', SAYS_HLG];
const PQ = ['-vf', SAYS_PQ];

interface Kind { description: string; make: (path: string) => Promise<unknown>; hdr?: HdrKind; sounds: number; }
const kinds: Record<string, Kind> = {
  'iPhone HDR (ten bits, BT.2020, HLG)': { hdr: 'hlg', sounds: 1, description: 'hlg', make: (path) => ffmpeg(...picture('format=yuv420p10le'), ...sound(440), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', ...HLG, '-c:a', 'pcm_s16le', path) },
  'HDR10 (ten bits, BT.2020, PQ)': { hdr: 'pq', sounds: 1, description: 'pq', make: (path) => ffmpeg(...picture('format=yuv420p10le'), ...sound(440), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', ...PQ, '-c:a', 'pcm_s16le', path) },
  'ten bits with no word on the colours': { sounds: 1, description: 'ten-bit', make: (path) => ffmpeg(...picture('format=yuv420p10le'), ...sound(440), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', '-c:a', 'pcm_s16le', path) },
  'full colour detail (4:4:4)': { sounds: 1, description: '444', make: (path) => ffmpeg(...picture('format=yuv444p'), ...sound(440), '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', '-c:a', 'pcm_s16le', path) },
  'pixels that are not square (4:3)': { sounds: 1, description: 'anamorphic', make: (path) => ffmpeg(...picture('setsar=4/3,format=yuv420p'), ...sound(440), '-c:v', 'ffv1', '-c:a', 'pcm_s16le', path) },
  'six channels of sound (5.1)': { sounds: 1, description: 'surround', make: (path) => ffmpeg(...picture('format=yuv420p'), ...sound(440), '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-ac', '6', path) },
  'two sounds (two languages)': { sounds: 1, description: 'two-sounds', make: (path) => ffmpeg(...picture('format=yuv420p'), ...sound(440), ...sound(880), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', path) },
  'no sound at all': { sounds: 0, description: 'silent', make: (path) => ffmpeg(...picture('format=yuv420p'), '-c:v', 'ffv1', path) },
  'an ordinary video': { sounds: 1, description: 'ordinary', make: (path) => ffmpeg(...picture('format=yuv420p'), ...sound(440), '-c:v', 'ffv1', '-c:a', 'pcm_s16le', path) },
};

interface Stream { codec_type: string; profile?: string; pix_fmt?: string; width?: number; height?: number; sample_aspect_ratio?: string; display_aspect_ratio?: string; channels?: number; color_space?: string; color_transfer?: string; color_primaries?: string }
async function look(path: string): Promise<{ streams: Stream[]; duration: number }> {
  const fields = 'stream=codec_type,profile,pix_fmt,width,height,sample_aspect_ratio,display_aspect_ratio,channels,color_space,color_transfer,color_primaries:format=duration';
  const out = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', fields, '-of', 'json', path])).stdout) as { streams: Stream[]; format: { duration: string } };
  return { streams: out.streams, duration: Number(out.format.duration) };
}
/** Every picture of a clip as plain grey, one byte a pixel. */
async function pictures(path: string): Promise<Buffer[]> {
  const { stdout } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const size = SIZE.width * SIZE.height;
  return Array.from({ length: stdout.length / size }, (_unused, index) => stdout.subarray(index * size, (index + 1) * size));
}

test('a clip made from any kind of video is an 8-bit picture that plays everywhere, with square pixels and one sound of at most two channels', needsFfmpeg, async (t) => {
  const support = await probeToneMapping('ffmpeg');
  t.diagnostic(`converting HDR colours with this FFmpeg: works=${support.works} (${support.detail})`);
  const adapter = new FfmpegAdapter('ffprobe', 'ffmpeg');
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 28, 'ultrafast', SIZE.width, SIZE.height, undefined, undefined, undefined, support.works);
  for (const [name, kind] of Object.entries(kinds)) {
    const source = join(dir, `${kind.description}.mkv`);
    await kind.make(source);
    const seen = await adapter.probe(source);
    assert.equal(seen.hdr, kind.hdr, `${name}: the kind of HDR it was looked at to be`);
    assert.equal(seen.hasAudio, kind.sounds > 0, `${name}: whether it has sound`);
    const output = join(dir, `${kind.description}.mp4`);
    const rendered = await renderer.render({ sourcePath: source, startSeconds: 0.2, endSeconds: 1.2, outputPath: output, ...(seen.hdr ? { hdr: seen.hdr } : {}) });
    const { streams, duration } = await look(output);
    const video = streams.filter((stream) => stream.codec_type === 'video'); const audio = streams.filter((stream) => stream.codec_type === 'audio');

    assert.equal(video.length, 1, name);
    assert.equal(video[0].pix_fmt, 'yuv420p', `${name}: 8 bits, 4:2:0`);
    assert.ok(['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(video[0].profile ?? '?'), `${name}: a profile that plays everywhere, not "${video[0].profile}"`);
    assert.deepEqual([video[0].width, video[0].height], [SIZE.width, SIZE.height], name);
    assert.ok([undefined, '1:1', '0:1', 'N/A'].includes(video[0].sample_aspect_ratio), `${name}: square pixels, not ${video[0].sample_aspect_ratio}`);
    assert.ok(video[0].display_aspect_ratio === undefined || video[0].display_aspect_ratio === '9:16', `${name}: shown as 9:16, not ${video[0].display_aspect_ratio}`);
    assert.equal(audio.length, kind.sounds, `${name}: ${kind.sounds ? 'the first sound is kept and no other' : 'no sound is made up'}`);
    for (const one of audio) assert.ok((one.channels ?? 9) <= 2, `${name}: at most two channels, not ${one.channels}`);
    assert.ok(Math.abs(duration - 1) < 0.15, `${name}: the length asked for, not ${duration}`);
    assert.ok(rendered.sizeBytes > 0);

    if (!kind.hdr) { assert.equal(rendered.colours, undefined, `${name}: an ordinary picture says nothing about colours`); continue; }
    assert.equal(rendered.colours, support.works ? 'converted' : 'not converted', `${name}: converted exactly when this FFmpeg can`);
    if (support.works) for (const tag of ['color_space', 'color_transfer', 'color_primaries'] as const) assert.equal(video[0][tag], 'bt709', `${name}: it says it has the colours of an ordinary video (${tag})`);
  }
});

test('the colours of an HDR picture are those of an ordinary one when this FFmpeg converts them: the picture is still a bright bar on a dark ground, the whole picture is shown, and captions are drawn on it', needsFfmpeg, async (t) => {
  const support = await probeToneMapping('ffmpeg');
  if (!support.works) return; // what happens then is the other half of the test above: the clip is only made 8-bit
  const adapter = new FfmpegAdapter('ffprobe', 'ffmpeg');
  const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'ultrafast', SIZE.width, SIZE.height, undefined, undefined, undefined, true);
  for (const name of ['iPhone HDR (ten bits, BT.2020, HLG)', 'HDR10 (ten bits, BT.2020, PQ)']) {
    const kind = kinds[name];
    const source = join(dir, `${kind.description}.mkv`);
    await kind.make(source);
    const seen = await adapter.probe(source);
    assert.ok(seen.hdr, name);
    const output = join(dir, `${kind.description}-whole.mp4`);
    const rendered = await renderer.render({ sourcePath: source, startSeconds: 0.2, endSeconds: 1.2, outputPath: output, layout: 'fit', hdr: seen.hdr });
    assert.equal(rendered.colours, 'converted', name);
    const frames = await pictures(output);
    const frame = frames[Math.floor(frames.length / 2)];
    const at = (x: number, y: number) => frame[y * SIZE.width + x];
    t.diagnostic(`${name}: the bar is ${at(4, 128)} and the ground ${at(72, 128)} out of 255`);
    assert.ok(at(4, 128) >= 150, `${name}: the white bar is still bright (${at(4, 128)})`);
    assert.ok(at(72, 128) <= 90, `${name}: the dark ground is still dark (${at(72, 128)})`);
    assert.ok(at(72, 128) < at(4, 128) - 80, name);

    // The captions are drawn after the conversion, on the picture that people will see.
    const captions = join(dir, `${kind.description}.ass`);
    await writeAssCaptions(captions, [{ startSeconds: 0, endSeconds: 1, text: 'Caption check' }], 0, 1, 'classic');
    const captioned = join(dir, `${kind.description}-captioned.mp4`);
    const withCaptions = await renderer.render({ sourcePath: source, startSeconds: 0.2, endSeconds: 1.2, outputPath: captioned, captionPath: captions, hdr: seen.hdr });
    assert.equal(withCaptions.colours, 'converted', name);
    const shown = await pictures(captioned);
    const middle = shown[Math.floor(shown.length / 2)];
    let bright = 0; for (const value of middle) if (value >= 200) bright += 1;
    assert.ok(bright >= 12, `${name}: the captions are drawn (${bright} bright points where the words should be)`);
  }
});

test('a video that says only some of what HDR colours need still gives a clip that plays, converted if FFmpeg can and only made 8-bit if it cannot', needsFfmpeg, async () => {
  const support = await probeToneMapping('ffmpeg');
  const source = join(dir, 'half-said.mkv');
  await ffmpeg(...picture('format=yuv420p10le'), ...sound(440), '-vf', saysColours({ transfer: 'arib-std-b67' }), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', '-c:a', 'pcm_s16le', source);
  const seen = await new FfmpegAdapter('ffprobe', 'ffmpeg').probe(source);
  assert.equal(seen.hdr, 'hlg', 'the curve alone is what tells it is HDR');
  const output = join(dir, 'half-said.mp4');
  const rendered = await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 28, 'ultrafast', SIZE.width, SIZE.height, undefined, undefined, undefined, support.works).render({ sourcePath: source, startSeconds: 0.2, endSeconds: 1.2, outputPath: output, hdr: 'hlg' });
  const video = (await look(output)).streams.find((stream) => stream.codec_type === 'video')!;
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.ok(['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(video.profile ?? '?'));
  if (rendered.colours === 'converted') assert.equal(video.color_transfer, 'bt709');
  else assert.equal(rendered.colours, 'not converted');
});
