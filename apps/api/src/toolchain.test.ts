import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { BUNDLED_FONTS_DIRECTORY } from './clips.js';
import { MIN_MODEL_BYTES, REQUIRED_FILTERS, SPEECH_SAMPLE_PATH, SPEECH_SAMPLE_TEXT, ToolchainMonitor, checkToolchain, countAtLeast, fontChosenIn, helpShowsEncoder, helpShowsFilter, isBundledFont, judgeSpeechSample, listsEncoder, listsFilter, pixelAt, shareOfWordsHeard, versionOf, type ToolchainCheckOptions, type ToolchainReport } from './toolchain.js';
import type { TranscriptInput } from './transcription.js';
import { sleep, speechSampleJson, writeFakeWhisper } from './test-support.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
// On a developer machine without ffmpeg these tests are skipped; in CI they must never be skipped silently.
if (!hasFfmpeg && process.env.CI) throw new Error('ffmpeg must be installed in CI so that the toolchain check is really tried.');
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg is not installed on this machine' };

// ---- reading what FFmpeg says about itself ------------------------------------------------------------------------------------

const VERSION_TEXT = `ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers
built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)
configuration: --prefix=/usr --enable-gpl --enable-libass --enable-libx264
libavutil      58. 29.100 / 58. 29.100
`;
const ENCODERS_TEXT = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx264rgb           libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 RGB (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
 S..... ssa                  ASS (Advanced SubStation Alpha) subtitle (codec ass)
`;
const FILTERS_TEXT = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 ... abench            A->A       Benchmark part of a filtergraph.
 ... ass               V->V       Render ASS subtitles onto input video using the libass library.
 T.C boxblur           V->V       Apply boxblur algorithm to input video.
 .S. crop              V->V       Crop the input video.
 TSC overlay           VV->V      Overlay a video source on top of the input.
 ... scale             V->V       Scale the input video size and/or convert the image format.
 ... split             V->N       Pass on the input to N video outputs.
 ... subtitles         V->V       Render text subtitles onto input video using the libass library.
`;

// Copied from a CI run on the GitHub runner of October 2026 (ffmpeg 8.0.1-3ubuntu2): the flags before a filter's name went from three characters to two.
const FFMPEG_8_FILTERS_TEXT = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.
 .. ass               V->V       Render ASS subtitles onto input video using the libass library.
 .. crop              V->V       Crop the input video.
 T. cropdetect        V->V       Auto-detect crop size.
`;

test('the version, the encoders and the filters are read from FFmpeg\'s own listings, and look-alikes are not mistaken for them', () => {
  assert.equal(versionOf(VERSION_TEXT, 'ffmpeg'), '6.1.1-3ubuntu5');
  assert.equal(versionOf(VERSION_TEXT, 'ffprobe'), null, 'ffprobe prints its own name');
  assert.equal(versionOf('ffprobe version 4.4.2-0ubuntu0.22.04.1 Copyright', 'ffprobe'), '4.4.2-0ubuntu0.22.04.1');
  assert.equal(versionOf('bash: ffmpeg: command not found', 'ffmpeg'), null);

  assert.ok(listsEncoder(ENCODERS_TEXT, 'libx264'));
  assert.ok(listsEncoder(ENCODERS_TEXT, 'libx264rgb'));
  assert.ok(listsEncoder(ENCODERS_TEXT, 'aac'));
  assert.ok(!listsEncoder(ENCODERS_TEXT, 'libx26'), 'a name that is only the start of another one');
  assert.ok(!listsEncoder(ENCODERS_TEXT, 'h264'), 'the codec named in brackets is not an encoder');
  assert.ok(!listsEncoder(ENCODERS_TEXT, 'libx265'));
  assert.ok(!listsEncoder(ENCODERS_TEXT, 'Video'), 'the legend is not a list of encoders');

  for (const name of ['ass', 'boxblur', 'crop', 'overlay', 'scale', 'split']) assert.ok(listsFilter(FILTERS_TEXT, name), name);
  assert.ok(!listsFilter(FILTERS_TEXT, 'as'));
  assert.ok(!listsFilter(FILTERS_TEXT, 'sub'));
  assert.ok(!listsFilter(FILTERS_TEXT.replace(/^ \.\.\. ass .*\n/m, ''), 'ass'), 'a build without the caption library lists no `ass`');
  assert.ok(listsFilter(FILTERS_TEXT.replace(/^ \.\.\. ass .*\n/m, ''), 'subtitles'), '...and the text above shows that `subtitles` alone is no substitute');
  assert.deepEqual([...REQUIRED_FILTERS], ['ass', 'crop', 'scale', 'split', 'boxblur', 'overlay']);

  // The listing of FFmpeg 8, as a real runner printed it: two flag characters, not three.
  for (const name of ['aap', 'ass', 'crop', 'cropdetect']) assert.ok(listsFilter(FFMPEG_8_FILTERS_TEXT, name), name);
  assert.ok(!listsFilter(FFMPEG_8_FILTERS_TEXT, 'cro'));
  assert.ok(!listsFilter(FFMPEG_8_FILTERS_TEXT, 'subtitles'));
  assert.ok(!listsFilter(FFMPEG_8_FILTERS_TEXT.replace(/^ \.\. ass .*\n/m, ''), 'ass'), 'a build without the caption library lists no `ass`');
});

test('the help FFmpeg prints for one filter or encoder tells whether it exists, whatever layout the listings have', () => {
  const assHelp = 'Filter ass\n  Render ASS subtitles onto input video using the libass library.\n    Inputs:\n       #0: default (video)\n';
  assert.ok(helpShowsFilter(assHelp, 'ass'));
  assert.ok(!helpShowsFilter(assHelp, 'as'));
  assert.ok(!helpShowsFilter(assHelp, 'subtitles'));
  assert.ok(!helpShowsFilter("Unknown filter 'ass'.\n", 'ass'));
  assert.ok(!helpShowsFilter('', 'ass'));
  const x264Help = 'Encoder libx264 [libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10]:\n    General capabilities: dr1 delay threads \n';
  assert.ok(helpShowsEncoder(x264Help, 'libx264'));
  assert.ok(!helpShowsEncoder(x264Help, 'libx26'));
  assert.ok(!helpShowsEncoder("Codec 'libnope' is not recognized by FFmpeg.\n", 'libnope'));
  assert.ok(!helpShowsEncoder('', 'libx264'));
  // A listing with one more column of flags than today's is still read; one laid out in some other way is not, and is then left to the help above.
  assert.ok(listsFilter(' TSCH ass               V->V       Render ASS subtitles onto input video using the libass library.\n', 'ass'));
  assert.ok(listsEncoder(' V....D. libx264              libx264 H.264\n', 'libx264'));
  assert.ok(!listsFilter('ass: Render ASS subtitles onto input video using the libass library.\n', 'ass'));
});

test('the font libass chose is recognised as the bundled one only when it is', () => {
  const faceLine = '[Parsed_ass_2 @ 0x55966d6ea440] fontselect: (Inter ExtraBold, 400, 0) -> Inter-ExtraBold, 0, Inter-ExtraBold';
  const pathLine = '[Parsed_ass_2 @ 0x1] fontselect: (Inter ExtraBold, 400, 0) -> /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf, 0, DejaVuSans';
  assert.equal(fontChosenIn(`other text\n${faceLine}\nmore text`), 'Inter-ExtraBold');
  assert.equal(fontChosenIn(pathLine), '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  assert.equal(fontChosenIn(`${pathLine}\n${faceLine}`), 'Inter-ExtraBold', 'the last choice is the one that counts');
  assert.equal(fontChosenIn('Using font provider fontconfig'), null, 'an older libass does not say');

  const files = ['Inter-ExtraBold.otf'];
  assert.ok(isBundledFont('Inter-ExtraBold', '/app/assets/fonts', files));
  assert.ok(isBundledFont('inter-extrabold', '/app/assets/fonts', files));
  assert.ok(isBundledFont('/app/assets/fonts/Inter-ExtraBold.otf', '/app/assets/fonts', files));
  assert.ok(!isBundledFont('/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf', '/app/assets/fonts', files), 'the same font installed on the server is not the bundled one: bundling is about not depending on what a server has');
  assert.ok(!isBundledFont('DejaVuSans', '/app/assets/fonts', files));
  assert.ok(!isBundledFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/app/assets/fonts', files));
  assert.ok(!isBundledFont('Inter-ExtraBoldItalic', '/app/assets/fonts', files), 'another face of the same family is not the bundled file');
});

test('pixels are read and counted the way the checks need', () => {
  const picture = Buffer.from([0, 10, 200, 255, 199, 0]);
  assert.equal(pixelAt(picture, 3, 2, 0), 200);
  assert.equal(pixelAt(picture, 3, 0, 1), 255);
  assert.equal(countAtLeast(picture, 200), 2);
  assert.equal(countAtLeast(picture, 256), 0);
  assert.equal(countAtLeast(Buffer.alloc(0), 1), 0);
});

// ---- the real check, on the real FFmpeg -------------------------------------------------------------------------------------

let workspace = '';
let fakeWhisper = { binaryPath: '', modelPath: '' };
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'toolchain-test-'));
  const binaryPath = join(workspace, 'whisper-cli');
  await writeFile(binaryPath, '#!/bin/sh\necho "usage: ./whisper-cli [options] file0.wav file1.wav ..."\n', { mode: 0o755 });
  const modelPath = join(workspace, 'ggml-test.bin');
  await writeFile(modelPath, '');
  await truncate(modelPath, MIN_MODEL_BYTES + 1024 * 1024); // a sparse file: big enough to look like a model, costs nothing
  fakeWhisper = { binaryPath, modelPath };
});
after(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

async function freshDirectory() { return mkdtemp(join(workspace, 'work-')); }
async function optionsFor(overrides: Partial<ToolchainCheckOptions> = {}): Promise<ToolchainCheckOptions> {
  return { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', videoCodec: 'libx264', audioCodec: 'aac', crf: 23, preset: 'ultrafast', workDirectory: await freshDirectory(), whisper: null, ...overrides };
}
const stepOf = (report: ToolchainReport, name: string) => {
  const step = report.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `a step named ${name} in ${report.steps.map((candidate) => candidate.name).join(', ')}`);
  return step;
};
const failedIn = (report: ToolchainReport) => report.steps.filter((step) => !step.ok).map((step) => step.name);

/**
 * A stand-in `ffmpeg` that runs the real one but changes what it is asked (the arguments) or what it lists about itself, so that each way
 * a host's FFmpeg could be wrong can be played out for real: the changes are written as plain JavaScript source.
 */
async function ffmpegThat(changes: { args?: string; listing?: string }): Promise<string> {
  const path = join(workspace, `ffmpeg-${randomUUID().slice(0, 8)}`);
  await writeFile(path, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const original = process.argv.slice(2);
const changeArgs = ${changes.args ?? '(args) => args'};
const changeListing = ${changes.listing ?? '(text) => text'};
const result = spawnSync('ffmpeg', changeArgs([...original]), { maxBuffer: 256 * 1024 * 1024 });
const listing = original.includes('-filters') || original.includes('-encoders') || original.includes('-version') || original.includes('-h');
process.stdout.write(listing ? changeListing(result.stdout.toString('utf8'), original) : result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status === null ? 1 : result.status;
`, { mode: 0o755 });
  return path;
}
const changingFilter = (body: string) => String.raw`(args) => { const at = args.indexOf('-vf'); if (at >= 0) { const graph = args[at + 1]; ${body} } return args; }`;

test('where everything works every check passes, in order, with what was found, and nothing is left behind', needsFfmpeg, async () => {
  const options = await optionsFor({ whisper: fakeWhisper, faceFollowing: true });
  const report = await checkToolchain(options);
  assert.deepEqual(failedIn(report), [], JSON.stringify(report.steps.filter((step) => !step.ok)));
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((step) => step.name), ['ffmpeg', 'ffprobe', 'encoders', 'filters', 'fonts', 'speech-engine', 'test-video', 'captions', 'whole-picture', 'moving-window', 'face-following']);
  assert.match(stepOf(report, 'ffmpeg').detail, /^ffmpeg \S+$/);
  assert.match(stepOf(report, 'ffprobe').detail, /^ffprobe \S+$/);
  assert.equal(stepOf(report, 'encoders').detail, 'libx264, aac');
  assert.equal(stepOf(report, 'filters').detail, REQUIRED_FILTERS.join(', '));
  assert.equal(stepOf(report, 'fonts').detail, 'Inter-ExtraBold.otf');
  assert.match(stepOf(report, 'speech-engine').detail, /^whisper\.cpp runs, model 11 MB$/);
  assert.match(stepOf(report, 'captions').detail, /captions drawn \(\d+ bright points\), with the bundled font$/, 'the font libass names is the bundled one on this FFmpeg');
  assert.match(stepOf(report, 'face-following').detail, /^a face was followed across the picture, seen in \d+% of the moments checked$/);
  for (const step of report.steps) assert.ok(Number.isInteger(step.ms) && step.ms >= 0, `${step.name} has a time`);
  assert.deepEqual(await readdir(options.workDirectory), [], 'the tiny test files are removed again');
});

test('hosted speech recognition and a switched-off face follower simply leave their checks out', needsFfmpeg, async () => {
  const report = await checkToolchain(await optionsFor());
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((step) => !step.ok)));
  assert.deepEqual(report.steps.map((step) => step.name), ['ffmpeg', 'ffprobe', 'encoders', 'filters', 'fonts', 'test-video', 'captions', 'whole-picture', 'moving-window']);
});

// ---- ways a host can be wrong, each played out for real ------------------------------------------------------------------------

test('an FFmpeg that is not there is reported, the checks that need it are marked as not run, and no folder is made for nothing', needsFfmpeg, async () => {
  const options = await optionsFor({ ffmpegPath: join(workspace, 'no-such-ffmpeg') });
  const report = await checkToolchain(options);
  assert.equal(report.ok, false);
  assert.deepEqual(failedIn(report), ['ffmpeg', 'encoders', 'filters', 'test-video', 'captions', 'whole-picture', 'moving-window']);
  assert.match(stepOf(report, 'ffmpeg').detail, /was not found/);
  assert.match(stepOf(report, 'encoders').detail, /^not run: ffmpeg does not work$/);
  assert.match(stepOf(report, 'captions').detail, /^not run: ffmpeg does not work$/);
  assert.equal(stepOf(report, 'ffprobe').ok, true, 'what works is still reported as working');
  assert.deepEqual(await readdir(options.workDirectory), []);
});

test('a program that starts but does not say what it is (a wrong file at the right path) is not taken for FFmpeg or ffprobe', needsFfmpeg, async () => {
  const imposter = join(workspace, 'imposter');
  await writeFile(imposter, '#!/bin/sh\necho "hello, I am not a video program"\n', { mode: 0o755 });
  const report = await checkToolchain(await optionsFor({ ffmpegPath: imposter, ffprobePath: imposter }));
  assert.equal(report.ok, false);
  assert.match(stepOf(report, 'ffmpeg').detail, /it did not say which version it is/);
  assert.match(stepOf(report, 'ffprobe').detail, /it did not say which version it is/);
  assert.match(stepOf(report, 'captions').detail, /^not run: /);
});

test('an ffprobe that is not there is reported and stops the clips from being tried', needsFfmpeg, async () => {
  const report = await checkToolchain(await optionsFor({ ffprobePath: join(workspace, 'no-such-ffprobe') }));
  assert.deepEqual(failedIn(report), ['ffprobe', 'test-video', 'captions', 'whole-picture', 'moving-window']);
  assert.match(stepOf(report, 'ffprobe').detail, /was not found/);
  assert.match(stepOf(report, 'captions').detail, /^not run: ffprobe does not work$/);
});

test('an encoder this FFmpeg does not have is named', needsFfmpeg, async () => {
  const report = await checkToolchain(await optionsFor({ videoCodec: 'libnot264' }));
  assert.deepEqual(failedIn(report), ['encoders', 'test-video', 'captions', 'whole-picture', 'moving-window']);
  assert.match(stepOf(report, 'encoders').detail, /no encoder named libnot264/);
  assert.equal(stepOf(report, 'ffmpeg').ok, true);
  const audio = await checkToolchain(await optionsFor({ audioCodec: 'notaac' }));
  assert.match(stepOf(audio, 'encoders').detail, /no encoder named notaac/);
});

test('an FFmpeg built without the caption library is told apart from one that has it', needsFfmpeg, async () => {
  // Neither the listing nor the help of the filter knows `ass`, as in a build without libass.
  const withoutAss = await ffmpegThat({ listing: String.raw`(text, args) => args.includes('-filters') ? text.split('\n').filter((line) => !/\sass\s/.test(line)).join('\n') : args.includes('filter=ass') ? "Unknown filter 'ass'.\n" : text` });
  const report = await checkToolchain(await optionsFor({ ffmpegPath: withoutAss }));
  assert.deepEqual(failedIn(report), ['filters'], 'only the filters were changed, so only the filters are wrong');
  assert.match(stepOf(report, 'filters').detail, /no filter named ass \(it was built without the caption library\)/);
});

test('an FFmpeg whose listings are laid out differently (as FFmpeg 8 does) is not taken for a broken one, because the help of each filter and encoder is asked', needsFfmpeg, async () => {
  const otherLayout = await ffmpegThat({ listing: String.raw`(text, args) => args.includes('-filters') || args.includes('-encoders') ? text.split('\n').map((line) => line.replace(/^\s*\S+\s+(\S+)\s+(.*)$/, '$1: $2')).join('\n') : text` });
  const report = await checkToolchain(await optionsFor({ ffmpegPath: otherLayout }));
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((step) => !step.ok)));
  assert.equal(stepOf(report, 'filters').detail, REQUIRED_FILTERS.join(', '));
  assert.equal(stepOf(report, 'encoders').detail, 'libx264, aac');
});

test('captions that are silently left out are caught by looking at the picture, not by whether FFmpeg complained', needsFfmpeg, async () => {
  const noCaptions = await ffmpegThat({ args: changingFilter(String.raw`args[at + 1] = graph.replace(/,ass=.*$/, '');`) });
  const report = await checkToolchain(await optionsFor({ ffmpegPath: noCaptions }));
  assert.deepEqual(failedIn(report), ['captions']);
  assert.match(stepOf(report, 'captions').detail, /the captions were not drawn \(0 bright points/);
  assert.equal(stepOf(report, 'whole-picture').ok, true);
  assert.equal(stepOf(report, 'moving-window').ok, true);
});

test('captions drawn with some other font than the bundled one are caught', needsFfmpeg, async () => {
  const wrongFonts = await ffmpegThat({ args: changingFilter(String.raw`args[at + 1] = graph.replace(/fontsdir='[^']*'/, "fontsdir='/no-such-fonts-folder'");`) });
  const report = await checkToolchain(await optionsFor({ ffmpegPath: wrongFonts }));
  assert.deepEqual(failedIn(report), ['captions']);
  assert.match(stepOf(report, 'captions').detail, /another font than the bundled one|were not drawn/);
});

test('a missing font file is reported (and the captions made without it do not pass for the real thing)', needsFfmpeg, async () => {
  const empty = join(workspace, 'no-fonts-here');
  await mkdir(empty, { recursive: true });
  const report = await checkToolchain(await optionsFor({ fontsDirectory: empty }));
  assert.equal(report.ok, false);
  assert.match(stepOf(report, 'fonts').detail, /bundled caption font is missing/);
  assert.equal(stepOf(report, 'fonts').ok, false);
  const missing = await checkToolchain(await optionsFor({ fontsDirectory: join(workspace, 'does-not-exist') }));
  assert.equal(stepOf(missing, 'fonts').ok, false);
  assert.deepEqual(await readdir(BUNDLED_FONTS_DIRECTORY).then((files) => files.filter((file) => /\.otf$/.test(file))), ['Inter-ExtraBold.otf'], 'the real bundled folder is untouched');
});

test('a crop window that does not move is caught, and so is a whole picture that is not shown whole', needsFfmpeg, async () => {
  const staticWindow = await ffmpegThat({ args: changingFilter(String.raw`args[at + 1] = graph.replace(/crop=(\d+):(\d+):x='[^']*':y='[^']*'/, 'crop=$1:$2');`) });
  const stuck = await checkToolchain(await optionsFor({ ffmpegPath: staticWindow }));
  assert.deepEqual(failedIn(stuck), ['moving-window']);
  assert.match(stepOf(stuck, 'moving-window').detail, /did not start at the left edge/);

  const stuckAtTheEdge = await ffmpegThat({ args: changingFilter(String.raw`args[at + 1] = graph.replace(/x='[^']*'/, 'x=0');`) });
  const stays = await checkToolchain(await optionsFor({ ffmpegPath: stuckAtTheEdge }));
  assert.deepEqual(failedIn(stays), ['moving-window']);
  assert.match(stepOf(stays, 'moving-window').detail, /did not move away from the left edge/, 'a window that starts right but never moves is not a moving window');

  const cutInstead = await ffmpegThat({ args: changingFilter(String.raw`if (graph.startsWith('split=2')) args[at + 1] = 'scale=144:256:force_original_aspect_ratio=increase,crop=144:256';`) });
  const cut = await checkToolchain(await optionsFor({ ffmpegPath: cutInstead }));
  assert.deepEqual(failedIn(cut), ['whole-picture']);
  assert.match(stepOf(cut, 'whole-picture').detail, /the whole picture is not shown/);

  const noBlur = await ffmpegThat({ args: changingFilter(String.raw`if (graph.startsWith('split=2')) args[at + 1] = 'scale=144:256:force_original_aspect_ratio=decrease,pad=144:256:(ow-iw)/2:(oh-ih)/2:color=white';`) });
  const bright = await checkToolchain(await optionsFor({ ffmpegPath: noBlur }));
  assert.deepEqual(failedIn(bright), ['whole-picture']);
  assert.match(stepOf(bright, 'whole-picture').detail, /not filled with the dark blurred copy/, 'the space around the picture has to be the copy, not a bar of something else');
});

test('the face follower is checked on a face and fails with a reason when it cannot find one, or when its portrait is missing', needsFfmpeg, async () => {
  const noPortrait = await checkToolchain(await optionsFor({ faceFollowing: true, portraitPath: join(workspace, 'no-portrait.pgm') }));
  assert.deepEqual(failedIn(noPortrait), ['face-following']);
  assert.match(stepOf(noPortrait, 'face-following').detail, /test portrait is not installed/);

  const blank = join(workspace, 'blank.pgm');
  await writeFile(blank, Buffer.concat([Buffer.from('P5\n320 320\n255\n', 'latin1'), Buffer.alloc(320 * 320, 128)]));
  const noFace = await checkToolchain(await optionsFor({ faceFollowing: true, portraitPath: blank }));
  assert.deepEqual(failedIn(noFace), ['face-following']);
  assert.match(stepOf(noFace, 'face-following').detail, /no face was found in a picture of a face/);
});

test('the face follower is started with the threads the clips are made with, and with none when no number is set', needsFfmpeg, async () => {
  const ffmpeg = await recordingFfmpeg();
  const report = await checkToolchain(await optionsFor({ ffmpegPath: ffmpeg.path, faceFollowing: true, clipThreads: 2 }));
  assert.equal(stepOf(report, 'face-following').ok, true, stepOf(report, 'face-following').detail);
  const looks = (await ffmpeg.calls()).filter((call) => call.includes('image2pipe'));
  assert.equal(looks.length, 1, 'one look at the portrait');
  assert.equal(looks[0][looks[0].indexOf('-filter_threads') + 1], '2', 'the filters of the follower');
  assert.equal(looks[0][looks[0].indexOf('-threads') + 1], '2', 'and its decoder');

  const free = await recordingFfmpeg();
  assert.equal(stepOf(await checkToolchain(await optionsFor({ ffmpegPath: free.path, faceFollowing: true })), 'face-following').ok, true);
  const freeLook = (await free.calls()).filter((call) => call.includes('image2pipe'))[0];
  assert.ok(freeLook && !freeLook.includes('-threads') && !freeLook.includes('-filter_threads'), 'no number, no option');
});

test('whisper.cpp is checked without loading its model: missing, not runnable, truncated, silent and fine are all told apart', needsFfmpeg, async () => {
  const ffmpegPath = join(workspace, 'no-such-ffmpeg'); // the other checks are not what is looked at here, and stop early
  const speech = async (whisper: { binaryPath: string; modelPath: string }) => stepOf(await checkToolchain(await optionsFor({ ffmpegPath, whisper })), 'speech-engine');

  assert.match((await speech({ binaryPath: join(workspace, 'no-whisper'), modelPath: fakeWhisper.modelPath })).detail, /whisper\.cpp is missing or not executable/);
  const notExecutable = join(workspace, 'whisper-plain-file');
  await writeFile(notExecutable, '#!/bin/sh\necho usage\n', { mode: 0o644 });
  assert.match((await speech({ binaryPath: notExecutable, modelPath: fakeWhisper.modelPath })).detail, /missing or not executable/);
  assert.match((await speech({ binaryPath: fakeWhisper.binaryPath, modelPath: join(workspace, 'no-model.bin') })).detail, /the speech model file is missing/);
  const truncated = join(workspace, 'ggml-truncated.bin');
  await writeFile(truncated, Buffer.alloc(4096));
  assert.match((await speech({ binaryPath: fakeWhisper.binaryPath, modelPath: truncated })).detail, /only 4096 bytes, so its download did not finish/);
  const silent = join(workspace, 'whisper-silent');
  await writeFile(silent, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.match((await speech({ binaryPath: silent, modelPath: fakeWhisper.modelPath })).detail, /did not print what a working copy prints/);

  const strict = join(workspace, 'whisper-exits-1');
  await writeFile(strict, '#!/bin/sh\necho "usage: whisper-cli [options]" >&2\nexit 1\n', { mode: 0o755 });
  const lenient = await speech({ binaryPath: strict, modelPath: fakeWhisper.modelPath });
  assert.equal(lenient.ok, true, 'a program that prints its usage text and exits with 1 is still a program that runs');
  assert.equal((await speech(fakeWhisper)).ok, true);
});

test('a work folder that cannot be made is a failed check, not a crash', needsFfmpeg, async () => {
  const report = await checkToolchain(await optionsFor({ workDirectory: join(workspace, 'no-such', 'folder') }));
  assert.equal(report.ok, false);
  assert.deepEqual(failedIn(report), ['work-folder']);
  assert.match(stepOf(report, 'work-folder').detail, /no such file or directory/i);
  assert.equal(stepOf(report, 'ffmpeg').ok, true, 'what could be looked at without the folder was');
});

test('a program that takes too long is stopped and said to have taken too long', needsFfmpeg, async () => {
  const slow = join(workspace, 'ffmpeg-slow');
  await writeFile(slow, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  const report = await checkToolchain(await optionsFor({ ffmpegPath: slow, stepTimeoutMs: 300 }));
  assert.equal(stepOf(report, 'ffmpeg').ok, false);
  assert.match(stepOf(report, 'ffmpeg').detail, /took too long/);
});

// ---- when the check runs and what it leaves behind -----------------------------------------------------------------------------

/** The monitor's waiting does not keep a process alive (a server is kept alive by its socket), so a test that waits must be kept alive by something else. */
async function withLoopAlive<T>(work: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1000);
  try { return await work(); } finally { clearInterval(keepAlive); }
}

interface Logged { level: 'info' | 'warn' | 'error'; fields: object; message: string }
function recordingLogger() {
  const lines: Logged[] = [];
  return { lines, info: (fields: object, message: string) => lines.push({ level: 'info', fields, message }), warn: (fields: object, message: string) => lines.push({ level: 'warn', fields, message }), error: (fields: object, message: string) => lines.push({ level: 'error', fields, message }) };
}
const goodReport: ToolchainReport = { ok: true, steps: [{ name: 'ffmpeg', ok: true, ms: 12, detail: 'ffmpeg 9.9.9' }, { name: 'captions', ok: true, ms: 30, detail: 'captions drawn' }] };
const badReport: ToolchainReport = { ok: false, steps: [{ name: 'ffmpeg', ok: true, ms: 12, detail: 'ffmpeg 9.9.9' }, { name: 'filters', ok: false, ms: 5, detail: 'no filter named ass' }, { name: 'captions', ok: false, ms: 0, detail: 'not run' }] };

test('an idle server runs the check at once and reports a pass in its log with every step, and in its status without the details', async () => {
  const logger = recordingLogger();
  const monitor = new ToolchainMonitor({ check: async () => goodReport, isBusy: () => false, logger });
  assert.deepEqual(monitor.status, { state: 'pending', checkedAt: null, failed: [] });
  const status = await monitor.run();
  assert.equal(status.state, 'passed');
  assert.ok(status.checkedAt && !Number.isNaN(Date.parse(status.checkedAt)));
  assert.deepEqual(status.failed, []);
  assert.deepEqual(monitor.status, status);
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0].level, 'info');
  assert.match(logger.lines[0].message, /^Toolchain check passed \(2 checks, 42 ms\): ffmpeg 9\.9\.9$/);
  assert.deepEqual((logger.lines[0].fields as { steps: unknown }).steps, goodReport.steps);
  assert.ok(!JSON.stringify(status).includes('9.9.9'), 'the status that goes into the health check holds no versions');
});

test('a failed check is logged as an error that names what failed, and the status names it too', async () => {
  const logger = recordingLogger();
  const status = await new ToolchainMonitor({ check: async () => badReport, isBusy: () => false, logger }).run();
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.failed, ['filters', 'captions']);
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0].level, 'error');
  assert.match(logger.lines[0].message, /^Toolchain check FAILED: filters, captions\./);
  assert.deepEqual((logger.lines[0].fields as { steps: unknown }).steps, badReport.steps, 'the details are in the log');
});

test('a check that itself blows up becomes a failed status, never an unhandled error', async () => {
  const logger = recordingLogger();
  const status = await new ToolchainMonitor({ check: async () => { throw new Error('boom'); }, isBusy: () => false, logger }).run();
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.failed, ['check-crashed']);
  assert.equal(logger.lines[0].level, 'error');
  assert.match((logger.lines[0].fields as { err: Error }).err.message, /boom/);
});

test('the check waits for the server to be idle: a job that is running is never accompanied by it', async () => {
  const logger = recordingLogger(); const order: string[] = [];
  let busyFor = 3;
  const monitor = new ToolchainMonitor({
    check: async () => { order.push('check'); return goodReport; },
    isBusy: () => { order.push('busy?'); return busyFor-- > 0; },
    logger, retryMs: 5,
  });
  const status = await withLoopAlive(() => monitor.run());
  assert.equal(status.state, 'passed');
  assert.deepEqual(order, ['busy?', 'busy?', 'busy?', 'busy?', 'check']);
});

test('a server that never becomes idle skips the check and says so, instead of waiting for ever or crowding a job', async () => {
  const logger = recordingLogger(); let ran = 0;
  const status = await withLoopAlive(() => new ToolchainMonitor({ check: async () => { ran += 1; return goodReport; }, isBusy: () => true, logger, retryMs: 5, maxWaitMs: 30 }).run());
  assert.equal(status.state, 'skipped');
  assert.ok(status.checkedAt);
  assert.equal(ran, 0);
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0].level, 'warn');
  assert.match(logger.lines[0].message, /^Toolchain check skipped: the server stayed busy/);
});

test('stopping the server ends the waiting at once and starts nothing', async () => {
  const logger = recordingLogger(); let ran = 0;
  const monitor = new ToolchainMonitor({ check: async () => { ran += 1; return goodReport; }, isBusy: () => true, logger, retryMs: 60_000, maxWaitMs: 600_000 });
  const { status, waitedMs } = await withLoopAlive(async () => {
    const finished = monitor.run();
    await sleep(20);
    const started = Date.now();
    monitor.stop();
    return { status: await finished, waitedMs: Date.now() - started };
  });
  assert.ok(waitedMs < 1000, 'it did not wait for the next look');
  assert.equal(status.state, 'pending');
  assert.equal(ran, 0);
  assert.equal(logger.lines.length, 0);
});

test('the status handed out is a copy, so nobody can change what the monitor knows', async () => {
  const monitor = new ToolchainMonitor({ check: async () => badReport, isBusy: () => false, logger: recordingLogger() });
  await monitor.run();
  monitor.status.failed.push('tampered');
  assert.deepEqual(monitor.status.failed, ['filters', 'captions']);
});

// ---- what this machine really does: the recording of speech, the limits of the machine, the size of real clips ----------------------

const SAID = SPEECH_SAMPLE_TEXT;
const GIB = 1024 ** 3;
const unlimited = async () => ({ cpuLimit: null, memoryLimitBytes: null, cores: 4, totalMemoryBytes: 8 * GIB });
const sharing = (cpuLimit: number) => async () => ({ cpuLimit, memoryLimitBytes: 512 * 1024 * 1024, cores: 16, totalMemoryBytes: 64 * GIB });

test('the recording that comes with the program is the 11 s, 16 kHz, mono, 16-bit speech it is said to be, unchanged', async () => {
  const bytes = await readFile(SPEECH_SAMPLE_PATH);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e', 'the file of the whisper.cpp project, unchanged');
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF'); assert.equal(bytes.toString('latin1', 8, 12), 'WAVE');
  const chunks = new Map<string, { at: number; size: number }>();
  for (let at = 12; at + 8 <= bytes.length;) { const size = bytes.readUInt32LE(at + 4); chunks.set(bytes.toString('latin1', at, at + 4), { at: at + 8, size }); at += 8 + size + (size % 2); }
  const format = chunks.get('fmt ')!;
  assert.deepEqual({ kind: bytes.readUInt16LE(format.at), channels: bytes.readUInt16LE(format.at + 2), rate: bytes.readUInt32LE(format.at + 4), bits: bytes.readUInt16LE(format.at + 14) }, { kind: 1, channels: 1, rate: 16_000, bits: 16 });
  assert.equal(chunks.get('data')!.size / (16_000 * 2), 11, 'eleven seconds');
});

test('how much of what was said was written is counted in words, in order, and ignores capital letters, punctuation and extra words', () => {
  assert.equal(shareOfWordsHeard(SAID, SAID), 1);
  assert.equal(shareOfWordsHeard(' and so my fellow americans - ask not what your country can do for you; ask what you can do for your country', SAID), 1, 'capital letters and punctuation do not matter');
  assert.equal(shareOfWordsHeard(`Uh, ${SAID} You know.`, SAID), 1, 'extra words do not count against what was said');
  assert.equal(shareOfWordsHeard('', SAID), 0);
  assert.equal(shareOfWordsHeard(SAID, ''), 0);
  assert.equal(shareOfWordsHeard('something else entirely', SAID), 0);
  assert.equal(shareOfWordsHeard(SAID.replace('my fellow Americans, ', ''), SAID), 19 / 22, 'three of the twenty-two words are missing');
  assert.ok(shareOfWordsHeard(SAID.split(' ').reverse().join(' '), SAID) < 0.5, 'the same words in the wrong order are not the speech');
});

const spoken = SAID.split(' ');
const goodSegments = (): TranscriptInput => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 11, text: SAID, words: spoken.map((text, index) => ({ text, startSeconds: 0.2 + index * 0.48, endSeconds: 0.2 + (index + 1) * 0.48 })) }];

test('what the speech engine wrote for the recording is judged: the words, a time for each, in order and spread over the recording', () => {
  assert.deepEqual({ ...judgeSpeechSample(goodSegments()), text: undefined }, { words: 22, share: 1, text: undefined });
  const missing = (count: number) => [{ ...goodSegments()[0], text: spoken.slice(0, 22 - count).join(' ') }];
  assert.ok(judgeSpeechSample(missing(3)).share > 0.8, 'a few words wrong is still the speech (the model is small, and Whisper is not perfect)');
  assert.throws(() => judgeSpeechSample(missing(6)), /the recording says/, 'a quarter of the words missing is not');

  const change = (how: (segments: TranscriptInput) => TranscriptInput | void) => { const segments = goodSegments(); return how(segments) ?? segments; };
  const refused: Array<[string, TranscriptInput, RegExp]> = [
    ['nothing written', [], /nothing was written/],
    ['another sentence', change((s) => { s[0].text = 'The weather tomorrow will be sunny with a light breeze over the coast'; }), /the recording says/],
    ['no times for the words', change((s) => { delete s[0].words; }), /without a time for each word/],
    ['a word after the end of the recording', change((s) => { s[0].words![21].endSeconds = 15; }), /cannot be right/],
    ['a word that ends before it starts', change((s) => { s[0].words![5].startSeconds = 5; s[0].words![5].endSeconds = 4; }), /cannot be right/],
    ['a negative time', change((s) => { s[0].words![0].startSeconds = -0.5; }), /cannot be right/],
    ['a time that is not a number', change((s) => { s[0].words![3].endSeconds = Number.NaN; }), /cannot be right/],
    ['a word timed before the one before it', change((s) => { s[0].words![10].startSeconds = 1; s[0].words![10].endSeconds = 1.2; }), /is timed before the one that comes before it/],
    ['all the words piled up at the start', change((s) => { s[0].words = spoken.map((text, index) => ({ text, startSeconds: 0.1 + index * 0.09, endSeconds: 0.1 + (index + 1) * 0.09 })); }), /timed between 0\.1 and 2\.1 s/],
    ['all the words piled up at the end', change((s) => { s[0].words = spoken.map((text, index) => ({ text, startSeconds: 8 + index * 0.13, endSeconds: 8 + (index + 1) * 0.13 })); }), /timed between 8\.0 and 10\.9 s/],
  ];
  for (const [what, segments, message] of refused) assert.throws(() => judgeSpeechSample(segments), message, what);
});

async function sampleWhisper(options: { json?: string; body?: string; argsLog?: string } = {}) {
  const binaryPath = join(workspace, `whisper-${randomUUID().slice(0, 8)}`);
  await writeFakeWhisper(binaryPath, options);
  return { binaryPath, modelPath: fakeWhisper.modelPath };
}
const newLog = () => join(workspace, `args-${randomUUID().slice(0, 8)}.log`);
const startsIn = async (log: string) => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
/** The check with a speech engine and real samples on, stopped early (there is no FFmpeg to go on with) since the speech is what is looked at here. */
async function listening(whisper: { binaryPath: string; modelPath: string; threads?: number }, extra: Partial<ToolchainCheckOptions> = {}) {
  const options = await optionsFor({ ffmpegPath: join(workspace, 'no-such-ffmpeg'), whisper, realSamples: true, machine: unlimited, ...extra });
  return { report: await checkToolchain(options), options };
}

test('with real samples on, whisper.cpp listens to the recording that comes with the program, as English, and the check says what it wrote and how long that took', async () => {
  const log = newLog(); const whisper = await sampleWhisper({ argsLog: log });
  const { report, options } = await listening(whisper);
  assert.deepEqual(report.steps.slice(0, 2).map((step) => step.name), ['machine', 'ffmpeg'], 'what the machine is like comes first');
  assert.equal(stepOf(report, 'machine').detail, 'no limit on the processor share (4 cores visible); memory 8192 MiB, with no limit of its own');
  const sample = stepOf(report, 'speech-sample');
  assert.equal(sample.ok, true, sample.detail);
  assert.ok(sample.detail.startsWith(`wrote 22 words with their times, 100% of those said ("${SAID.slice(0, 60)}…"); `), sample.detail);
  assert.match(sample.detail, / \d+\.\d s to listen to 11 s of speech, with the program's own choice of threads$/);
  const starts = await startsIn(log);
  assert.equal(starts.length, 1, 'listened to once');
  assert.match(starts[0], new RegExp(`^-m ${fakeWhisper.modelPath} -f ${SPEECH_SAMPLE_PATH} -l en -ng -nfa -pp -ojf -of `));
  assert.deepEqual(await readdir(options.workDirectory), [], 'what the engine wrote is removed again');
});

test('the time told for the recording is the time the listening took, not the time the program has been running', async () => {
  const whisper = await sampleWhisper({ body: `sleep 1.2\ncat > "$base.json" <<'JSON'\n${speechSampleJson()}\nJSON` });
  const started = performance.now();
  const { report } = await listening(whisper);
  const wall = (performance.now() - started) / 1000;
  const detail = stepOf(report, 'speech-sample').detail;
  const seconds = Number(/ (\d+\.\d) s to listen to 11 s of speech/.exec(detail)?.[1]);
  assert.ok(seconds >= 1.1 && seconds <= wall + 0.05, `${seconds} s is neither as long as the listening (1.2 s) nor within the ${wall.toFixed(2)} s the whole check took: ${detail}`);
});

test('the recording is listened to once, with the number of threads the jobs are started with: one that is set reaches whisper.cpp and is told, and without one the program chooses', async () => {
  for (const [threads, flag, told] of [[1, / -l en -t 1 -ng /, 'with 1 thread'], [3, / -l en -t 3 -ng /, 'with 3 threads']] as const) {
    const log = newLog();
    const { report } = await listening({ ...(await sampleWhisper({ argsLog: log })), threads }, { machine: sharing(0.15) });
    const starts = await startsIn(log);
    assert.equal(starts.length, 1, 'listened to once, however small the share of a processor is: there is no second run to compare with any more');
    assert.match(starts[0], flag);
    assert.ok(stepOf(report, 'speech-sample').detail.endsWith(`s to listen to 11 s of speech, ${told}`) || stepOf(report, 'speech-sample').detail.endsWith(`, ${told}`), stepOf(report, 'speech-sample').detail);
  }
  const ownLog = newLog();
  await listening(await sampleWhisper({ argsLog: ownLog }), { machine: sharing(0.15) });
  const own = await startsIn(ownLog);
  assert.equal(own.length, 1); assert.doesNotMatch(own[0], / -t /, 'without a number the program chooses');
});

test('a speech engine that does not write what a working one writes is a failed check, and each way of going wrong is named', async () => {
  const cases: Array<[string, { json?: string; body?: string }, RegExp]> = [
    ['writes no output', { body: 'exit 0' }, /exited without creating JSON output/],
    ['stops with an error', { body: 'echo "error: failed to load model" >&2\nexit 3' }, /Local whisper\.cpp transcription failed.*failed to load model/s],
    ['writes something that is not JSON', { body: 'echo "not json" > "$base.json"' }, /Could not read whisper\.cpp JSON output/],
    ['writes another sentence', { json: speechSampleJson({ text: 'The weather tomorrow will be sunny with a light breeze over the coast today' }) }, /the recording says/],
    ['writes no times for the words', { json: speechSampleJson({ tokens: false }) }, /without a time for each word/],
    ['writes times that are squeezed into the start of its segment (which the program already refuses to take for the times of words)', { json: speechSampleJson({ from: 0.1, to: 2 }) }, /without a time for each word/],
    ['writes times beyond its own segment (which the program already refuses to take for word times)', { json: speechSampleJson({ from: 20, to: 40 }) }, /without a time for each word/],
  ];
  for (const [what, engine, message] of cases) {
    const { report } = await listening(await sampleWhisper(engine));
    const sample = stepOf(report, 'speech-sample');
    assert.equal(sample.ok, false, what);
    assert.match(sample.detail, message, what);
    assert.equal(stepOf(report, 'speech-engine').ok, true, `${what}: the program itself starts, which is what the check before it can see`);
  }
});

test('the recording is not listened to when the speech engine is not even there, nor when the recording is missing, nor when real samples are off or the speech is hosted', async () => {
  const log = newLog();
  const broken = await listening({ binaryPath: (await sampleWhisper({ argsLog: log })).binaryPath, modelPath: join(workspace, 'no-model.bin') });
  assert.deepEqual(failedIn(broken.report).filter((name) => name.startsWith('speech')), ['speech-engine', 'speech-sample']);
  assert.equal(stepOf(broken.report, 'speech-sample').detail, 'not run: the speech engine check failed');
  assert.deepEqual(await startsIn(log), []);

  const noRecording = await listening(await sampleWhisper({ argsLog: log }), { speechSamplePath: join(workspace, 'missing.wav') });
  assert.match(stepOf(noRecording.report, 'speech-sample').detail, /the recording of speech is not installed with the program/);

  const off = await checkToolchain(await optionsFor({ ffmpegPath: join(workspace, 'no-such-ffmpeg'), whisper: await sampleWhisper({ argsLog: log }) }));
  assert.deepEqual(off.steps.map((step) => step.name).filter((name) => ['machine', 'speech-sample', 'render-speed'].includes(name)), [], 'real samples are a choice, and off is how the check always was');
  assert.deepEqual(await startsIn(log), [], 'the recording was never listened to');

  const hosted = await checkToolchain(await optionsFor({ ffmpegPath: join(workspace, 'no-such-ffmpeg'), whisper: null, realSamples: true, machine: unlimited }));
  assert.ok(hosted.steps.some((step) => step.name === 'machine'), 'what the machine is like is told whatever does the listening');
  assert.ok(!hosted.steps.some((step) => step.name === 'speech-sample'), 'but there is no engine on this machine to listen to the recording');
});

test('what limits the machine is only told, never judged: a machine whose limits cannot be read still passes', async () => {
  const { report } = await listening(await sampleWhisper(), { machine: async () => { throw new Error('no such file'); } });
  const machine = stepOf(report, 'machine');
  assert.equal(machine.ok, true);
  assert.equal(machine.detail, 'could not be found out (no such file)');
  assert.equal(stepOf(report, 'speech-sample').ok, true, 'and the speech sample is made as if there were no limit');
});

/** A stand-in `ffmpeg` that runs the real one and writes down the arguments of every call; `slow` makes the calls that write a file with that name take `milliseconds` longer. */
async function recordingFfmpeg(slow?: { endingWith: string; milliseconds: number }) {
  const path = join(workspace, `ffmpeg-${randomUUID().slice(0, 8)}`); const log = `${path}.log`;
  await writeFile(path, `#!${process.execPath}
const { spawnSync } = require('node:child_process'); const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
${slow ? `if (process.argv[process.argv.length - 1].endsWith(${JSON.stringify(slow.endingWith)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${slow.milliseconds});` : ''}
const result = spawnSync('ffmpeg', process.argv.slice(2), { stdio: 'inherit' });
process.exitCode = result.status === null ? 1 : result.status;
`, { mode: 0o755 });
  return { path, calls: async () => (await startsIn(log)).map((line) => JSON.parse(line) as string[]) };
}

test('the render sample makes three seconds of video at the size of real clips, by the renderer and with the settings of real clips, and says how long that took and with how many threads', needsFfmpeg, async () => {
  const ffmpeg = await recordingFfmpeg({ endingWith: 'sample-clip.mp4', milliseconds: 1800 });   // slow, so that the seconds and the ratio are numbers that can be checked closely
  const options = await optionsFor({ ffmpegPath: ffmpeg.path, realSamples: true, clipSize: { width: 180, height: 320 }, machine: sharing(0.1), preset: 'veryfast', crf: 31, clipThreads: 1 });
  const report = await checkToolchain(options);
  assert.deepEqual(failedIn(report), [], JSON.stringify(report.steps.filter((step) => !step.ok)));
  assert.deepEqual(report.steps.map((step) => step.name), ['machine', 'ffmpeg', 'ffprobe', 'encoders', 'filters', 'fonts', 'test-video', 'captions', 'whole-picture', 'moving-window', 'render-speed']);
  const told = stepOf(report, 'render-speed').detail;
  assert.match(told, /^3 s of 180x320 with captions, from a busy 1920x1080 picture, took \d+\.\d s with preset veryfast and 1 thread \(\d+\.\d times the length of the clip\)$/);
  const [, took, times] = /took (\d+\.\d) s .*\((\d+\.\d) times/.exec(told)!;
  assert.ok(Number(took) >= 1.8, `the time is the time of the render itself (it was made to take at least 1.8 s): ${took}`);
  assert.ok(Math.abs(Number(times) - Number(took) / 3) <= 0.07, `${times} times the length of a 3 s clip is not what ${took} s makes`);

  const calls = await ffmpeg.calls();
  const clips = calls.filter((call) => call[call.length - 1].endsWith('sample-clip.mp4'));
  assert.equal(clips.length, 1, 'one clip, made once: there is no second run to compare with any more');
  const [clip] = clips;
  assert.equal(clip[clip.indexOf('-preset') + 1], 'veryfast', 'with the preset the clips are made with');
  assert.equal(clip[clip.indexOf('-crf') + 1], '31', 'and their quality setting');
  assert.ok(clip.some((argument) => String(argument).includes('ass=')), 'with captions burned into the picture, as the real clips have');
  assert.deepEqual(clip.slice(-3, -1), ['-threads', '1'], 'the encoder is told, in front of the output file');
  assert.equal(clip[clip.indexOf('-i') - 2], '-threads', 'and the decoder, in front of the input');
  assert.equal(clip[clip.indexOf('-filter_threads') + 1], '1', 'and the filters');
  assert.ok(calls.some((call) => call.some((argument) => argument === 'testsrc2=s=1920x1080:r=30:d=3')), 'made from a picture as large as the videos people upload');
  assert.deepEqual(await readdir(options.workDirectory), [], 'the sample clip is removed again');

  const own = await checkToolchain(await optionsFor({ ffmpegPath: ffmpeg.path, realSamples: true, clipSize: { width: 144, height: 256 }, machine: unlimited }));
  assert.match(stepOf(own, 'render-speed').detail, /with preset ultrafast and the program's own choice of threads \(/);
  const ownClip = (await ffmpeg.calls()).filter((call) => call[call.length - 1].endsWith('sample-clip.mp4')).pop()!;
  assert.ok(!ownClip.includes('-threads') && !ownClip.includes('-filter_threads'), 'no number, no option: FFmpeg chooses');
});

test('no render sample without a clip size, and one that cannot be made is a failed check, not a crash; and nothing is made when FFmpeg or the test video is not there', needsFfmpeg, async () => {
  const without = await checkToolchain(await optionsFor({ realSamples: true, machine: unlimited }));
  assert.ok(!without.steps.some((step) => step.name === 'render-speed'));
  assert.deepEqual(failedIn(without), [], 'and the check does not fail for the lack of one');

  const noSource = await ffmpegThat({ args: String.raw`(args) => args.map((argument) => String(argument).startsWith('testsrc2') ? 'nosuchsource=s=1x1' : argument)` });
  const broken = await checkToolchain(await optionsFor({ ffmpegPath: noSource, realSamples: true, clipSize: { width: 144, height: 256 }, machine: unlimited }));
  assert.deepEqual(failedIn(broken), ['render-speed']);

  const missing = await checkToolchain(await optionsFor({ ffmpegPath: join(workspace, 'no-such-ffmpeg'), realSamples: true, clipSize: { width: 144, height: 256 }, machine: unlimited }));
  assert.equal(stepOf(missing, 'render-speed').detail, 'not run: ffmpeg does not work');

  const noVideo = await ffmpegThat({ args: String.raw`(args) => args.map((argument) => String(argument).startsWith('color=c=0x202020') ? 'nosuchsource=s=1x1' : argument)` });
  const cut = await checkToolchain(await optionsFor({ ffmpegPath: noVideo, realSamples: true, clipSize: { width: 144, height: 256 }, machine: unlimited }));
  assert.equal(stepOf(cut, 'test-video').ok, false);
  assert.equal(stepOf(cut, 'render-speed').detail, 'not run: the test video could not be made');
});

test('with real samples on, everything is checked in order, the speech and the render at the end of the checks they belong to, and nothing is left behind', needsFfmpeg, async () => {
  const options = await optionsFor({ whisper: { ...(await sampleWhisper()), threads: 1 }, faceFollowing: true, realSamples: true, clipSize: { width: 144, height: 256 }, machine: sharing(0.5), clipThreads: 1 });
  const report = await checkToolchain(options);
  assert.deepEqual(failedIn(report), [], JSON.stringify(report.steps.filter((step) => !step.ok)));
  assert.deepEqual(report.steps.map((step) => step.name), ['machine', 'ffmpeg', 'ffprobe', 'encoders', 'filters', 'fonts', 'speech-engine', 'speech-sample', 'test-video', 'captions', 'whole-picture', 'moving-window', 'render-speed', 'face-following']);
  assert.deepEqual(await readdir(options.workDirectory), []);
});

test('the render sample is only told when the clip it made is the size of a real clip', needsFfmpeg, async () => {
  const wrongSize = await ffmpegThat({ args: String.raw`(args) => { if (String(args[args.length - 1]).endsWith('sample-clip.mp4')) { const at = args.indexOf('-vf'); args[at + 1] = args[at + 1].replace(/crop=\d+:\d+/, 'crop=100:100'); } return args; }` });
  const report = await checkToolchain(await optionsFor({ ffmpegPath: wrongSize, realSamples: true, clipSize: { width: 144, height: 256 }, machine: unlimited }));
  assert.deepEqual(failedIn(report), ['render-speed']);
  assert.match(stepOf(report, 'render-speed').detail, /the clip should be 144x256 but is 100x100/);
});

test('a recording of speech is given more time than the other steps get, since a small share of a processor makes listening slow', async () => {
  const slow = await sampleWhisper({ body: `sleep 0.6\ncat > "$base.json" <<'JSON'\n${speechSampleJson()}\nJSON` });
  const { report } = await listening(slow, { stepTimeoutMs: 150 });
  const sample = stepOf(report, 'speech-sample');
  assert.equal(sample.ok, true, sample.detail);
});
