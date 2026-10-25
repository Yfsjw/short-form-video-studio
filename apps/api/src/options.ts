import { z } from 'zod';
import { aspectChoices, captionAccents, captionPositions, captionSizes, captionStyles, clipLengthChoices, defaultJobOptions, framingChoices, qualityChoices, type AspectChoice, type ClipLengthChoice, type JobOptions, type QualityChoice } from './domain.js';
import type { HighlightOptions } from './highlights.js';

export const MAX_CLIP_COUNT = 5;

/** The clip lengths behind the names people choose from, in seconds. `auto` is absent on purpose: it means "the server's own defaults". */
export const clipLengthRanges: Record<Exclude<ClipLengthChoice, 'auto'>, { min: number; max: number }> = {
  short: { min: 15, max: 30 },
  medium: { min: 30, max: 60 },
  long: { min: 60, max: 90 },
};

/** A form that was left blank means "no preference". */
const blankIsMissing = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const fields = {
  clipCount: z.preprocess(blankIsMissing, z.coerce.number().int().min(1).max(MAX_CLIP_COUNT).optional()),
  clipLength: z.preprocess(blankIsMissing, z.enum(clipLengthChoices).optional()),
  quality: z.preprocess(blankIsMissing, z.enum(qualityChoices).optional()),
  captionStyle: z.preprocess(blankIsMissing, z.enum(captionStyles).optional()),
  captionAccent: z.preprocess(blankIsMissing, z.enum(captionAccents).optional()),
  captionPosition: z.preprocess(blankIsMissing, z.enum(captionPositions).optional()),
  captionSize: z.preprocess(blankIsMissing, z.enum(captionSizes).optional()),
  framing: z.preprocess(blankIsMissing, z.enum(framingChoices).optional()),
  aspect: z.preprocess(blankIsMissing, z.enum(aspectChoices).optional()),
};
const requestSchema = z.object(fields);

export type ParsedOptions = { ok: true; options: JobOptions } | { ok: false; message: string };

/** Reads the options a person chose in the upload form (or the API call). Anything unknown is ignored; a value that is not allowed is refused with a plain message. */
export function parseJobOptions(input: unknown): ParsedOptions {
  const source = input && typeof input === 'object' ? input : {};
  const result = requestSchema.safeParse(source);
  if (!result.success) {
    const issue = result.error.issues[0];
    const name = issue?.path[0] !== undefined ? String(issue.path[0]) : 'option';
    return { ok: false, message: `The option “${name}” is not valid${name === 'clipCount' ? ` (choose a whole number from 1 to ${MAX_CLIP_COUNT})` : ''}.` };
  }
  return { ok: true, options: { ...defaultJobOptions, clipCount: result.data.clipCount ?? null, clipLength: result.data.clipLength ?? defaultJobOptions.clipLength, quality: result.data.quality ?? defaultJobOptions.quality, captionStyle: result.data.captionStyle ?? defaultJobOptions.captionStyle, captionAccent: result.data.captionAccent ?? defaultJobOptions.captionAccent, captionPosition: result.data.captionPosition ?? defaultJobOptions.captionPosition, captionSize: result.data.captionSize ?? defaultJobOptions.captionSize, framing: result.data.framing ?? defaultJobOptions.framing, aspect: result.data.aspect ?? defaultJobOptions.aspect } };
}

/** Reads options back from the database. A value that is no longer allowed (a release that dropped a choice) falls back to its default; the others are kept. */
export function readStoredOptions(json: string | null | undefined): JobOptions {
  let stored: Record<string, unknown> = {};
  try { const parsed: unknown = json ? JSON.parse(json) : {}; if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>; } catch { /* unreadable: all defaults */ }
  const count = typeof stored.clipCount === 'number' ? stored.clipCount : Number.NaN;
  const oneOf = <T extends string>(choices: readonly T[], value: unknown, fallback: T): T => (choices as readonly unknown[]).includes(value) ? (value as T) : fallback;
  return {
    clipCount: Number.isInteger(count) && count >= 1 && count <= MAX_CLIP_COUNT ? count : null,
    clipLength: oneOf(clipLengthChoices, stored.clipLength, defaultJobOptions.clipLength),
    quality: oneOf(qualityChoices, stored.quality, defaultJobOptions.quality),
    captionStyle: oneOf(captionStyles, stored.captionStyle, defaultJobOptions.captionStyle),
    captionAccent: oneOf(captionAccents, stored.captionAccent, defaultJobOptions.captionAccent),
    captionPosition: oneOf(captionPositions, stored.captionPosition, defaultJobOptions.captionPosition),
    captionSize: oneOf(captionSizes, stored.captionSize, defaultJobOptions.captionSize),
    framing: oneOf(framingChoices, stored.framing, defaultJobOptions.framing),
    aspect: oneOf(aspectChoices, stored.aspect, defaultJobOptions.aspect),
  };
}

/** The highlight settings for one job: the server's defaults, adjusted by what the person asked for. */
export function highlightOptionsFor(base: HighlightOptions, options: JobOptions): HighlightOptions {
  const range = options.clipLength === 'auto' ? undefined : clipLengthRanges[options.clipLength];
  return {
    ...base,
    minDurationSeconds: range?.min ?? base.minDurationSeconds,
    maxDurationSeconds: range?.max ?? base.maxDurationSeconds,
    // Ask the detector for at least as many candidates as clips were requested (some may fail to render).
    maxCandidates: Math.max(base.maxCandidates, options.clipCount ?? 0),
  };
}

/** Width over height of each shape (what a face follower or a crop needs to know about the clip). */
export const aspectRatios: Record<AspectChoice, number> = { vertical: 9 / 16, portrait: 4 / 5, square: 1, landscape: 16 / 9 };

const evenNumber = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * The best-quality picture size of a shape, worked out from the configured vertical size: the tall shapes keep its width (1080), and landscape is the
 * vertical size turned on its side (1080x1920 gives 1920x1080). So the short side of every shape is the same, which is what "1080p" means.
 */
export function shapeSize(base: { width: number; height: number }, aspect: AspectChoice): { width: number; height: number } {
  switch (aspect) {
    case 'portrait': return { width: base.width, height: evenNumber((base.width * 5) / 4) };
    case 'square': return { width: base.width, height: base.width };
    case 'landscape': return { width: base.height, height: base.width };
    default: return base;
  }
}

/**
 * The picture size of a clip: the configured size of its shape, or two thirds of it for `standard` (never larger than configured, always even,
 * and always exactly the shape asked for). `base` is the server's configured vertical size, whatever the shape.
 */
export function outputSizeFor(base: { width: number; height: number }, quality: QualityChoice, aspect: AspectChoice = 'vertical'): { width: number; height: number } {
  const full = shapeSize(base, aspect);
  if (quality === 'hd' || base.width <= 720) return full;
  const width = Math.max(2, Math.round(full.width / 3) * 2); // two thirds, rounded to an even number
  return { width, height: evenNumber((width * full.height) / full.width) };
}
