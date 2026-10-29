import { execFile } from 'node:child_process';
import { access, constants, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeAssCaptions } from './captions.js';
import { BUNDLED_FONTS_DIRECTORY, FfmpegClipRenderer, type FfmpegRunner } from './clips.js';
import { FaceClipFramer } from './face-track.js';
import { positionAt, type FramingPlan } from './framing.js';
import { describeMachine, describeThreads, readMachineLimits, type MachineLimits } from './machine.js';
import { WhisperCppTranscriber, type TranscriptInput } from './transcription.js';

const execFileAsync = promisify(execFile);

/**
 * A check of the programs every job depends on, made on the machine the service really runs on. The tests prove that the code is right
 * for the FFmpeg and whisper.cpp of the development machine and of CI; they cannot know what a host installs. A host that updates its
 * FFmpeg, or builds it without the caption library, would otherwise be found out by the first customer's clip.
 *
 * What is checked, in plain terms: that FFmpeg and ffprobe start and say which version they are; that the video and audio encoders the
 * configuration asks for and the filters the clips use exist; that the bundled caption font is there; that whisper.cpp and its model
 * are there (without loading the model, which needs far more memory than a small server can spare while a job runs); and then, with
 * tiny real clips made by the very code that makes the customers' clips (FfmpegClipRenderer), that captions really are drawn
 * (and with the bundled font), that the whole-picture layout really shows the whole picture, and that a moving crop window really
 * moves. Those three are judged by looking at single pixels of the result, because an FFmpeg that ignores a filter option still
 * produces a perfectly playable video. When face following is on, a last check lets the real face follower watch a short video of a
 * face (a public-domain portrait) crossing the picture, which exercises picture taking, face finding and camera planning on this machine.
 */
export interface ToolchainStep { name: string; ok: boolean; ms: number; detail: string; }
export interface ToolchainReport { ok: boolean; steps: ToolchainStep[]; }

export interface ToolchainCheckOptions {
  ffmpegPath: string;
  ffprobePath: string;
  videoCodec: string;
  audioCodec: string;
  crf: number;
  preset: string;
  /** Where the temporary files go: a folder of its own is made inside it and removed afterwards. */
  workDirectory: string;
  fontsDirectory?: string;
  /** The whisper.cpp files to look at; null when speech recognition is done by a hosted service (nothing on this machine to check). `threads` is how it is started (`-t`); left out, it chooses for itself. */
  whisper?: { binaryPath: string; modelPath: string; threads?: number } | null;
  /** Whether the "Follow a face" choice is on offer, so that it is checked too. */
  faceFollowing?: boolean;
  /** How many threads FFmpeg is started with for clips (`-threads`), as for the customers' clips; left out, it chooses for itself. */
  clipThreads?: number;
  /** The portrait the face follower is shown (default: the one in test-assets, which comes with the program). */
  portraitPath?: string;
  /** How long one program may take (default two minutes: a small shared processor is slow, not stuck). */
  stepTimeoutMs?: number;
  /**
   * Whether to also learn what this machine really does, which the other checks cannot say: what limits it has, how whisper.cpp does with a
   * recording of real speech (that its output is understood, with the times of the words, and how long it takes), and how long FFmpeg takes
   * for a few seconds of video at the size of real clips, both with the number of threads the customers' jobs use. On a small shared
   * processor that costs a minute or two, which is why it is a choice.
   */
  realSamples?: boolean;
  /** The size of a vertical clip, which the render sample is made at (without it there is no render sample). */
  clipSize?: { width: number; height: number };
  /** The recording of speech whisper.cpp listens to (default: the one in test-assets, which comes with the program). */
  speechSamplePath?: string;
  /** Where to find what limits this machine (default: the control group files of the container). */
  machine?: () => Promise<MachineLimits>;
}

/** The filters the clips are made with (see clips.ts): captions, the cut-out window, and the whole picture over a blurred copy. */
export const REQUIRED_FILTERS = ['ass', 'crop', 'scale', 'split', 'boxblur', 'overlay'] as const;
/** The smallest file a speech model can be; anything smaller is a failed download. */
export const MIN_MODEL_BYTES = 10 * 1024 * 1024;
/** A public-domain portrait (see test-assets/README.md) that comes with the program, grey, 320x320. */
export const PORTRAIT_PATH = fileURLToPath(new URL('../test-assets/astronaut-320.pgm', import.meta.url));

const SIZE = { width: 144, height: 256 };
const BRIGHT = 200;
const DARK = 100;

// ---------------------------------------------------------------------------------------------------------------------------
// Reading what the programs say about themselves.

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The version FFmpeg or ffprobe reports, e.g. "6.1.1-3ubuntu5"; null when the text is not what these programs print. */
export function versionOf(text: string, program: 'ffmpeg' | 'ffprobe'): string | null {
  return new RegExp(`^${program} version (\\S+)`, 'm').exec(text)?.[1] ?? null;
}
/**
 * Whether the output of `ffmpeg -encoders` lists an encoder. The layout of these listings has changed between FFmpeg versions (a CI run on
 * FFmpeg 8 did not match what versions 4 to 7 print), so a name that is not found here is asked about directly with `helpShowsEncoder`
 * before it is called missing.
 */
export function listsEncoder(text: string, name: string): boolean {
  return new RegExp(`^\\s*[VAS][A-Za-z.]{3,8}\\s+${escapeRegExp(name)}(?:\\s|$)`, 'm').test(text);
}
/**
 * Whether the output of `ffmpeg -filters` lists a filter. FFmpeg 4 to 7 print three flag characters before the name (` ... ass`),
 * FFmpeg 8 prints two (` .. ass`); same caution as above: `helpShowsFilter` has the last word.
 */
export function listsFilter(text: string, name: string): boolean {
  return new RegExp(`^\\s*[A-Za-z.|]{2,6}\\s+${escapeRegExp(name)}\\s`, 'm').test(text);
}
/** Whether the output of `ffmpeg -h filter=NAME` is the help of a filter that exists ("Filter ass") and not "Unknown filter 'ass'.". */
export function helpShowsFilter(text: string, name: string): boolean {
  return new RegExp(`^Filter ${escapeRegExp(name)}\\s*$`, 'm').test(text);
}
/** Whether the output of `ffmpeg -h encoder=NAME` is the help of an encoder that exists ("Encoder libx264 [...]:") and not "Codec 'x' is not recognized". */
export function helpShowsEncoder(text: string, name: string): boolean {
  return new RegExp(`^Encoder ${escapeRegExp(name)}\\s`, 'm').test(text);
}
/**
 * What libass says it chose for the caption font, from FFmpeg's verbose log; null when the log does not say (older libass versions are silent).
 * For fonts it was handed from a folder this is the name of the face ("Inter-ExtraBold"), for fonts it finds on the system a path.
 */
export function fontChosenIn(log: string): string | null {
  const choices = [...log.matchAll(/fontselect: \([^)]*\) -> (.+?), -?\d+, [^\n]*$/gm)];
  return choices.length ? choices[choices.length - 1][1] : null;
}
/**
 * Whether what libass chose is one of the bundled font files. Fonts handed over from a folder are reported by the name of the face
 * ("Inter-ExtraBold", libass prefers them to any font of the same name on the system); a path means libass went to the system's own fonts,
 * which is the bundled font only if the path is inside the bundled folder. A copy of the same font installed on the server does not count:
 * the point of bundling is not depending on what a server has.
 */
export function isBundledFont(chosen: string, fontsDirectory: string, fontFiles: readonly string[]): boolean {
  const wanted = chosen.trim().toLowerCase();
  if (wanted.includes('/') || wanted.includes('\\')) return wanted.startsWith(fontsDirectory.toLowerCase());
  return fontFiles.some((file) => file.replace(/\.[^.]+$/, '').toLowerCase() === wanted);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Looking at pixels (the frames are plain 8-bit grey, one byte per pixel).

export const pixelAt = (grey: Buffer, width: number, x: number, y: number) => grey[y * width + x];
export const countAtLeast = (grey: Buffer, level: number) => { let count = 0; for (const value of grey) if (value >= level) count += 1; return count; };

// ---------------------------------------------------------------------------------------------------------------------------
// Learning what this machine really does (optional, see `realSamples`).

/** A recording of speech that comes with the program (see test-assets/README.md): 11 seconds, 16 kHz mono, the end of a famous public-domain speech. */
export const SPEECH_SAMPLE_PATH = fileURLToPath(new URL('../test-assets/jfk.wav', import.meta.url));
export const SPEECH_SAMPLE_TEXT = 'And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.';
export const SPEECH_SAMPLE_SECONDS = 11;

const wordsOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

/** How much of what was said was written, as a share: the longest run of words that both texts have in the same order, over the number of words said. */
export function shareOfWordsHeard(written: string, said: string): number {
  const heard = wordsOf(written); const spoken = wordsOf(said);
  if (!spoken.length) return 0;
  let previous = new Array<number>(heard.length + 1).fill(0);
  for (const word of spoken) {
    const row = [0];
    for (let index = 0; index < heard.length; index += 1) row.push(heard[index] === word ? previous[index] + 1 : Math.max(previous[index + 1], row[index]));
    previous = row;
  }
  return previous[heard.length] / spoken.length;
}

export interface SpeechSampleVerdict { words: number; share: number; text: string; }

/**
 * Whether what the speech engine wrote for the recording is what a working engine writes: the words of the speech (most of them, in order),
 * each with a time, the times in order and spread over the recording and not piled up at one end. Throws, saying what is wrong, when not.
 * What this finds is a model that is damaged or not the one expected, output that is read wrongly, and word times that cannot be used.
 */
export function judgeSpeechSample(segments: TranscriptInput): SpeechSampleVerdict {
  if (!segments.length) throw new Error('nothing was written for a recording of clear speech');
  const text = segments.map((segment) => segment.text).join(' ');
  const share = shareOfWordsHeard(text, SPEECH_SAMPLE_TEXT);
  if (share < 0.75) throw new Error(`the recording says "${SPEECH_SAMPLE_TEXT}" but what was written is "${text.slice(0, 160)}" (${Math.round(share * 100)}% of the words)`);
  const words = segments.flatMap((segment) => segment.words ?? []);
  if (!words.length) throw new Error('the text came without a time for each word, so the captions could not light the word being spoken');
  let previousStart = 0;
  for (const word of words) {
    const usable = Number.isFinite(word.startSeconds) && Number.isFinite(word.endSeconds) && word.startSeconds >= 0 && word.endSeconds >= word.startSeconds && word.endSeconds <= SPEECH_SAMPLE_SECONDS + 1;
    if (!usable) throw new Error(`the word "${word.text}" has a time that cannot be right (${word.startSeconds} to ${word.endSeconds} s in a recording of ${SPEECH_SAMPLE_SECONDS} s)`);
    if (word.startSeconds < previousStart - 0.05) throw new Error(`the word "${word.text}" is timed before the one that comes before it`);
    previousStart = word.startSeconds;
  }
  const first = words[0].startSeconds; const last = words[words.length - 1].endSeconds;
  if (first > 3 || last < 7) throw new Error(`the words are timed between ${first.toFixed(1)} and ${last.toFixed(1)} s, but the speech runs from the start of the recording to nearly its end`);
  return { words: words.length, share, text };
}

// ---------------------------------------------------------------------------------------------------------------------------

function describeFailure(error: unknown): string {
  if (error && typeof error === 'object') {
    const failure = error as { code?: unknown; syscall?: unknown; killed?: unknown; stderr?: unknown; message?: unknown };
    const wasStarting = typeof failure.syscall === 'string' && failure.syscall.startsWith('spawn');
    if (wasStarting && failure.code === 'ENOENT') return 'the program was not found (is it installed, and is the path right?)';
    if (wasStarting && failure.code === 'EACCES') return 'the program is not allowed to run';
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : '';
    const tail = stderr.trim().split('\n').slice(-3).join(' | ');
    const base = failure.killed === true ? 'it took too long and was stopped' : typeof failure.message === 'string' ? failure.message.trim().replace(/\s*\n\s*/g, ' | ') : 'it failed';
    return (tail && !base.includes(tail) ? `${base}: ${tail}` : base).slice(-500);
  }
  return String(error).slice(-500);
}

export async function checkToolchain(options: ToolchainCheckOptions): Promise<ToolchainReport> {
  const steps: ToolchainStep[] = [];
  const timeout = options.stepTimeoutMs ?? 120_000;
  const fontsDirectory = options.fontsDirectory ?? BUNDLED_FONTS_DIRECTORY;
  const text = async (program: string, args: string[]) => (await execFileAsync(program, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })).stdout;
  /** Every picture of a tiny clip as plain grey (one byte per pixel); seeking to a moment near the end of a short clip can find nothing, decoding it all cannot. */
  const pictures = async (video: string) => {
    const { stdout } = await execFileAsync(options.ffmpegPath, ['-nostdin', '-v', 'error', '-i', video, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
    const size = SIZE.width * SIZE.height;
    if (stdout.length < 3 * size || stdout.length % size !== 0) throw new Error(`the clip should hold whole ${SIZE.width}x${SIZE.height} pictures, but FFmpeg gave ${stdout.length} bytes`);
    return Array.from({ length: stdout.length / size }, (_unused, index) => stdout.subarray(index * size, (index + 1) * size));
  };

  const record = async (name: string, work: () => Promise<string>): Promise<boolean> => {
    const started = performance.now();
    try {
      const detail = await work();
      steps.push({ name, ok: true, ms: Math.round(performance.now() - started), detail });
      return true;
    } catch (error) {
      steps.push({ name, ok: false, ms: Math.round(performance.now() - started), detail: describeFailure(error) });
      return false;
    }
  };
  const skip = (name: string, because: string) => { steps.push({ name, ok: false, ms: 0, detail: `not run: ${because}` }); };
  const wantsRenderSample = options.realSamples === true && options.clipSize !== undefined;
  const ffmpegSteps = ['test-video', 'captions', 'whole-picture', 'moving-window', ...(wantsRenderSample ? ['render-speed'] : []), ...(options.faceFollowing ? ['face-following'] : [])];

  if (options.realSamples) {
    // What the machine is like is only told, never judged: a machine whose limits cannot be read is not a machine that does not work.
    await record('machine', async () => {
      try { return describeMachine(await (options.machine ?? readMachineLimits)()); }
      catch (error) { return `could not be found out (${describeFailure(error)})`; }
    });
  }

  /** whisper.cpp listens to the recording that comes with the program, through the very code that listens to customers' videos. */
  const listenToSample = async (whisper: { binaryPath: string; modelPath: string; threads?: number }): Promise<string> => {
    const recording = options.speechSamplePath ?? SPEECH_SAMPLE_PATH;
    await access(recording, constants.R_OK).catch(() => { throw new Error('the recording of speech is not installed with the program'); });
    const folder = await mkdtemp(join(options.workDirectory, 'speech-sample-'));
    try {
      // The recording is English, so it is listened to as English whatever language the service is set to: it is the program that is checked, not the setting.
      // With the number of threads the customers' jobs use, so that the time is the time a job gets.
      const started = performance.now();
      const segments = await new WhisperCppTranscriber(whisper.binaryPath, whisper.modelPath, 'en', Math.max(timeout, 300_000), whisper.threads).transcribe(recording, folder);
      const seconds = (performance.now() - started) / 1000;
      const verdict = judgeSpeechSample(segments);
      return `wrote ${verdict.words} words with their times, ${Math.round(verdict.share * 100)}% of those said ("${verdict.text.slice(0, 60)}${verdict.text.length > 60 ? '…' : ''}"); ${seconds.toFixed(1)} s to listen to ${SPEECH_SAMPLE_SECONDS} s of speech, with ${describeThreads(whisper.threads)}`;
    } finally { await rm(folder, { recursive: true, force: true }).catch(() => undefined); }
  };

  const ffmpegWorks = await record('ffmpeg', async () => {
    const version = versionOf(await text(options.ffmpegPath, ['-hide_banner', '-version']), 'ffmpeg');
    if (!version) throw new Error('it did not say which version it is');
    return `ffmpeg ${version}`;
  });
  const ffprobeWorks = await record('ffprobe', async () => {
    const version = versionOf(await text(options.ffprobePath, ['-hide_banner', '-version']), 'ffprobe');
    if (!version) throw new Error('it did not say which version it is');
    return `ffprobe ${version}`;
  });
  if (ffmpegWorks) {
    await record('encoders', async () => {
      const listing = await text(options.ffmpegPath, ['-hide_banner', '-encoders']);
      const missing: string[] = [];
      for (const name of [options.videoCodec, options.audioCodec]) {
        if (listsEncoder(listing, name)) continue;
        const help = await text(options.ffmpegPath, ['-hide_banner', '-h', `encoder=${name}`]).catch(() => '');
        if (!helpShowsEncoder(help, name)) missing.push(name);
      }
      if (missing.length) throw new Error(`this FFmpeg has no encoder named ${missing.join(' or ')}`);
      return `${options.videoCodec}, ${options.audioCodec}`;
    });
    await record('filters', async () => {
      const listing = await text(options.ffmpegPath, ['-hide_banner', '-filters']);
      const missing: string[] = [];
      for (const name of REQUIRED_FILTERS) {
        if (listsFilter(listing, name)) continue;
        const help = await text(options.ffmpegPath, ['-hide_banner', '-h', `filter=${name}`]).catch(() => '');
        if (!helpShowsFilter(help, name)) missing.push(name);
      }
      if (missing.length) throw new Error(`this FFmpeg has no filter named ${missing.join(', ')}${missing.includes('ass') ? ' (it was built without the caption library)' : ''}`);
      return REQUIRED_FILTERS.join(', ');
    });
  } else { skip('encoders', 'ffmpeg does not work'); skip('filters', 'ffmpeg does not work'); }

  let fontFiles: string[] = [];
  await record('fonts', async () => {
    fontFiles = (await readdir(fontsDirectory)).filter((name) => /\.(otf|ttf)$/i.test(name));
    if (!fontFiles.length) throw new Error('the bundled caption font is missing from the installed program');
    return fontFiles.join(', ');
  });

  if (options.whisper) {
    const { binaryPath, modelPath } = options.whisper;
    const speechEngineWorks = await record('speech-engine', async () => {
      await access(binaryPath, constants.X_OK).catch(() => { throw new Error('whisper.cpp is missing or not executable'); });
      const model = await stat(modelPath).catch(() => { throw new Error('the speech model file is missing'); });
      if (!model.isFile() || model.size < MIN_MODEL_BYTES) throw new Error(`the speech model file is only ${model.size} bytes, so its download did not finish`);
      // Asking for the usage text starts the program (so a missing library shows up) without loading the model.
      const usage = await execFileAsync(binaryPath, ['--help'], { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }).then((out) => `${out.stdout}${out.stderr}`, (error: { stdout?: unknown; stderr?: unknown }) => `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
      if (!/usage/i.test(usage)) throw new Error('whisper.cpp started but did not print what a working copy prints');
      return `whisper.cpp runs, model ${Math.round(model.size / 1024 / 1024)} MB`;
    });
    if (options.realSamples) {
      if (speechEngineWorks) await record('speech-sample', () => listenToSample(options.whisper!));
      else skip('speech-sample', 'the speech engine check failed');
    }
  }

  if (!ffmpegWorks || !ffprobeWorks) {
    for (const name of ffmpegSteps) skip(name, ffmpegWorks ? 'ffprobe does not work' : 'ffmpeg does not work');
    return { ok: false, steps };
  }

  let folder: string | undefined;
  try {
    const work = await mkdtemp(join(options.workDirectory, 'toolchain-check-'));
    folder = work;
    const source = join(work, 'source.mp4');
    const made = await record('test-video', async () => {
      // A dark picture with a white bar down its left edge: the bar is what shows where the picture was cut.
      await execFileAsync(options.ffmpegPath, [
        '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x180:r=10:d=2,drawbox=x=0:y=0:w=24:h=180:color=white:t=fill',
        '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:v', options.videoCodec, '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', options.audioCodec, source,
      ], { timeout, maxBuffer: 4 * 1024 * 1024 });
      return '320x180, 2 s, with sound';
    });
    if (!made) { for (const name of ffmpegSteps.slice(1)) skip(name, 'the test video could not be made'); return { ok: false, steps }; }

    // The clips are made by the real renderer, asked to log what libass decides (which font it picked).
    let log = '';
    const runner: FfmpegRunner = async (binary, args, runOptions) => { log = (await execFileAsync(binary, ['-loglevel', 'verbose', ...args], { ...runOptions, encoding: 'utf8' })).stderr; };
    const renderer = new FfmpegClipRenderer(options.ffmpegPath, options.videoCodec, options.audioCodec, options.crf, options.preset, SIZE.width, SIZE.height, runner, fontsDirectory);
    const shape = async (video: string, size: { width: number; height: number } = SIZE) => {
      const { stdout } = await execFileAsync(options.ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', video], { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      const streams = (JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> }).streams ?? [];
      const picture = streams.find((stream) => stream.codec_type === 'video');
      if (!picture || picture.width !== size.width || picture.height !== size.height) throw new Error(`the clip should be ${size.width}x${size.height} but is ${picture?.width ?? '?'}x${picture?.height ?? '?'}`);
      if (!streams.some((stream) => stream.codec_type === 'audio')) throw new Error('the clip has no sound');
      return picture.codec_name ?? '?';
    };

    await record('captions', async () => {
      const captions = join(work, 'captions.ass');
      await writeAssCaptions(captions, [{ startSeconds: 0, endSeconds: 1, text: 'Caption check' }], 0, 1, 'classic');
      const output = join(work, 'captions.mp4');
      await renderer.render({ sourcePath: source, startSeconds: 0.2, endSeconds: 1.2, outputPath: output, captionPath: captions });
      const codec = await shape(output);
      const all = await pictures(output);
      const frame = all[Math.floor(all.length / 2)];
      const drawn = countAtLeast(frame, BRIGHT);
      if (drawn < 12) throw new Error(`the captions were not drawn (${drawn} bright points where the words should be)`);
      if (pixelAt(frame, SIZE.width, 4, 128) >= DARK) throw new Error('the middle of the picture was not cut out: the bar at the edge of the picture is still there');
      const font = fontChosenIn(log);
      if (font !== null && !isBundledFont(font, fontsDirectory, fontFiles)) throw new Error(`the captions were drawn with another font than the bundled one (${font})`);
      return `${codec}, captions drawn (${drawn} bright points), ${font === null ? 'font choice not reported by this FFmpeg' : 'with the bundled font'}`;
    });

    await record('whole-picture', async () => {
      const output = join(work, 'fit.mp4');
      await renderer.render({ sourcePath: source, startSeconds: 0.2, endSeconds: 1.2, outputPath: output, layout: 'fit' });
      await shape(output);
      const all = await pictures(output);
      const frame = all[Math.floor(all.length / 2)];
      if (pixelAt(frame, SIZE.width, 4, 128) < BRIGHT) throw new Error('the edge of the picture is missing: the whole picture is not shown');
      if (pixelAt(frame, SIZE.width, 4, 20) >= DARK) throw new Error('the space above the picture is not filled with the dark blurred copy');
      return 'the whole picture is shown over its blurred copy';
    });

    await record('moving-window', async () => {
      const plan: FramingPlan = { keyframes: [{ seconds: 0, position: 0 }, { seconds: 1, position: 1 }] };
      const output = join(work, 'moving.mp4');
      await renderer.render({ sourcePath: source, startSeconds: 0.2, endSeconds: 1.2, outputPath: output, framing: plan });
      await shape(output);
      const all = await pictures(output);
      const atStart = pixelAt(all[0], SIZE.width, 4, 128);
      const atEnd = pixelAt(all[all.length - 1], SIZE.width, 4, 128);
      if (atStart < BRIGHT) throw new Error('the window did not start at the left edge of the picture');
      if (atEnd >= DARK) throw new Error('the window did not move away from the left edge');
      return 'the window moves from the left edge to the right';
    });

    if (wantsRenderSample) {
      const { width, height } = options.clipSize!;
      await record('render-speed', async () => {
        // Three seconds of a busy picture (a test pattern, with sound) as large as the videos people upload, cut and captioned into a clip of the real size.
        const picture = join(work, 'sample-source.mp4');
        await execFileAsync(options.ffmpegPath, [
          '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=3',
          '-t', '3', '-c:v', options.videoCodec, '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', options.audioCodec, picture,
        ], { timeout, maxBuffer: 4 * 1024 * 1024 });
        const captions = join(work, 'sample-captions.ass');
        const spoken = ['Counting', 'the', 'words', 'as', 'they', 'are', 'spoken'];
        await writeAssCaptions(captions, [{ startSeconds: 0, endSeconds: 3, text: spoken.join(' '), words: spoken.map((text, index) => ({ text, startSeconds: (index * 3) / spoken.length, endSeconds: ((index + 1) * 3) / spoken.length })) }], 0, 3, 'highlight');
        // By the very renderer, with the very settings (preset, quality, threads) of the customers' clips.
        const clip = new FfmpegClipRenderer(options.ffmpegPath, options.videoCodec, options.audioCodec, options.crf, options.preset, width, height, undefined, fontsDirectory, options.clipThreads);
        const output = join(work, 'sample-clip.mp4');
        const started = performance.now();
        await clip.render({ sourcePath: picture, startSeconds: 0, endSeconds: 3, outputPath: output, captionPath: captions });
        const seconds = (performance.now() - started) / 1000;
        // A speed is only worth telling for a clip that is what it was meant to be.
        await shape(output, { width, height });
        return `3 s of ${width}x${height} with captions, from a busy 1920x1080 picture, took ${seconds.toFixed(1)} s with preset ${options.preset} and ${describeThreads(options.clipThreads)} (${(seconds / 3).toFixed(1)} times the length of the clip)`;
      });
    }

    if (options.faceFollowing) {
      await record('face-following', async () => {
        const portrait = options.portraitPath ?? PORTRAIT_PATH;
        await access(portrait, constants.R_OK).catch(() => { throw new Error('the test portrait is not installed with the program'); });
        // The portrait crosses a grey picture, left to right, in three seconds.
        const walker = join(work, 'walker.mp4');
        await execFileAsync(options.ffmpegPath, [
          '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x707070:s=640x360:r=10:d=3', '-loop', '1', '-framerate', '10', '-i', portrait,
          '-filter_complex', "[0:v][1:v]overlay=x='(W-w)*t/3':y=20:shortest=1,format=yuv420p", '-t', '3', '-c:v', options.videoCodec, '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', walker,
        ], { timeout, maxBuffer: 4 * 1024 * 1024 });
        const result = await new FaceClipFramer({ ffmpegPath: options.ffmpegPath, outputAspect: SIZE.width / SIZE.height, timeoutMs: timeout, threads: options.clipThreads }).frame({ sourcePath: walker, startSeconds: 0, endSeconds: 3 });
        if (!result.followed) throw new Error(`no face was found in a picture of a face (${result.note})`);
        const travelled = positionAt(result.plan.keyframes, 3) - positionAt(result.plan.keyframes, 0);
        if (travelled < 0.4) throw new Error(`a face crossed the picture but the window moved only ${Math.round(travelled * 100)}% of the way`);
        return `a face was followed across the picture, seen in ${Math.round(result.seenShare * 100)}% of the moments checked`;
      });
    }
  } catch (error) {
    steps.push({ name: 'work-folder', ok: false, ms: 0, detail: describeFailure(error) });
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
  return { ok: steps.every((step) => step.ok), steps };
}

// ---------------------------------------------------------------------------------------------------------------------------

export type ToolchainState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
/** What the health check shows: whether it passed and which checks failed, never the details (versions, paths). */
export interface ToolchainStatus { state: ToolchainState; checkedAt: string | null; failed: string[]; }

export interface ToolchainLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/**
 * Runs the check once, when the server has nothing else to do. A small server cannot afford a memory spike on top of a job (the free
 * instance peaked at 93% of its memory with one running), so the check waits until no job is running and no request is being handled,
 * looks again every `retryMs`, and gives up (state `skipped`, said in the log) after `maxWaitMs`.
 */
export class ToolchainMonitor {
  private current: ToolchainStatus = { state: 'pending', checkedAt: null, failed: [] };
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly options: { check: () => Promise<ToolchainReport>; isBusy: () => boolean; logger: ToolchainLogger; retryMs?: number; maxWaitMs?: number }) {}

  get status(): ToolchainStatus { return { ...this.current, failed: [...this.current.failed] }; }

  async run(): Promise<ToolchainStatus> {
    const retryMs = this.options.retryMs ?? 20_000;
    const maxWaitMs = this.options.maxWaitMs ?? 10 * 60_000;
    let waited = 0;
    while (!this.stopped && this.options.isBusy()) {
      if (waited >= maxWaitMs) {
        this.current = { state: 'skipped', checkedAt: new Date().toISOString(), failed: [] };
        this.options.logger.warn({}, `Toolchain check skipped: the server stayed busy for ${Math.round(maxWaitMs / 1000)} s, and a check on top of a running job could use up the memory`);
        return this.status;
      }
      await this.sleep(retryMs);
      waited += retryMs;
    }
    if (this.stopped) return this.status;
    this.current = { state: 'running', checkedAt: null, failed: [] };
    try {
      const report = await this.options.check();
      const failed = report.steps.filter((step) => !step.ok).map((step) => step.name);
      this.current = { state: report.ok ? 'passed' : 'failed', checkedAt: new Date().toISOString(), failed };
      const totalMs = report.steps.reduce((sum, step) => sum + step.ms, 0);
      if (report.ok) this.options.logger.info({ steps: report.steps }, `Toolchain check passed (${report.steps.length} checks, ${totalMs} ms): ${report.steps.find((step) => step.name === 'ffmpeg')?.detail ?? 'ffmpeg'}`);
      else this.options.logger.error({ steps: report.steps }, `Toolchain check FAILED: ${failed.join(', ')}. Clips or transcripts that depend on these will fail until it is fixed`);
    } catch (error) {
      this.current = { state: 'failed', checkedAt: new Date().toISOString(), failed: ['check-crashed'] };
      this.options.logger.error({ err: error }, 'Toolchain check could not be carried out');
    }
    return this.status;
  }

  /** Ends the waiting (a server that is closing must not be kept open by it). */
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.wake?.(); }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.wake = resolve; this.timer = setTimeout(resolve, ms); this.timer.unref(); });
  }
}
