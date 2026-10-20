import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';
import { createTranscriptionEngine } from './engines.js';
import { OpenAiCompatibleTranscriber } from './hosted-transcription.js';
import { WhisperCppTranscriber } from './transcription.js';

test('the configuration chooses the speech recognition: whisper.cpp by default, a hosted service when asked', () => {
  assert.ok(createTranscriptionEngine(loadConfig({})) instanceof WhisperCppTranscriber);
  const hosted = createTranscriptionEngine(loadConfig({ TRANSCRIPTION_ENGINE: 'openai_compatible', TRANSCRIPTION_API_URL: 'https://speech.example/v1', TRANSCRIPTION_API_KEY: 'not-a-real-key-for-this-test' }));
  assert.ok(hosted instanceof OpenAiCompatibleTranscriber);
});

test('a hosted engine cannot be created without its address and key, and the complaint does not repeat the key', () => {
  const key = 'not-a-real-key-for-this-test';
  const config = { ...loadConfig({}), TRANSCRIPTION_ENGINE: 'openai_compatible' as const, TRANSCRIPTION_API_KEY: key };
  assert.throws(() => createTranscriptionEngine(config), (error: Error) => /TRANSCRIPTION_API_URL/.test(error.message) && !error.message.includes(key));
});
