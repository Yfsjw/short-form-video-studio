import { resolve } from 'node:path';
import { z } from 'zod';

/** A true/false switch read from the environment. Anything that is not a clear yes or no is rejected so a typo in a safety flag fails loudly at startup instead of silently turning the protection off. */
const envFlag = z.string().default('false').transform((value) => value.trim().toLowerCase() || 'false').pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])).transform((value) => ['true', '1', 'yes', 'on'].includes(value));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  // Local default matches the throwaway Postgres instance used for local dev/tests.
  // Render sets the real Neon connection string via this same env var.
  DATABASE_URL: z.string().default('postgresql://postgres:localtest@localhost:5432/studio_local_test'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  TEMP_DIR: z.string().default('./tmp'),
  OUTPUT_DIR: z.string().default('./outputs'),
  // All four optional: when unset, generated clips stay local-disk-only (fine for local
  // dev/tests). Render always sets these so real uploads/clips survive restarts.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  // When on, the server refuses to start unless all four R2 settings are present, instead of
  // quietly falling back to the local disk (which Render wipes on every restart).
  REQUIRE_DURABLE_STORAGE: envFlag,
  // How many jobs may be in their CPU/memory-heavy stages (transcription, rendering) at once.
  // The 512 MB free instance can only afford one.
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  // A job is started at most this many times in total (the first run included); after that it is
  // failed for good, so a video that crashes the server cannot cause an endless crash loop.
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // A running job refreshes its database row every JOB_HEARTBEAT_SECONDS; a queued/processing job
  // untouched for JOB_STALE_AFTER_SECONDS belongs to a process that died and is resumed or failed.
  JOB_STALE_AFTER_SECONDS: z.coerce.number().int().min(2).default(60),
  JOB_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).default(15),
  CLIP_MAX_CANDIDATES: z.coerce.number().int().positive().default(3),
  CLIP_VIDEO_CODEC: z.string().default('libx264'),
  CLIP_AUDIO_CODEC: z.string().default('aac'),
  CLIP_CRF: z.coerce.number().int().min(0).max(51).default(23),
  CLIP_PRESET: z.string().default('veryfast'),
  CLIP_VERTICAL_WIDTH: z.coerce.number().int().positive().default(1080),
  CLIP_VERTICAL_HEIGHT: z.coerce.number().int().positive().default(1920),
  TRANSCRIPTION_ENGINE: z.enum(['whisper_cpp']).default('whisper_cpp'),
  // Render builds .render at the repository root, while the API starts from apps/api.
  WHISPER_CPP_PATH: z.string().default('../../.render/whisper-cli'),
  WHISPER_MODEL_PATH: z.string().default('../../.render/ggml-base.en.bin'),
  TRANSCRIPTION_LANGUAGE: z.string().min(2).max(12).default('en'),
  TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  HIGHLIGHT_MIN_DURATION_SECONDS: z.coerce.number().positive().default(20),
  HIGHLIGHT_MAX_DURATION_SECONDS: z.coerce.number().positive().default(60),
  HIGHLIGHT_MAX_CANDIDATES: z.coerce.number().int().positive().default(5),
  HIGHLIGHT_OVERLAP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  HIGHLIGHT_WEIGHT_DENSITY: z.coerce.number().min(0).default(0.25),
  HIGHLIGHT_WEIGHT_EMPHASIS: z.coerce.number().min(0).default(0.2),
  HIGHLIGHT_WEIGHT_QUESTION: z.coerce.number().min(0).default(0.1),
  HIGHLIGHT_WEIGHT_NUMBER: z.coerce.number().min(0).default(0.1),
  HIGHLIGHT_WEIGHT_CONTRAST: z.coerce.number().min(0).default(0.15),
  HIGHLIGHT_WEIGHT_HOOK: z.coerce.number().min(0).default(0.1),
  HIGHLIGHT_WEIGHT_COMPLETENESS: z.coerce.number().min(0).default(0.1),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  COBALT_API_URL: z.string().url().optional(),
  COBALT_API_KEY: z.string().optional(),
  YOUTUBE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(1_200_000)
});

export type AppConfig = ReturnType<typeof loadConfig>;
export function loadConfig(env = process.env) {
  const value = schema.parse(env);
  if (value.HIGHLIGHT_MIN_DURATION_SECONDS > value.HIGHLIGHT_MAX_DURATION_SECONDS) throw new Error('HIGHLIGHT_MIN_DURATION_SECONDS must not exceed HIGHLIGHT_MAX_DURATION_SECONDS.');
  if (value.CLIP_VERTICAL_WIDTH / value.CLIP_VERTICAL_HEIGHT !== 9 / 16) throw new Error('CLIP_VERTICAL_WIDTH and CLIP_VERTICAL_HEIGHT must preserve a 9:16 aspect ratio.');
  if (value.JOB_HEARTBEAT_SECONDS * 2 > value.JOB_STALE_AFTER_SECONDS) throw new Error('JOB_HEARTBEAT_SECONDS must be at most half of JOB_STALE_AFTER_SECONDS, otherwise a healthy job could be mistaken for an abandoned one.');
  return { ...value, UPLOAD_DIR: resolve(value.UPLOAD_DIR), TEMP_DIR: resolve(value.TEMP_DIR), OUTPUT_DIR: resolve(value.OUTPUT_DIR), WHISPER_MODEL_PATH: resolve(value.WHISPER_MODEL_PATH), WHISPER_CPP_PATH: resolve(value.WHISPER_CPP_PATH) };
}
