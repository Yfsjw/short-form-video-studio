import { resolve } from 'node:path';
import { z } from 'zod';

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
  CORS_ORIGIN: z.string().url().default('http://localhost:5173')
});

export type AppConfig = ReturnType<typeof loadConfig>;
export function loadConfig(env = process.env) {
  const value = schema.parse(env);
  if (value.HIGHLIGHT_MIN_DURATION_SECONDS > value.HIGHLIGHT_MAX_DURATION_SECONDS) throw new Error('HIGHLIGHT_MIN_DURATION_SECONDS must not exceed HIGHLIGHT_MAX_DURATION_SECONDS.');
  if (value.CLIP_VERTICAL_WIDTH / value.CLIP_VERTICAL_HEIGHT !== 9 / 16) throw new Error('CLIP_VERTICAL_WIDTH and CLIP_VERTICAL_HEIGHT must preserve a 9:16 aspect ratio.');
  return { ...value, UPLOAD_DIR: resolve(value.UPLOAD_DIR), TEMP_DIR: resolve(value.TEMP_DIR), OUTPUT_DIR: resolve(value.OUTPUT_DIR), WHISPER_MODEL_PATH: resolve(value.WHISPER_MODEL_PATH), WHISPER_CPP_PATH: resolve(value.WHISPER_CPP_PATH) };
}
