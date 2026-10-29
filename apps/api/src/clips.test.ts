import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegClipRenderer, isSafeClipIdentifier, resolveClipOutputPath, wholePictureFilter } from './clips.js';
import { cropXExpression } from './framing.js';
import { StudioDatabase } from './database.js';
import type { GeneratedClip, NewVideoJob } from './domain.js';

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
    assert.equal(filterOf(calls[0]), 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', 'no plan: the middle, exactly as before');
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, framing: null });
    assert.equal(filterOf(calls[1]), filterOf(calls[0]), 'a plan of null means the same as no plan');

    const keyframes = [{ seconds: 0, position: 0.2 }, { seconds: 4, position: 0.2 }, { seconds: 4.5, position: 0.7 }];
    await renderer.render({ sourcePath: source, startSeconds: 20, endSeconds: 30, outputPath, framing: { keyframes } });
    const framed = filterOf(calls[2]);
    assert.equal(framed, `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:x='${cropXExpression(keyframes)}':y='(in_h-out_h)/2'`);
    assert.match(framed, /clip\(\(t-4\)\/0\.5,0,1\)/, 'the move starts at 4 s and takes half a second, counted from the start of the clip');
    assert.deepEqual(calls[2].slice(0, 8), ['-nostdin', '-y', '-ss', '20.000', '-i', source, '-t', '10.000'], 'the seek and the length do not depend on the plan');

    // Captions are drawn after the cut, so they stay where they are whatever the window does.
    await renderer.render({ sourcePath: source, startSeconds: 20, endSeconds: 30, outputPath, captionPath: join(root, 'clip.ass'), framing: { keyframes } });
    assert.ok(filterOf(calls[3]).startsWith(framed + ',ass='), 'the caption filter comes after the moving crop');
    await renderer.render({ sourcePath: source, startSeconds: 20, endSeconds: 30, outputPath, quality: 'standard', framing: { keyframes } });
    assert.match(filterOf(calls[4]), /^scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280:x='/, 'the faster quality moves the window at its own size');
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
    assert.equal(filterOf(calls[0]), wholePictureFilter({ width: 1080, height: 1920 }));
    assert.equal(filterOf(calls[0]), [
      'split=2[back][front]',
      '[back]scale=135:240:force_original_aspect_ratio=increase,crop=135:240,boxblur=3:2,scale=1080:1920[blurred]',
      '[front]scale=1080:1920:force_original_aspect_ratio=decrease[picture]',
      '[blurred][picture]overlay=(W-w)/2:(H-h)/2',
    ].join(';'), 'the copy is made small first, so blurring it is cheap');

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fit', framing: plan });
    assert.equal(filterOf(calls[1]), filterOf(calls[0]), 'nothing is cut off, so a plan for where to cut has no meaning here');
    assert.doesNotMatch(filterOf(calls[1]), /crop=1080|in_w/);

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fit', captionPath: join(root, 'clip.ass') });
    assert.ok(filterOf(calls[2]).startsWith(`${wholePictureFilter({ width: 1080, height: 1920 })},ass=`), 'the captions are drawn on the finished picture');

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fit', quality: 'standard' });
    assert.equal(filterOf(calls[3]), wholePictureFilter({ width: 720, height: 1280 }));
    assert.match(filterOf(calls[3]), /scale=90:160:force_original_aspect_ratio=increase,crop=90:160/);

    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath, layout: 'fill' });
    await renderer.render({ sourcePath: source, startSeconds: 0, endSeconds: 10, outputPath });
    assert.equal(filterOf(calls[4]), 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', 'fill is the plain cut from the middle, as it always was');
    assert.equal(filterOf(calls[5]), filterOf(calls[4]), 'and is what happens when no layout is named');
    assert.deepEqual(calls[0].slice(0, 8), ['-nostdin', '-y', '-ss', '0.000', '-i', source, '-t', '10.000'], 'the cut of time is the same in every layout');
  } finally { await rm(root, { recursive: true, force: true }); }
});
