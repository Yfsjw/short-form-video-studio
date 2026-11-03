import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegClipRenderer, isSafeClipIdentifier, resolveClipOutputPath, wholePictureFilter, type FfmpegRunner } from './clips.js';
import { cropXExpression } from './framing.js';
import { SDR_COLOUR_TAGS, TONE_MAP_TO_SDR } from './hdr.js';
import { StudioDatabase } from './database.js';
import type { GeneratedClip, NewVideoJob } from './domain.js';

/** Every picture is first given square pixels (some cameras make pixels that are not), and made an ordinary 8-bit picture before captions are drawn on it. */
const SQUARE = 'scale=trunc(iw*sar/2)*2:ih,setsar=1';
const ORDINARY = 'setsar=1,format=yuv420p';
const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';

test('persists candidate-to-clip mapping and lifecycle fields', async () => {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, `test_clips_${randomUUID().replaceAll('-', '_')}`);
  try {
    const now = new Date().toISOString(); const job: NewVideoJob = { id: 'job', originalFilename: 'source.mp4', storedFilename: 'source.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'processing', stage: 'extracting_clips', errorMessage: null, durationSeconds: 20, width: 1, height: 1, createdAt: now, updatedAt: now }; await db.createJob(job);
    const clip: GeneratedClip = { id: 'clip', jobId: job.id, candidateId: 'candidate', startSeconds: 2, endSeconds: 8, durationSeconds: 6, outputPath: 'job/clip.mp4', outputFilename: 'clip.mp4', status: 'queued', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now, title: null, score: null, reasons: [], framing: null }; await db.createClip(clip); await db.updateClip(clip.id, { status: 'processing' }); await db.updateClip(clip.id, { status: 'completed', captionPath: 'job/clip.srt' });
    const stored = await db.getClip(job.id, clip.id); assert.equal(stored?.candidateId, 'candidate'); assert.equal(stored?.status, 'completed'); assert.equal(stored?.durationSeconds, 6); assert.equal(stored?.captionPath, 'job/clip.srt');
  } finally { await db.close({ dropSchema: true }); }
});

test('accepts only UUID clip and job identifiers for clip paths', () => {
  const id = '1bb34c49-c6eb-4a0c-b286-2cd154e34290';
  assert.ok(isSafeClipIdentifier(id)); assert.equal(isSafeClipIdentifier('../escape'), false); assert.equal(isSafeClipIdentifier('clip.mp4'), false);
  assert.equal(resolveClipOutputPath('/outputs', id, id, `${id}.mp4`), `/outputs/${id}/${id}.mp4`); assert.equal(resolveClipOutputPath('/outputs', id, id, '../escape.mp4'), undefined);
});

test('FFmpeg renderer builds a 9:16 timestamped MP4 command with a mocked process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-')); const outputPath = join(root, 'clip.mp4'); let arguments_: string[] = [];
  try {
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, async (_binary, args) => { arguments_ = args; await writeFile(outputPath, 'mock mp4 bytes'); });
    const rendered = await renderer.render({ sourcePath: join(root, 'source.mp4'), startSeconds: 12.5, endSeconds: 18.25, outputPath });
    assert.equal(rendered.durationSeconds, 5.75); assert.ok(rendered.sizeBytes > 0); assert.deepEqual(arguments_.slice(0, 8), ['-nostdin', '-y', '-ss', '12.500', '-i', join(root, 'source.mp4'), '-t', '5.750']); assert.ok(arguments_.includes('-movflags')); assert.ok(arguments_.includes('-vf')); assert.ok(arguments_.some((arg) => arg.includes('scale=1080:1920')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer is told how many threads to use for decoding, filtering and encoding, in the places FFmpeg means them for, and without a number leaves the command as it always was', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-')); const outputPath = join(root, 'clip.mp4');
  try {
    const argumentsFor = async (threads?: number) => {
      let given: string[] = [];
      const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, async (_binary, args) => { given = args; await writeFile(outputPath, 'mock mp4 bytes'); }, undefined, threads);
      await renderer.render({ sourcePath: join(root, 'source.mp4'), startSeconds: 12.5, endSeconds: 18.25, outputPath });
      return given;
    };
    const without = await argumentsFor(undefined);
    assert.ok(!without.includes('-threads') && !without.includes('-filter_threads'), 'no number, no option');
    const withThreads = await argumentsFor(2);
    assert.deepEqual(withThreads.slice(0, 8), ['-nostdin', '-y', '-filter_threads', '2', '-ss', '12.500', '-threads', '2'], 'the filters, then the decoder (an input option, so in front of the input)');
    assert.equal(withThreads[withThreads.indexOf('-i') - 2], '-threads');
    assert.deepEqual(withThreads.slice(-3), ['-threads', '2', outputPath], 'and the encoder, in front of the output file');
    assert.deepEqual(withThreads.filter((argument) => argument === '-threads').length, 2);
    // Apart from the threads, the command is the same one.
    const stripped = withThreads.filter((argument, index) => !(['-threads', '-filter_threads'].includes(argument) || ['-threads', '-filter_threads'].includes(withThreads[index - 1])));
    assert.deepEqual(stripped, without);
    assert.ok(!(await argumentsFor(0)).includes('-threads'), 'zero is no number');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer cuts from the middle of the picture unless it is given a plan, and then follows the plan frame by frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-framing-')); const outputPath = join(root, 'clip.mp4'); const calls: string[][] = [];
  try {
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, async (_binary, args) => { calls.push(args); await writeFile(outputPath, 'mock mp4 bytes'); });
    const filterOf = (args: string[]) => args[args.indexOf('-vf') + 1];
    const source = join(root, 'source.mp4');

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath });
    assert.equal(filterOf(calls[0]), `${SQUARE},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${ORDINARY}`, 'no plan: the middle, as before, with square pixels in and 8-bit pixels out');
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, framing: null });
    assert.equal(filterOf(calls[1]), filterOf(calls[0]), 'a plan of null means the same as no plan');

    const keyframes = [{ seconds: 0, position: 0.2 }, { seconds: 4, position: 0.2 }, { seconds: 4.5, position: 0.7 }];
    await renderer.render({ sourcePath: source, startSeconds: 20, endSeconds: 30, outputPath, framing: { keyframes } });
    const framed = filterOf(calls[2]);
    assert.equal(framed, `${SQUARE},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:x='${cropXExpression(keyframes)}':y='(in_h-out_h)/2',${ORDINARY}`);
    assert.match(framed, /clip\(\(t-4\)\/0\.5,0,1\)/, 'the move starts at 4 s and takes half a second, counted from the start of the clip');
    assert.deepEqual(calls[2].slice(0, 8), ['-nostdin', '-y', '-ss', '20.000', '-i', source, '-t', '10.000'], 'the seek and the length do not depend on the plan');

    // Captions are drawn after the cut, so they stay where they are whatever the window does.
    await renderer.render({ sourcePath: source, startSeconds: 20, endSeconds: 30, outputPath, captionPath: join(root, 'clip.ass'), framing: { keyframes } });
    assert.ok(filterOf(calls[3]).startsWith(framed + ',ass='), 'the caption filter comes after the moving crop');
    await renderer.render({ sourcePath: source, startSeconds: 20, endSeconds: 30, outputPath, quality: 'standard', framing: { keyframes } });
    assert.match(filterOf(calls[4]), /^scale=trunc\(iw\*sar\/2\)\*2:ih,setsar=1,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280:x='/, 'the faster quality moves the window at its own size');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer lays the whole picture over a blurred copy when asked, whatever plan it is given, and at the size of the chosen quality', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-fit-')); const outputPath = join(root, 'clip.mp4'); const calls: string[][] = [];
  try {
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, async (_binary, args) => { calls.push(args); await writeFile(outputPath, 'mock mp4 bytes'); });
    const filterOf = (args: string[]) => args[args.indexOf('-vf') + 1];
    const source = join(root, 'source.mp4');
    const plan = { keyframes: [{ seconds: 0, position: 0.2 }, { seconds: 2, position: 0.8 }] };

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fit' });
    assert.equal(filterOf(calls[0]), `${SQUARE},${wholePictureFilter({ width: 1080, height: 1920 })},${ORDINARY}`);
    assert.equal(filterOf(calls[0]), `${SQUARE},${[
      'split=2[back][front]',
      '[back]scale=135:240:force_original_aspect_ratio=increase,crop=135:240,boxblur=3:2,scale=1080:1920[blurred]',
      '[front]scale=1080:1920:force_original_aspect_ratio=decrease[picture]',
      '[blurred][picture]overlay=(W-w)/2:(H-h)/2',
    ].join(';')},${ORDINARY}`, 'the copy is made small first, so blurring it is cheap');

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fit', framing: plan });
    assert.equal(filterOf(calls[1]), filterOf(calls[0]), 'nothing is cut off, so a plan for where to cut has no meaning here');
    assert.doesNotMatch(filterOf(calls[1]), /crop=1080|in_w/);

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fit', captionPath: join(root, 'clip.ass') });
    assert.ok(filterOf(calls[2]).startsWith(`${SQUARE},${wholePictureFilter({ width: 1080, height: 1920 })},${ORDINARY},ass=`), 'the captions are drawn on the finished picture');

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fit', quality: 'standard' });
    assert.equal(filterOf(calls[3]), `${SQUARE},${wholePictureFilter({ width: 720, height: 1280 })},${ORDINARY}`);
    assert.match(filterOf(calls[3]), /scale=90:160:force_original_aspect_ratio=increase,crop=90:160/);

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fill' });
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath });
    assert.equal(filterOf(calls[4]), `${SQUARE},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${ORDINARY}`, 'fill is the plain cut from the middle, as it always was');
    assert.equal(filterOf(calls[5]), filterOf(calls[4]), 'and is what happens when no layout is named');
    assert.deepEqual(calls[0].slice(0, 8), ['-nostdin', '-y', '-ss', '0.000', '-i', source, '-t', '10.000'], 'the cut of time is the same in every layout');
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** A runner that notes what it was asked to run and writes a file for the renderer to find, failing as told (an error is thrown for the n-th call that has an entry in `failures`). */
function recordingRunner(outputPath: string, failures: Record<number, unknown> = {}) {
  const calls: string[][] = [];
  const runner: FfmpegRunner = async (_binary, args) => {
    calls.push(args);
    await writeFile(outputPath, 'partly written mp4 bytes');
    if (calls.length in failures) throw failures[calls.length];
  };
  return { calls, runner };
}
const filterOf = (args: string[]) => args[args.indexOf('-vf') + 1];
const valuesAfter = (args: string[], option: string) => args.reduce<string[]>((found, argument, index) => (argument === option ? [...found, args[index + 1]] : found), []);
const ffmpegSaid = (printed: string) => Object.assign(new Error(`Command failed: ffmpeg -vf ${TONE_MAP_TO_SDR}\n${printed}`), { stderr: printed });

test('every clip is an ordinary 8-bit picture with one sound of at most two channels, whatever the video it is cut from', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-playable-')); const outputPath = join(root, 'clip.mp4');
  try {
    const { calls, runner } = recordingRunner(outputPath);
    const rendered = await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, runner).render({ sourcePath: join(root, 'source.mp4'), startSeconds: 1, endSeconds: 6, outputPath });
    assert.equal(calls.length, 1);
    const args = calls[0];
    // 8 bits, 4:2:0: a ten-bit or 4:4:4 picture would be written as H.264 "High 10" or "High 4:4:4", which many phones and browsers cannot play.
    assert.deepEqual(valuesAfter(args, '-pix_fmt'), ['yuv420p']);
    assert.ok(args.indexOf('-pix_fmt') > args.indexOf('-c:v') && args.indexOf('-pix_fmt') < args.indexOf('-c:a'), 'a setting of the picture, given with the picture\'s encoder');
    assert.match(filterOf(args), /,format=yuv420p$/, 'and the filters end in the same pixels, so that the captions are drawn on them');
    // The first sound only, of one or two channels; and a video with no sound is no trouble (the mapping is optional).
    assert.deepEqual(valuesAfter(args, '-map'), ['0:v:0', '0:a:0?']);
    assert.deepEqual(valuesAfter(args, '-af'), ['aformat=channel_layouts=mono|stereo']);
    // Square pixels first, whatever the shape of the pixels of the video was.
    assert.ok(filterOf(args).startsWith('scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=1080:1920'));
    assert.equal(filterOf(args).match(/setsar=1/g)?.length, 2, 'and again after the cut, which leaves the pixels very slightly off square');
    // Nothing of what is for HDR video is used for an ordinary one.
    for (const hdrOnly of ['zscale', 'tonemap', '-color_primaries', '-color_trc', '-colorspace']) assert.ok(!args.some((argument) => argument.includes(hdrOnly)), hdrOnly);
    assert.deepEqual(Object.keys(rendered).sort(), ['durationSeconds', 'sizeBytes'], 'and the clip does not say anything of colours');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an HDR picture is converted to the colours of an ordinary one when the renderer is told its FFmpeg can, and the clip says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-hdr-')); const outputPath = join(root, 'clip.mp4'); const source = join(root, 'source.mov');
  try {
    for (const hdr of ['hlg', 'pq'] as const) {
      const { calls, runner } = recordingRunner(outputPath);
      const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, runner, undefined, undefined, true);
      const rendered = await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 5, outputPath, hdr });
      assert.equal(calls.length, 1, `${hdr}: one go is enough when the conversion works`);
      assert.equal(filterOf(calls[0]), `${SQUARE},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${TONE_MAP_TO_SDR}`, 'the conversion takes the place of the plain 8-bit step, after the cut and before anything is drawn');
      assert.deepEqual(valuesAfter(calls[0], '-pix_fmt'), ['yuv420p']);
      const pixFmt = calls[0].indexOf('-pix_fmt');
      assert.deepEqual(calls[0].slice(pixFmt + 2, pixFmt + 2 + SDR_COLOUR_TAGS.length), [...SDR_COLOUR_TAGS], 'and the clip says what it is now, for the encoder, whatever FFmpeg would have copied from the picture');
      assert.equal(rendered.colours, 'converted');
    }
    // Captions are drawn on the converted picture, and the whole-picture layout is converted after the two pictures are put together.
    const { calls, runner } = recordingRunner(outputPath);
    const renderer = new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, runner, '/fonts', undefined, true);
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 5, outputPath, hdr: 'hlg', captionPath: join(root, 'clip.ass') });
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 5, outputPath, hdr: 'hlg', layout: 'fit' });
    assert.ok(filterOf(calls[0]).startsWith(`${SQUARE},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${TONE_MAP_TO_SDR},ass=`));
    assert.equal(filterOf(calls[1]), `${SQUARE},${wholePictureFilter({ width: 1080, height: 1920 })},setsar=1,${TONE_MAP_TO_SDR}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an HDR picture is only made 8-bit when the renderer is not told its FFmpeg can convert colours, and an ordinary picture is never converted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-no-hdr-')); const outputPath = join(root, 'clip.mp4'); const source = join(root, 'source.mov');
  try {
    for (const toneMapping of [undefined, false]) {
      const { calls, runner } = recordingRunner(outputPath);
      const rendered = await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, runner, undefined, undefined, toneMapping).render({ sourcePath: source, startSeconds: 0, endSeconds: 5, outputPath, hdr: 'hlg' });
      assert.equal(calls.length, 1);
      assert.equal(filterOf(calls[0]), `${SQUARE},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${ORDINARY}`, `${toneMapping}: the clip still plays everywhere`);
      assert.ok(!calls[0].includes('-color_trc'), 'and says nothing the picture does not');
      assert.equal(rendered.colours, 'not converted', 'but the clip is honest that its colours are not those of an ordinary video');
    }
    const { calls, runner } = recordingRunner(outputPath);
    const rendered = await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, runner, undefined, undefined, true).render({ sourcePath: source, startSeconds: 0, endSeconds: 5, outputPath });
    assert.ok(!filterOf(calls[0]).includes('zscale'), 'a picture that is not HDR is not converted, even by a renderer that could');
    assert.equal(rendered.colours, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('when the conversion itself fails the clip is made again without it, once, and the half-written file is not left behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-fallback-')); const outputPath = join(root, 'clip.mp4'); const source = join(root, 'source.mov');
  try {
    const { calls, runner } = recordingRunner(outputPath, { 1: ffmpegSaid('[Parsed_zscale_0 @ 0x55] code 3074: no path between colorspaces\nError while filtering: Generic error in an external library') });
    const seen: boolean[] = [];
    const checking: FfmpegRunner = async (binary, args, options) => { seen.push(calls.length > 0 && (await stat(outputPath).then(() => true, () => false))); await runner(binary, args, options); };
    const rendered = await new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, checking, undefined, undefined, true).render({ sourcePath: source, startSeconds: 0, endSeconds: 5, outputPath, hdr: 'hlg' });
    assert.equal(calls.length, 2);
    assert.ok(filterOf(calls[0]).includes('zscale'));
    assert.equal(filterOf(calls[1]), `${SQUARE},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${ORDINARY}`, 'the second go is the plain 8-bit clip');
    assert.ok(!calls[1].includes('-color_trc'), 'with none of the claims of the first');
    assert.deepEqual(seen, [false, false], 'nothing of the failed go was left in the way of the second');
    assert.equal(rendered.colours, 'not converted');
    assert.ok(rendered.sizeBytes > 0);
    assert.deepEqual(valuesAfter(calls[1], '-ss'), valuesAfter(calls[0], '-ss'), 'the same part of the video');
    assert.deepEqual(valuesAfter(calls[1], '-t'), valuesAfter(calls[0], '-t'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failure that has nothing to do with colours is not tried again, and one that happens in the plain go is reported with what FFmpeg said', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-renderer-no-retry-')); const outputPath = join(root, 'clip.mp4'); const source = join(root, 'source.mov');
  try {
    const renderer = (runner: FfmpegRunner) => new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, runner, undefined, undefined, true);
    const request = { sourcePath: source, startSeconds: 0, endSeconds: 5, outputPath, hdr: 'hlg' as const };

    // The message of the error carries the whole command line, and so names zscale whatever went wrong: only what FFmpeg printed counts.
    const full = recordingRunner(outputPath, { 1: ffmpegSaid('No space left on device') });
    await assert.rejects(renderer(full.runner).render(request), (error: Error) => /^Clip extraction failed: .*; ffmpeg: No space left on device$/s.test(error.message));
    assert.equal(full.calls.length, 1, 'a full disk would only be full a second time, later');
    assert.equal(await stat(outputPath).then(() => true, () => false), false, 'and nothing is left behind');

    const unexplained = recordingRunner(outputPath, { 1: new Error('spawn ffmpeg EAGAIN') });
    await assert.rejects(renderer(unexplained.runner).render(request), /Clip extraction failed: spawn ffmpeg EAGAIN$/);
    assert.equal(unexplained.calls.length, 1, 'an error that says nothing of what FFmpeg printed is not taken for a trouble with colours');

    const both = recordingRunner(outputPath, { 1: ffmpegSaid('[Parsed_zscale_0 @ 0x55] no path between colorspaces'), 2: ffmpegSaid('Invalid data found when processing input') });
    await assert.rejects(renderer(both.runner).render(request), (error: Error) => /Clip extraction failed: .*; ffmpeg: Invalid data found when processing input$/s.test(error.message) && !error.message.includes('colorspaces'));
    assert.equal(both.calls.length, 2, 'the plain go is the last: its failure is the one told');
    assert.equal(await stat(outputPath).then(() => true, () => false), false);

    // Nothing is tried twice when the renderer was not asked to convert anything.
    const plain = recordingRunner(outputPath, { 1: ffmpegSaid('[Parsed_zscale_0 @ 0x55] no path between colorspaces') });
    await assert.rejects(new FfmpegClipRenderer('ffmpeg', 'libx264', 'aac', 23, 'veryfast', 1080, 1920, plain.runner).render(request), /Clip extraction failed/);
    assert.equal(plain.calls.length, 1);

    // And an empty file is still no clip.
    await assert.rejects(renderer(async (_binary, _args) => { await writeFile(outputPath, ''); }).render(request), /non-empty MP4/);
    assert.equal(await stat(outputPath).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
