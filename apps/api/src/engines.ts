import type { AppConfig } from './config.js';
import { OpenAiCompatibleTranscriber } from './hosted-transcription.js';
import { WhisperCppTranscriber, type TranscriptionEngine } from './transcription.js';

/** The speech recognition the configuration asks for: whisper.cpp on this machine (the default), or a hosted service. */
export function createTranscriptionEngine(config: Pick<AppConfig, 'TRANSCRIPTION_ENGINE' | 'WHISPER_CPP_PATH' | 'WHISPER_MODEL_PATH' | 'TRANSCRIPTION_LANGUAGE' | 'TRANSCRIPTION_TIMEOUT_MS' | 'TRANSCRIPTION_API_URL' | 'TRANSCRIPTION_API_KEY' | 'TRANSCRIPTION_API_MODEL' | 'TRANSCRIPTION_API_TIMEOUT_MS' | 'TRANSCRIPTION_CHUNK_SECONDS' | 'TRANSCRIPTION_API_CONCURRENCY' | 'FFMPEG_PATH' | 'FFPROBE_PATH'>): TranscriptionEngine {
  switch (config.TRANSCRIPTION_ENGINE) {
    case 'whisper_cpp': return new WhisperCppTranscriber(config.WHISPER_CPP_PATH, config.WHISPER_MODEL_PATH, config.TRANSCRIPTION_LANGUAGE, config.TRANSCRIPTION_TIMEOUT_MS);
    case 'openai_compatible': {
      if (!config.TRANSCRIPTION_API_URL || !config.TRANSCRIPTION_API_KEY) throw new Error('TRANSCRIPTION_ENGINE=openai_compatible needs TRANSCRIPTION_API_URL and TRANSCRIPTION_API_KEY.');
      return new OpenAiCompatibleTranscriber({ apiUrl: config.TRANSCRIPTION_API_URL, apiKey: config.TRANSCRIPTION_API_KEY, model: config.TRANSCRIPTION_API_MODEL, language: config.TRANSCRIPTION_LANGUAGE, timeoutMs: config.TRANSCRIPTION_API_TIMEOUT_MS, chunkSeconds: config.TRANSCRIPTION_CHUNK_SECONDS, concurrency: config.TRANSCRIPTION_API_CONCURRENCY, ffmpegPath: config.FFMPEG_PATH, ffprobePath: config.FFPROBE_PATH });
    }
  }
}
