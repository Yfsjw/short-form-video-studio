import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('WHISPER_THREADS reaches whisper.cpp when the engine is made from the configuration, and 0 leaves the choice to whisper.cpp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-engine-'));
  try {
    const program = join(root, 'whisper-cli');
    await writeFile(program, '#!/bin/sh\nbase=""\nallargs=$(printf \'%s\\n\' "$@")\nwhile [ $# -gt 0 ]; do case "$1" in -of) base="$2"; shift;; esac; shift; done\nprintf \'%s\\n\' "$allargs" > "$base.args"\nprintf \'%s\' \'{"transcription":[{"offsets":{"from":0,"to":1000},"text":" Hi."}]}\' > "$base.json"\n');
    await chmod(program, 0o755);
    const audio = join(root, 'audio.wav'); await writeFile(audio, 'wav');
    const argumentsOf = async (threads: string) => {
      await createTranscriptionEngine(loadConfig({ WHISPER_CPP_PATH: program, WHISPER_MODEL_PATH: join(root, 'model.bin'), WHISPER_THREADS: threads })).transcribe(audio, root);
      return (await readFile(join(root, 'audio.args'), 'utf8')).split('\n').filter(Boolean);
    };
    const withThreads = await argumentsOf('3');
    assert.deepEqual(withThreads.slice(withThreads.indexOf('-t'), withThreads.indexOf('-t') + 2), ['-t', '3']);
    assert.ok(!(await argumentsOf('0')).includes('-t'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
