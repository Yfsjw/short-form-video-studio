import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { alignWords, OpenAiCompatibleTranscriber, parseVerboseTranscription, retryAfterMs, type HostedTranscriptionSettings } from './hosted-transcription.js';
import { sleep } from './test-support.js';

const run = promisify(execFile);
const KEY = 'test-key-0123456789abcdef';

// ---- the answer of a service, and how it is read -------------------------------------------------------------------------------

const word = (text: string, startSeconds: number, endSeconds: number) => ({ text, startSeconds, endSeconds });
const spoken = (text: string, start: number, end: number) => ({ word: text, start, end });

test('the words of a segment take their spelling and punctuation from the segment text and their times from the word list', () => {
  const [segment] = parseVerboseTranscription({
    segments: [{ start: 0, end: 2.5, text: ' Hello there, friend. It\'s 42%!', avg_logprob: -0.2, no_speech_prob: 0.01 }],
    words: [spoken('Hello', 0.1, 0.5), spoken('there', 0.6, 1.0), spoken('friend', 1.1, 1.5), spoken('It\'s', 1.6, 1.8), spoken('42', 1.9, 2.2)],
  });
  assert.equal(segment.text, 'Hello there, friend. It\'s 42%!');
  assert.deepEqual(segment.words?.map((entry) => entry.text), ['Hello', 'there,', 'friend.', 'It\'s', '42%!']);
  assert.deepEqual(segment.words?.slice(0, 3).map((entry) => [entry.startSeconds, entry.endSeconds]), [[0.1, 0.5], [0.6, 1.0], [1.1, 1.5]]);
});

test('a word the service split in two, and a dash on its own, are matched with the text', () => {
  const tokens = alignWords('I don\'t know - really.', [word('I', 0, 0.2), word('don', 0.3, 0.5), word('\'t', 0.5, 0.6), word('know', 0.7, 1), word('really', 1.2, 1.6)]);
  assert.deepEqual(tokens.map((token) => token.text), [' I', ' don\'t', ' know-', ' really.']);
  assert.deepEqual(tokens.map((token) => [token.startSeconds, token.endSeconds]), [[0, 0.2], [0.3, 0.6], [0.7, 1], [1.2, 1.6]]);
});

test('when the words cannot be matched with the text they are used as the service gave them, so timing is never lost', () => {
  const given = alignWords('This text has more words than the list', [word('This', 0, 0.3), word('text', 0.4, 0.7)]);
  assert.deepEqual(given.map((token) => token.text), [' This', ' text']);
  const extra = alignWords('Short text', [word('Short', 0, 0.3), word('text', 0.4, 0.7), word('surprise', 0.8, 1)]);
  assert.equal(extra.length, 3, 'a word the text does not have');
  assert.equal(alignWords('Δύο λέξεις', [word('Δύο', 0, 0.4), word('λέξεις', 0.5, 1)]).length, 2, 'letters of any script count');
});

test('times are put on the clock of the whole recording, and nothing that is not speech is kept', () => {
  const result = parseVerboseTranscription({
    segments: [
      { start: 0, end: 3, text: 'Thank you.', avg_logprob: -1.6, no_speech_prob: 0.93 }, // what a model writes over silence
      { start: 3, end: 6, text: ' Real words here.', avg_logprob: -0.3, no_speech_prob: 0.02 },
      { start: 6, end: 6, text: 'Takes no time' },
      { start: 7, end: 9, text: '   ' },
      { start: 9, end: 11, text: 'Quiet but certain.', avg_logprob: -0.4, no_speech_prob: 0.8 }, // only one of the two signs: kept
    ],
    words: [spoken('Real', 3.1, 3.5), spoken('words', 3.6, 4.2), spoken('here', 4.3, 5)],
  }, 600);
  assert.deepEqual(result.map((segment) => [segment.segmentIndex, segment.startSeconds, segment.endSeconds, segment.text]), [[0, 603, 606, 'Real words here.'], [1, 609, 611, 'Quiet but certain.']]);
  assert.deepEqual(result[0].words?.map((entry) => [entry.text, entry.startSeconds]), [['Real', 603.1], ['words', 603.6], ['here.', 604.3]]);
  assert.ok(!('words' in result[1]), 'a segment the service gave no words for has none, and the captions spread its text');
});

test('an answer without timed segments is an error that says what is wrong; one with nothing in it is an empty transcript', () => {
  assert.throws(() => parseVerboseTranscription({ text: 'just text' }), /verbose_json/);
  assert.throws(() => parseVerboseTranscription(null), /verbose_json/);
  assert.deepEqual(parseVerboseTranscription({ segments: [], words: [] }), []);
});

// ---- a service to talk to --------------------------------------------------------------------------------------------------------

interface Call { number: number; authorization: string | undefined; form: FormData; filename: string; }
type Reply = { status?: number; headers?: Record<string, string>; body?: unknown; text?: string; delayMs?: number };

/** A small stand-in for the service: it reads the real multipart request and answers as the test says. */
async function fakeService(handler: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []; let inFlight = 0; let peak = 0;
  const server = http.createServer(async (req, res) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    try {
      const form = await new Request('http://service.test/x', { method: 'POST', headers: { 'content-type': String(req.headers['content-type']) }, body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } as RequestInit).formData();
      const file = form.get('file');
      const call: Call = { number: calls.length + 1, authorization: req.headers.authorization, form, filename: file instanceof File ? file.name : '' };
      calls.push(call);
      const reply = await handler(call);
      if (reply.delayMs) await sleep(reply.delayMs);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.text ?? JSON.stringify(reply.body ?? {}));
    } catch (error) { res.writeHead(500); res.end(String(error)); } finally { inFlight -= 1; }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls, peak: () => peak, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function withAudio<T>(spec: string, work: (dir: string, wav: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-hosted-'));
  try {
    const wav = join(dir, 'audio.wav');
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', spec, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    return await work(dir, wav);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const SHORT = 'aevalsrc=0.5*sin(2*PI*440*t):s=16000:d=6';
/** 18 s with a pause in the first second of every 6: cut into pieces of about 8 s it gives three pieces, ending at 6.5 s and 12.5 s. */
const PAUSED = 'aevalsrc=0.5*sin(2*PI*440*t)*gt(mod(t\\,6)\\,1):s=16000:d=18';

const settingsFor = (url: string, overrides: Partial<HostedTranscriptionSettings> = {}): HostedTranscriptionSettings => ({ apiUrl: url, apiKey: KEY, model: 'whisper-1', language: 'en', timeoutMs: 20_000, chunkSeconds: 600, concurrency: 3, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', ...overrides });
const quick = { retryDelayMs: 1 };

test('one request carries the audio, the key and the options; the answer becomes a transcript with word timing', async () => {
  const service = await fakeService(() => ({ body: { segments: [{ start: 0.2, end: 2, text: ' Hello there, friend.', avg_logprob: -0.2, no_speech_prob: 0.01 }], words: [spoken('Hello', 0.3, 0.7), spoken('there', 0.8, 1.2), spoken('friend', 1.3, 1.9)] } }));
  try {
    await withAudio(SHORT, async (dir, wav) => {
      const progress: number[] = [];
      const transcript = await new OpenAiCompatibleTranscriber(settingsFor(service.url), quick).transcribe(wav, dir, (fraction) => progress.push(fraction));
      assert.deepEqual(transcript.map((segment) => [segment.segmentIndex, segment.startSeconds, segment.endSeconds, segment.text]), [[0, 0.2, 2, 'Hello there, friend.']]);
      assert.deepEqual(transcript[0].words?.map((entry) => entry.text), ['Hello', 'there,', 'friend.']);
      assert.deepEqual(progress, [1]);

      assert.equal(service.calls.length, 1);
      const [call] = service.calls;
      assert.equal(call.authorization, `Bearer ${KEY}`);
      assert.equal(call.form.get('model'), 'whisper-1');
      assert.equal(call.form.get('response_format'), 'verbose_json');
      assert.deepEqual(call.form.getAll('timestamp_granularities[]'), ['word', 'segment']);
      assert.equal(call.form.get('language'), 'en');
      assert.equal(call.filename, 'speech-0.m4a');
      const file = call.form.get('file') as File;
      assert.ok(file.size > 1000 && file.size < 60_000, `a 6 s piece of compressed speech (about 36 kB at 48 kbit/s), not the 192 kB WAV (${file.size} bytes)`);
      assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('speech-')), [], 'the piece sent is not left behind');
    });
  } finally { await service.close(); }
});

test('"auto" leaves the language to the service; another model and a full address are used as given', async () => {
  const service = await fakeService(() => ({ body: { segments: [] } }));
  try {
    await withAudio(SHORT, async (dir, wav) => {
      const transcript = await new OpenAiCompatibleTranscriber(settingsFor(`${service.url}/audio/transcriptions`, { language: 'auto', model: 'whisper-large-v3-turbo' }), quick).transcribe(wav, dir);
      assert.deepEqual(transcript, [], 'a recording with no speech is an empty transcript, and the pipeline says so');
      assert.equal(service.calls[0].form.has('language'), false);
      assert.equal(service.calls[0].form.get('model'), 'whisper-large-v3-turbo');
    });
  } finally { await service.close(); }
});

test('a long recording is sent in pieces cut at pauses, a few at a time, and the answers are joined in order on the clock of the whole', async () => {
  const service = await fakeService((call) => {
    const index = Number(/speech-(\d+)/.exec(call.filename)?.[1]);
    return { delayMs: index === 0 ? 250 : 20, body: { segments: [{ start: 1.5, end: 3, text: `Piece ${index} speaks here.`, avg_logprob: -0.2, no_speech_prob: 0.01 }], words: [spoken('Piece', 1.5, 1.9), spoken(String(index), 2, 2.2), spoken('speaks', 2.3, 2.6), spoken('here', 2.7, 3)] } };
  });
  try {
    await withAudio(PAUSED, async (dir, wav) => {
      const progress: number[] = [];
      const transcript = await new OpenAiCompatibleTranscriber(settingsFor(service.url, { chunkSeconds: 8, concurrency: 2 }), quick).transcribe(wav, dir, (fraction) => progress.push(fraction));
      assert.equal(service.calls.length, 3);
      assert.deepEqual(transcript.map((segment) => [segment.segmentIndex, segment.text]), [[0, 'Piece 0 speaks here.'], [1, 'Piece 1 speaks here.'], [2, 'Piece 2 speaks here.']], 'in the order of the recording even though piece 0 was answered last');
      const starts = transcript.map((segment) => segment.startSeconds);
      assert.ok(Math.abs(starts[0] - 1.5) < 0.01 && Math.abs(starts[1] - (6.5 + 1.5)) < 0.15 && Math.abs(starts[2] - (12.5 + 1.5)) < 0.15, `times of the whole recording: ${starts.join(', ')}`);
      assert.ok(Math.abs((transcript[1].words?.[0].startSeconds ?? 0) - starts[1]) < 0.01, 'the words are moved with their segment');
      assert.deepEqual(progress.map((fraction) => Math.round(fraction * 100)), [33, 67, 100], 'progress counts the pieces done');
      assert.equal(service.peak(), 2, 'no more requests at once than allowed, and the allowance is used');
      assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('speech-')), []);
    });
  } finally { await service.close(); }
});

test('a busy service is waited for and asked again; the pause follows what it asks for, or doubles each time', async () => {
  const service = await fakeService((call) => (call.number === 1 ? { status: 429, headers: { 'retry-after': '2' }, text: 'slow down' } : call.number === 2 ? { status: 503, text: 'overloaded' } : { body: { segments: [{ start: 0, end: 1, text: 'It worked.' }] } }));
  try {
    await withAudio(SHORT, async (dir, wav) => {
      const pauses: number[] = [];
      const transcript = await new OpenAiCompatibleTranscriber(settingsFor(service.url), { retryDelayMs: 10, sleep: async (ms) => { pauses.push(ms); } }).transcribe(wav, dir);
      assert.equal(transcript[0].text, 'It worked.');
      assert.equal(service.calls.length, 3);
      assert.deepEqual(pauses, [2000, 20], 'the first pause is the one the service asked for, the second doubles the base');
    });
  } finally { await service.close(); }
});

test('what a service asks for in Retry-After is understood as seconds or as a date, never more than 30 s, and no header means no request', () => {
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs(''), undefined);
  assert.equal(retryAfterMs('0'), 0);
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('600'), 30_000);
  assert.equal(retryAfterMs('-5'), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
  const inFiveSeconds = retryAfterMs(new Date(Date.now() + 5000).toUTCString()) ?? -1;
  assert.ok(inFiveSeconds > 3000 && inFiveSeconds <= 5000, `a date 5 s ahead gave ${inFiveSeconds} ms`);
  assert.equal(retryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0, 'a date in the past means now');
});

test('a service that stays unavailable ends the job with a plain message after the attempts allowed', async () => {
  const service = await fakeService(() => ({ status: 503, text: 'upstream connect error' }));
  try {
    await withAudio(SHORT, async (dir, wav) => {
      await assert.rejects(new OpenAiCompatibleTranscriber(settingsFor(service.url), { ...quick, maxAttempts: 3 }).transcribe(wav, dir), /not available right now \(HTTP 503\)/);
      assert.equal(service.calls.length, 3);
    });
  } finally { await service.close(); }
});

test('a rejected key is reported at once, without trying again, and without the key or anything that echoes it', async () => {
  const echo = `Incorrect API key provided: ${KEY}. Masked copy: sk-test***cdef; gsk_abcd1234.`;
  const service = await fakeService(() => ({ status: 401, body: { error: { message: echo } } }));
  try {
    await withAudio(SHORT, async (dir, wav) => {
      const error = await new OpenAiCompatibleTranscriber(settingsFor(service.url), quick).transcribe(wav, dir).then(() => null, (reason: Error) => reason);
      assert.match(error?.message ?? '', /did not accept the credentials \(HTTP 401\)/);
      assert.doesNotMatch(error?.message ?? '', new RegExp(`${KEY}|sk-test|gsk_abcd|cdef`));
      assert.equal(service.calls.length, 1);
    });
  } finally { await service.close(); }

  const refusing = await fakeService(() => ({ status: 400, body: { error: { message: `The file is not valid audio. Key ${KEY} sk-live-ABCDEF12345` } } }));
  try {
    await withAudio(SHORT, async (dir, wav) => {
      const error = await new OpenAiCompatibleTranscriber(settingsFor(refusing.url), quick).transcribe(wav, dir).then(() => null, (reason: Error) => reason);
      assert.match(error?.message ?? '', /refused the audio \(HTTP 400\).*not valid audio/);
      assert.doesNotMatch(error?.message ?? '', new RegExp(`${KEY}|sk-live`), 'what the service says is shown, but never the key');
    });
  } finally { await refusing.close(); }
});

test('an answer that is not what was asked for, and a service that cannot be reached, are reported plainly', async () => {
  const service = await fakeService(() => ({ body: { text: 'no segments here' } }));
  try {
    await withAudio(SHORT, async (dir, wav) => {
      await assert.rejects(new OpenAiCompatibleTranscriber(settingsFor(service.url), quick).transcribe(wav, dir), /verbose_json/);
      const broken = await fakeService(() => ({ text: 'not json at all' }));
      try { await assert.rejects(new OpenAiCompatibleTranscriber(settingsFor(broken.url), quick).transcribe(wav, dir), /could not be read/); } finally { await broken.close(); }
    });
  } finally { await service.close(); }

  await withAudio(SHORT, async (dir, wav) => {
    const unreachable = new OpenAiCompatibleTranscriber(settingsFor('http://127.0.0.1:9/v1'), { ...quick, maxAttempts: 2 });
    await assert.rejects(unreachable.transcribe(wav, dir), (error: Error) => /Could not reach the speech recognition service/.test(error.message) && !error.message.includes(KEY));
  });
});

test('when one piece fails the others are stopped, the job fails with that reason, and nothing is left on the disk', async () => {
  const service = await fakeService((call) => (/speech-1/.test(call.filename) ? { status: 400, text: 'bad audio' } : { delayMs: 2000, body: { segments: [{ start: 0, end: 1, text: 'Fine.' }] } }));
  try {
    await withAudio(PAUSED, async (dir, wav) => {
      const started = Date.now();
      await assert.rejects(new OpenAiCompatibleTranscriber(settingsFor(service.url, { chunkSeconds: 8, concurrency: 3 }), quick).transcribe(wav, dir), /refused the audio \(HTTP 400\)/);
      assert.ok(Date.now() - started < 1500, 'it did not wait for the slow pieces (they take 2 s to answer)');
      assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('speech-')), []);
    });
  } finally { await service.close(); }
});
