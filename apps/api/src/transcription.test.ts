import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioDatabase } from './database.js';
import type { NewVideoJob } from './domain.js';
import { VideoPipeline } from './pipeline.js';
import { NullStorage } from './storage.js';
import { createProgressListener, parseWhisperCppJson, WhisperCppTranscriber, type TranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector } from './highlights.js';
import type { ClipRenderer } from './clips.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';

test('parses timestamped whisper.cpp JSON output', () => {
  const segments = parseWhisperCppJson(JSON.stringify({ transcription: [{ offsets: { from: 1250, to: 3750 }, text: ' A real timestamped segment. ' }] }));
  assert.deepEqual(segments, [{ segmentIndex: 0, startSeconds: 1.25, endSeconds: 3.75, text: 'A real timestamped segment.' }]);
});

test('stores and returns transcript segments in segment order', async () => {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, `test_transcript_${randomUUID().replaceAll('-', '_')}`);
  try {
    const now = new Date().toISOString(); const job: NewVideoJob = { id: 'job-1', originalFilename: 'source.mp4', storedFilename: 'source.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'processing', stage: 'transcribing', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
    await db.createJob(job); await db.replaceTranscript(job.id, [{ segmentIndex: 1, startSeconds: 2, endSeconds: 3, text: 'second' }, { segmentIndex: 0, startSeconds: 0, endSeconds: 1, text: 'first' }]);
    assert.deepEqual((await db.listTranscript(job.id)).map(({ segmentIndex, startSeconds, endSeconds, text }) => ({ segmentIndex, startSeconds, endSeconds, text })), [{ segmentIndex: 0, startSeconds: 0, endSeconds: 1, text: 'first' }, { segmentIndex: 1, startSeconds: 2, endSeconds: 3, text: 'second' }]);
  } finally { await db.close({ dropSchema: true }); }
});

test('pipeline integration persists mock-engine segments and cleans temporary audio', async () => {
  // This is intentionally a mocked adapter integration test, not an actual Whisper execution test.
  const root = await mkdtemp(join(tmpdir(), 'studio-pipeline-'));
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, `test_pipeline_${randomUUID().replaceAll('-', '_')}`);
  try {
    const now = new Date().toISOString(); const job: NewVideoJob = { id: 'job-2', originalFilename: 'source.mp4', storedFilename: 'source.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'queued', stage: 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now }; await db.createJob(job);
    await writeFile(join(root, job.storedFilename), 'x'); // the pipeline now checks that the uploaded file really is on disk
    const fakeMedia = { probe: async () => ({ durationSeconds: 6, width: 1920, height: 1080 }), extractAudio: async (_input: string, output: string) => { await writeFile(output, 'mock wav'); } };
    const mockTranscriber: TranscriptionEngine = { transcribe: async () => [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Adapter-provided transcript.' }] };
    const mockRenderer: ClipRenderer = { render: async () => ({ durationSeconds: 2, sizeBytes: 1 }) };
    const logger = { info: () => undefined, error: () => undefined };
    await new VideoPipeline(db, fakeMedia, mockTranscriber, new DeterministicHighlightDetector(), { minDurationSeconds: 1, maxDurationSeconds: 10, maxCandidates: 3, overlapThreshold: 0.65, weights: { density: 1 } }, mockRenderer, 1, root, root, root, logger, new NullStorage()).run(job.id);
    assert.equal((await db.getJob(job.id))?.status, 'completed'); assert.equal((await db.listTranscript(job.id))[0]?.text, 'Adapter-provided transcript.');
    assert.equal((await db.listClips(job.id))[0]?.candidateId.length, 36);
    assert.ok(!(await readdir(root)).some((entry) => entry.startsWith('job-2-')));
  } finally { await db.close({ dropSchema: true }); await rm(root, { recursive: true, force: true }); }
});

/** A stand-in for whisper-cli: a small script that behaves like it (reads -of, prints progress on stderr, writes the JSON file), so the real process handling is what gets tested. */
async function fakeWhisper(root: string, body: string) {
  const path = join(root, 'fake-whisper.sh');
  await writeFile(path, `#!/bin/sh\nbase=""\nallargs=$(printf '%s\\n' "$@")\nwhile [ $# -gt 0 ]; do case "$1" in -of) base="$2"; shift;; esac; shift; done\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}
const audioIn = async (root: string) => { const audio = join(root, 'audio.wav'); await writeFile(audio, 'wav'); return audio; };
const HELLO_JSON = `printf '%s' '{"transcription":[{"offsets":{"from":0,"to":2000},"text":" Hello there."}]}' > "$base.json"`;

test('follows whisper.cpp progress lines even when they arrive in pieces, and never reports going backwards', () => {
  const seen: number[] = [];
  const listen = createProgressListener((fraction) => seen.push(fraction));
  listen('whisper_print_progress_callback: progress =   5%\nwhisper_print_progress_callback: progr');
  listen('ess =  10%\nsome other line\nwhisper_print_progress_callback: progress =  10%\n');
  listen('whisper_print_progress_callback: progress = 100%\nwhisper_print_progress_callback: progress =  50%\n');
  assert.deepEqual(seen, [0.05, 0.1, 1]);
  assert.doesNotThrow(() => createProgressListener(undefined)('progress = 5%\n'));
});

test('runs the speech recognition program with the expected options and reports its progress while it works', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-whisper-'));
  try {
    const program = await fakeWhisper(root, `printf '%s\\n' "$allargs" > "$base.args"
echo "whisper_print_progress_callback: progress =   5%" >&2
sleep 0.05
echo "whisper_print_progress_callback: progress =  50%" >&2
sleep 0.05
echo "whisper_print_progress_callback: progress = 100%" >&2
${HELLO_JSON}`);
    const audio = await audioIn(root); const seen: number[] = [];
    const segments = await new WhisperCppTranscriber(program, '/models/base.bin', 'en', 30_000).transcribe(audio, root, (fraction) => seen.push(fraction));
    assert.deepEqual(segments, [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Hello there.' }]);
    assert.deepEqual(seen, [0.05, 0.5, 1]);
    const args = (await readFile(join(root, 'audio.args'), 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual(args, ['-m', '/models/base.bin', '-f', audio, '-l', 'en', '-ng', '-nfa', '-pp', '-oj', '-of', join(root, 'audio')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a speech recognition program that fails says why, and one that prints a great deal is not killed for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-whisper-'));
  try {
    const audio = await audioIn(root);
    const failing = await fakeWhisper(root, 'echo "error: failed to load model" >&2\nexit 3');
    await assert.rejects(new WhisperCppTranscriber(failing, 'm', 'en', 30_000).transcribe(audio, root), (error: Error) => /Local whisper\.cpp transcription failed/.test(error.message) && /exit code 3/.test(error.message) && /failed to load model/.test(error.message));

    const chatty = await fakeWhisper(root, `head -c 3000000 /dev/zero | tr '\\0' 'a'\n${HELLO_JSON}`);
    const segments = await new WhisperCppTranscriber(chatty, 'm', 'en', 30_000).transcribe(audio, root);
    assert.equal(segments[0].text, 'Hello there.', 'three megabytes on stdout used to exceed the buffer and kill the program');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a speech recognition program that runs past the time limit is stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-whisper-'));
  try {
    const audio = await audioIn(root);
    const slow = await fakeWhisper(root, 'exec sleep 30');
    const started = Date.now();
    await assert.rejects(new WhisperCppTranscriber(slow, 'm', 'en', 300).transcribe(audio, root), /time limit/);
    assert.ok(Date.now() - started < 5000, 'it must not wait for the program to finish by itself');
  } finally { await rm(root, { recursive: true, force: true }); }
});
