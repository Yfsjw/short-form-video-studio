import assert from 'node:assert/strict';
import test from 'node:test';
import { PlainFailure, describeTimeLimit, failureMessage, onlyVideos, plainWords } from './failures.js';

/** What nobody who uploads a video should have to read: the insides of the server. */
const technical = /\/(opt|tmp|usr|var|home|srv)\b|\.(mp4|wav|json|bin)\b|ffmpeg|ffprobe|whisper|cobalt|postgres|r2\b|s3\b|exit code|signal|stderr|stdout|ENOENT|ECONN|Error:|\bat \w+\.\w+/i;

test('a failure that was written to be read is told as it is, whatever stage the job was in, and keeps what it was made from', () => {
  const cause = new Error('/srv/uploads/x.mp4: moov atom not found');
  const failure = new PlainFailure('This file could not be read.', { cause });
  for (const stage of [undefined, 'probing_video', 'transcribing', 'extracting_clips', 'some_stage_of_a_newer_release']) assert.equal(failureMessage(failure, stage), 'This file could not be read.', String(stage));
  assert.equal(failure.cause, cause, 'the real reason stays with it, for the log');
  assert.equal(failure.name, 'PlainFailure');
  assert.ok(failure instanceof Error);
});

test('a failure that was not written to be read is told in general words that fit the stage, never in its own', () => {
  const inside = new Error('spawn /opt/render/project/src/.render/whisper-cli ENOENT');
  const expected: Record<string, string> = {
    preparing_source: 'The video could not be received properly by the server. Please upload it again.',
    saving_source: 'The video could not be received properly by the server. Please upload it again.',
    restoring_source: 'The video could not be received properly by the server. Please upload it again.',
    waiting_to_retry: 'The video could not be received properly by the server. Please upload it again.',
    transcribing: 'The speech in this video could not be turned into text. Please try again, or try another video.',
    reusing_transcript: 'The speech in this video could not be turned into text. Please try again, or try another video.',
    detecting_highlights: 'No clips could be chosen from this video. Please try again, or try another video.',
    extracting_clips: 'This video could not be turned into clips. Please try again, or try another video.',
    // looking at the video and taking its sound out tell what is wrong with the file themselves; what is left is the server's
    probing_video: 'This video could not be processed because of a problem on the server. Please try again in a few minutes.',
    extracting_audio: 'This video could not be processed because of a problem on the server. Please try again in a few minutes.',
  };
  for (const [stage, words] of Object.entries(expected)) {
    assert.equal(failureMessage(inside, stage), words, stage);
    assert.doesNotMatch(words, technical, `the words for ${stage} say nothing about the inside of the server`);
  }
  const general = 'This video could not be processed because of a problem on the server. Please try again in a few minutes.';
  assert.equal(failureMessage(inside), general, 'no stage known');
  assert.equal(failureMessage(inside, 'some_stage_of_a_newer_release'), general, 'a stage with no words of its own');
  assert.equal(failureMessage('a string was thrown', 'transcribing'), expected.transcribing, 'whatever was thrown');
  assert.equal(failureMessage(undefined, 'extracting_clips'), expected.extracting_clips);
  assert.equal(failureMessage(null), general);
  assert.equal(failureMessage({ message: 'looks like an error but is not one' }, 'transcribing'), expected.transcribing, 'only a PlainFailure speaks for itself, however much something looks like one');
});

test('an answer to a request has a status and a code, which are those of a bad request unless said otherwise', () => {
  const plain = new PlainFailure('Not a video.');
  assert.deepEqual({ status: plain.status, code: plain.code }, { status: 400, code: 'INVALID_REQUEST' });
  const other = new PlainFailure('Could not download.', { status: 502, code: 'DOWNLOAD_FAILED' });
  assert.deepEqual({ status: other.status, code: other.code }, { status: 502, code: 'DOWNLOAD_FAILED' });
});

test('every sentence a person can be told is plain: it says what is wrong and what to do, and nothing about the inside of the server', () => {
  for (const [name, words] of Object.entries({ ...plainWords, onlyVideos })) {
    assert.doesNotMatch(words, technical, name);
    assert.match(words, /[.!]$/, `${name} is a sentence`);
    assert.ok(words.length >= 20 && words.length <= 200, `${name} is short enough to read at a glance (${words.length} characters)`);
  }
  assert.match(plainWords.noSound, /no sound/);
  assert.match(plainWords.unreadableVideo, /could not be read as a video/);
  assert.match(plainWords.unreadableSound, /sound .* could not be read/);
  assert.match(onlyVideos, /^Only MP4, MOV, MKV, WebM, AVI, and M4V video files are accepted\.$/);
});

test('a time limit is told in the words of a person', () => {
  const cases: Array<[number, string]> = [[0, '1 second'], [300, '1 second'], [1_000, '1 second'], [1_499, '1 second'], [1_500, '2 seconds'], [90_000, '90 seconds'], [119_000, '119 seconds'], [119_499, '119 seconds'], [120_000, '2 minutes'], [149_000, '2 minutes'], [151_000, '3 minutes'], [600_000, '10 minutes'], [3_600_000, '60 minutes'], [5_400_000, '90 minutes']];
  for (const [milliseconds, words] of cases) assert.equal(describeTimeLimit(milliseconds), words, `${milliseconds} ms`);
});
