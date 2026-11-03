/**
 * HDR video from phones. An iPhone records HDR by default (HLG, the transfer curve called arib-std-b67), and many Android phones record HDR10
 * (PQ, smpte2084) when asked: ten bits per colour, wide BT.2020 colours. Drawn as if it were an ordinary picture such a video looks flat and dull,
 * and cut into a clip with the same pixel format it would be an H.264 "High 10" video that most phones and browsers cannot play at all. So a clip
 * is always made as an ordinary 8-bit picture (see clips.ts), and, where this FFmpeg can, with the colours of one (this file).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type HdrKind = 'hlg' | 'pq';

/** Which kind of HDR a picture is in, from the transfer curve ffprobe reports for it; nothing for an ordinary picture (or one that does not say). */
export function hdrKindOf(transfer: string | undefined): HdrKind | undefined {
  if (transfer === 'arib-std-b67') return 'hlg';
  if (transfer === 'smpte2084') return 'pq';
  return undefined;
}

/** The two FFmpeg filters the conversion needs (zscale comes with the zimg library, which not every build of FFmpeg has). */
export const TONE_MAPPING_FILTERS = ['zscale', 'tonemap'] as const;

/**
 * From an HDR picture (HLG or PQ, BT.2020) to an ordinary one (BT.709, 8 bits, 4:2:0): to linear light, into BT.709's colours, the brightness
 * squeezed into what an ordinary screen shows ("hable"), and back to BT.709's curve. This is the recipe of the FFmpeg wiki. The input must say
 * what it is (transfer, primaries, matrix), which a video from a phone does; one that does not makes FFmpeg fail, and clips.ts then makes the
 * clip without the conversion. The output carries BT.709 tags, which zscale sets.
 */
export const TONE_MAP_TO_SDR = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/**
 * Whether what FFmpeg printed when it failed is about the conversion of colours (and not, say, a full disk or a damaged file). Only what the program
 * printed is looked at, never the message of the error that carries the whole command line, which names the filters whatever went wrong.
 */
export function isColourConversionFailure(printed: unknown): boolean {
  return typeof printed === 'string' && /zscale|tonemap|colou?rspace/i.test(printed);
}

/** What the colour tags of a picture are after the conversion above: those of an ordinary (BT.709) video, stated for the encoder so that every FFmpeg writes them. */
export const SDR_COLOUR_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] as const;

/**
 * A filter that gives the pictures passing it the colour tags a camera would have written (any of them may be left out). It is how a made-up picture
 * says what colours it has, because the other ways are not the same on every FFmpeg (found by trying them on 5.1, 6.1 and 8):
 * - tags given in the graph that makes the picture are lost on the way to the next graph by FFmpeg 5.1 (the conversion then fails for want of a
 *   transfer curve), so the picture says it in the graph that converts it;
 * - a file written with the encoder options `-color_trc` and `-color_primaries` alone carries no such tags when FFmpeg 8 wrote it (it keeps
 *   `-colorspace`, and ignores those two), while tags that the pictures themselves carry are written by all three.
 */
export function saysColours(tags: { primaries?: string; transfer?: string; matrix?: string; range?: string }): string {
  const parts = [
    tags.primaries && `color_primaries=${tags.primaries}`, tags.transfer && `color_trc=${tags.transfer}`,
    tags.matrix && `colorspace=${tags.matrix}`, tags.range && `range=${tags.range}`,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) throw new Error('A picture that says nothing about its colours needs no filter.');
  return `setparams=${parts.join(':')}`;
}
/** What an iPhone's picture says: BT.2020 colours, the HLG curve, the usual limited range. */
export const SAYS_HLG = saysColours({ primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv' });
/** What HDR10's picture says: the same colours with the PQ curve. */
export const SAYS_PQ = saysColours({ primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020nc', range: 'tv' });

/** CLIP_TONE_MAP_HDR as it is set: yes, no, or `auto` (what it is when nothing is set): yes where the machine has the memory for it. */
export type ToneMappingSetting = 'auto' | boolean;

/**
 * The memory a machine needs for converting the colours of clips of the real size (1080x1920), so that nothing less is asked to. Measured with FFmpeg 6.1.1 on a
 * full-HD HLG video: a clip made as it is peaked at 234 MiB with one thread and 279 MiB with two, one made with the conversion at 320 and 368 MiB (about 90 MiB more:
 * the picture is worked on as floating-point numbers), and the server itself holds about 190 MiB after a job. The free instance has 512 MiB, where a whole job without
 * the conversion peaked at 475 MiB already (see the README), so a machine with less than this does not convert unless it is told to (`CLIP_TONE_MAP_HDR=true`).
 */
export const TONE_MAPPING_MIN_MEMORY_BYTES = 1024 * 1024 * 1024;

export interface ToneMappingDecision { convert: boolean; why: string; }

/** Whether this machine is to convert the colours of HDR video (before it is tried, see `probeToneMapping`), and why, in words for the log. `memoryBytes` is what the machine may use, null when that is not known. */
export function decideToneMapping(setting: ToneMappingSetting, memoryBytes: number | null): ToneMappingDecision {
  if (setting === false) return { convert: false, why: 'converting its colours is switched off (CLIP_TONE_MAP_HDR)' };
  if (setting === true) return { convert: true, why: 'converting its colours is asked for (CLIP_TONE_MAP_HDR)' };
  if (memoryBytes === null) return { convert: true, why: 'nothing says that this machine has too little memory for converting its colours' };
  const mebibytes = Math.round(memoryBytes / (1024 * 1024));
  if (memoryBytes < TONE_MAPPING_MIN_MEMORY_BYTES) return { convert: false, why: `converting its colours is left off on this machine, which has ${mebibytes} MiB of memory: it needs about 90 MiB more for every clip (CLIP_TONE_MAP_HDR=true converts them anyway)` };
  return { convert: true, why: `this machine has ${mebibytes} MiB of memory, enough for converting its colours` };
}

export interface ToneMappingSupport { works: boolean; detail: string; }
/** Runs a program and gives what it wrote (a stand-in for tests). */
export type PictureProgram = (binary: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<Buffer>;

const PROBE = { width: 64, height: 36 };

/**
 * Whether this FFmpeg can really convert HDR colours: the conversion above is run on a tiny made-up HLG picture (BT.2020, ten bits), the way a clip
 * from a phone would meet it. Looking for the filters in a list would not say whether they work together (zscale needs the zimg library, and a
 * build can list a filter it cannot run), so it is tried. Never throws: a machine that cannot is a machine without the conversion, not a failure.
 * The picture says what colours it has in the very graph that converts it (see `saysColours`); said anywhere else, FFmpeg 5.1 (the one on Render)
 * lost it and the trial reported that the conversion cannot be done, which it can.
 */
export async function probeToneMapping(ffmpegPath: string, options: { timeoutMs?: number; run?: PictureProgram } = {}): Promise<ToneMappingSupport> {
  const run: PictureProgram = options.run ?? (async (binary, args, runOptions) => (await execFileAsync(binary, args, { ...runOptions, encoding: 'buffer' })).stdout);
  const started = performance.now();
  try {
    const picture = `color=c=0x808080:s=${PROBE.width}x${PROBE.height}:r=1:d=1,format=yuv420p10le`;
    const made = await run(ffmpegPath, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', picture, '-vf', `${SAYS_HLG},${TONE_MAP_TO_SDR}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { timeout: options.timeoutMs ?? 60_000, maxBuffer: 1024 * 1024 });
    const expected = (PROBE.width * PROBE.height * 3) / 2;
    if (made.length !== expected) return { works: false, detail: `a test picture of ${expected} bytes came out as ${made.length} bytes` };
    return { works: true, detail: `a test HLG picture was converted in ${Math.round(performance.now() - started)} ms` };
  } catch (error) {
    const failure = (typeof error === 'object' && error ? error : {}) as { stderr?: unknown; message?: unknown; code?: unknown; killed?: unknown };
    if (failure.code === 'ENOENT') return { works: false, detail: 'ffmpeg was not found' };
    if (failure.killed === true) return { works: false, detail: 'it took too long and was stopped' };
    const printed = typeof failure.stderr === 'string' ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : '';
    const lines = printed.trim().split('\n').filter(Boolean);
    return { works: false, detail: (lines.slice(-2).join(' | ') || (typeof failure.message === 'string' ? failure.message.split('\n')[0] : 'it failed')).slice(-300) };
  }
}
