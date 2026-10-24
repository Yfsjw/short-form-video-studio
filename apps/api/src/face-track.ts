import { spawn } from 'node:child_process';
import { detectFaces, loadFaceCascade, type DetectOptions } from './haar.js';
import { defaultFramingSettings, planFraming, type FramingObservation, type FramingResult, type FramingSettings } from './framing.js';

/**
 * Looks for faces in a stretch of a video and plans where the picture of a clip is cut from. The pipeline only knows this shape, so tests
 * (and a server where face following is switched off) can put something else in its place.
 */
export interface ClipFramer {
  /** `outputAspect` (width over height of the clip) is the shape of this clip when it is not the one the framer was made for. */
  frame(request: { sourcePath: string; startSeconds: number; endSeconds: number; outputAspect?: number }): Promise<FramingResult>;
}

/** A grey picture: one byte per pixel, row after row. */
export interface GrayPicture { width: number; height: number; pixels: Uint8Array; }

/** Reads the pictures FFmpeg writes as a stream of binary PGM files (a header with the size, then one byte per pixel), one right after the other. */
export async function* readPgmPictures(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<GrayPicture> {
  let buffer: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    for (;;) {
      const header = /^P5\s(\d+)\s(\d+)\s(\d+)\s/.exec(buffer.subarray(0, 40).toString('latin1'));
      if (!header) {
        if (buffer.length >= 40) throw new Error('FFmpeg did not write pictures in the format that was asked for.');
        break; // the header has not arrived whole yet
      }
      const width = Number(header[1]); const height = Number(header[2]); const total = header[0].length + width * height;
      if (!(width > 0 && height > 0) || header[3] !== '255') throw new Error('FFmpeg wrote a picture of a size or depth that was not asked for.');
      if (buffer.length < total) break;
      yield { width, height, pixels: new Uint8Array(buffer.subarray(header[0].length, total)) };
      buffer = buffer.subarray(total);
    }
  }
}

/** How different two pictures of the same size are: the average difference of a pixel (0 to 255), looking at one pixel in every four each way. */
export function meanAbsoluteDifference(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  let total = 0; let count = 0;
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) { total += Math.abs(a[y * width + x] - b[y * width + x]); count += 1; }
  return count ? total / count : 0;
}

/**
 * How different the brightness of two pictures is overall, 0 (the same mix of dark and light) to 1 (nothing in common): half the sum of the
 * differences between their histograms of 32 steps of grey. Content that merely moves (a person walking, a camera panning) leaves it
 * almost unchanged, while a cut to another shot usually does not.
 */
export function histogramDistance(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const first = new Float64Array(32); const second = new Float64Array(32); let count = 0;
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) { first[a[y * width + x] >> 3] += 1; second[b[y * width + x] >> 3] += 1; count += 1; }
  if (!count) return 0;
  let total = 0; for (let bin = 0; bin < 32; bin += 1) total += Math.abs(first[bin] - second[bin]);
  return total / (2 * count);
}

export interface FaceFramerOptions {
  ffmpegPath: string;
  /** The shape of the clip, width over height (9 / 16 for a vertical clip). */
  outputAspect: number;
  /** Pictures taken per second of the clip (default 2); a long clip gets fewer, so that no clip takes more than `maxPictures`. */
  picturesPerSecond?: number; maxPictures?: number;
  /** The pictures are made this wide before the faces are looked for (default 480): smaller is quicker, bigger finds smaller faces. */
  pictureWidth?: number;
  detect?: DetectOptions;
  settings?: Partial<FramingSettings>;
  /**
   * Two pictures are taken to be on the two sides of a cut in the video when the average pixel differs by more than `sceneCutDifference`
   * (0 to 255, default 20) AND the mix of dark and light by more than `sceneCutHistogram` (0 to 1, default 0.3). Both, because a wrongly
   * seen cut makes the camera jump, while a missed one only makes it wait a moment: people walking about change the first but not the second.
   */
  sceneCutDifference?: number; sceneCutHistogram?: number;
  /** FFmpeg is stopped after this long (default ten minutes: a small server is slow). */
  timeoutMs?: number;
}

/**
 * Takes a few small grey pictures per second of the clip with FFmpeg, finds the faces in each with the detector of haar.ts, and lets
 * framing.ts plan the camera from what was seen. Nothing here uses the sound or knows who is speaking.
 */
export class FaceClipFramer implements ClipFramer {
  constructor(private readonly options: FaceFramerOptions) {}

  async frame(request: { sourcePath: string; startSeconds: number; endSeconds: number; outputAspect?: number }): Promise<FramingResult> {
    const clipSeconds = request.endSeconds - request.startSeconds;
    if (!Number.isFinite(clipSeconds) || clipSeconds <= 0) throw new Error('The stretch to look for faces in must have a positive length.');
    const cascade = await loadFaceCascade();
    const perSecond = Math.min(this.options.picturesPerSecond ?? 2, (this.options.maxPictures ?? 180) / clipSeconds);
    const detect: DetectOptions = { scaleFactor: 1.15, minNeighbors: 5, minSize: 32, ...this.options.detect };
    const cutDifference = this.options.sceneCutDifference ?? 20; const cutHistogram = this.options.sceneCutHistogram ?? 0.3;

    const observations: FramingObservation[] = [];
    let previous: Uint8Array | undefined; let width = 0; let height = 0;
    for await (const picture of this.pictures(request.sourcePath, request.startSeconds, clipSeconds, perSecond)) {
      ({ width, height } = picture);
      const faces = detectFaces(cascade, picture.pixels, width, height, detect).map((face) => ({ x: (face.x + face.width / 2) / width, width: face.width / width, neighbors: face.neighbors }));
      const sceneCut = previous !== undefined && meanAbsoluteDifference(previous, picture.pixels, width, height) > cutDifference && histogramDistance(previous, picture.pixels, width, height) > cutHistogram;
      observations.push({ seconds: observations.length / perSecond, faces, ...(sceneCut ? { sceneCut } : {}) });
      previous = picture.pixels;
      // The faces of one picture take a good while on a small server; let it answer other requests in between.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!observations.length) throw new Error('No picture could be taken from the video to look for faces in.');
    return planFraming(observations, clipSeconds, (request.outputAspect ?? this.options.outputAspect) / (width / height), { ...defaultFramingSettings, ...this.options.settings });
  }

  /** FFmpeg's pictures of the stretch, as they arrive. */
  private async *pictures(sourcePath: string, startSeconds: number, clipSeconds: number, perSecond: number): AsyncGenerator<GrayPicture> {
    const filter = `fps=${Number(perSecond.toFixed(4))},scale=${this.options.pictureWidth ?? 480}:-2`;
    // Seeking before the input, as the renderer does, so that the pictures are counted from the start of the clip.
    const args = ['-nostdin', '-v', 'error', '-ss', startSeconds.toFixed(3), '-t', clipSeconds.toFixed(3), '-i', sourcePath, '-an', '-vf', filter, '-pix_fmt', 'gray', '-c:v', 'pgm', '-f', 'image2pipe', 'pipe:1'];
    const child = spawn(this.options.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (text: Buffer) => { stderr = (stderr + text.toString('utf8')).slice(-4000); });
    const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    finished.catch(() => undefined); // looked at below; this only keeps a failure from being "unhandled" while the pictures are still being read
    const timer = setTimeout(() => child.kill('SIGKILL'), this.options.timeoutMs ?? 10 * 60_000);
    try {
      let streamError: unknown;
      try { yield* readPgmPictures(child.stdout); } catch (error) { streamError = error; child.kill('SIGKILL'); }
      const code = await finished; // a program that could not even be started fails here, and that is the real story
      if (streamError) throw streamError;
      if (code !== 0) throw new Error(`FFmpeg could not take pictures from the video (exit code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}
