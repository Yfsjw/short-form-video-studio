import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeneratedClip, VideoJob } from './domain.js';
import { defaultJobOptions } from './domain.js';
import { deletedOn, keptFor, renderDeleteConfirmPage, renderDeletedPage, renderJobPage, renderStopConfirmPage, renderUploadPage } from './pages.js';
import { plainWords } from './failures.js';

const job = (overrides: Partial<VideoJob> = {}): VideoJob => ({
  id: 'job-1', originalFilename: 'talk.mp4', storedFilename: 'talk.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'completed', stage: 'completed', errorMessage: null,
  durationSeconds: 120, width: 1920, height: 1080, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:05:00.000Z', sourceStorageKey: null, attempts: 1,
  options: defaultJobOptions, stageTimings: {}, progress: 100, ...overrides,
});
const clip = (overrides: Partial<GeneratedClip> = {}): GeneratedClip => ({
  id: 'clip-1', jobId: 'job-1', candidateId: 'cand-1', startSeconds: 10, endSeconds: 55, durationSeconds: 45, outputPath: 'o.mp4', outputFilename: 'o.mp4', status: 'completed', errorMessage: null,
  captionPath: null, createdAt: '2026-10-01T10:04:00.000Z', updatedAt: '2026-10-01T10:04:30.000Z', title: null, score: null, reasons: [], framing: null, ...overrides,
});

test('a finished clip shows its title, the score and the rules that picked it, and says they are rules and not an AI model', () => {
  const html = renderJobPage(job(), [clip({ title: 'Why do most channels stop growing?', score: 62.4, reasons: ['question phrasing', 'a length that suits short video'] })]);
  assert.match(html, /<h2>Why do most channels stop growing\?<\/h2>/);
  assert.match(html, /Clip 1 · 45 s/);
  assert.match(html, /Why this moment · score 62 \/ 100/);
  assert.match(html, /<li>question phrasing<\/li><li>a length that suits short video<\/li>/);
  assert.match(html, /not by an AI model/);
});

test('a clip made before titles and reasons existed shows neither a made-up title nor an empty explanation', () => {
  const html = renderJobPage(job(), [clip()]);
  assert.match(html, /<h2>Clip 1<\/h2>/);
  assert.doesNotMatch(html, /Why this moment/);
  assert.doesNotMatch(html, /null|undefined|NaN/);
});

test('the title and the reasons come from the video, so they are escaped', () => {
  const html = renderJobPage(job(), [clip({ title: '<img src=x onerror=alert(1)>', score: 50, reasons: ['<script>alert(2)</script>'] })]);
  assert.doesNotMatch(html, /<img src=x|<script>alert/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('while the job is still running no player or explanation is shown, only the download links', () => {
  const html = renderJobPage(job({ status: 'processing', stage: 'extracting_clips', progress: 90 }), [clip({ title: 'A title', score: 70, reasons: ['question phrasing'] })]);
  assert.doesNotMatch(html, /<video|Why this moment/);
  assert.match(html, /Download clip/);
});

const uploadInfo = { maxUploadMb: 500, defaultClipCount: 1, defaultClipSeconds: { min: 20, max: 60 }, clipSize: { width: 1080, height: 1920 }, faceFraming: true };

test('the upload page offers "follow a face" only when the server can do it, says what it does and does not do, and keeps the middle of the picture as the first choice', () => {
  const on = renderUploadPage(uploadInfo);
  assert.match(on, /<select name="framing">\s*<option value="center">Middle of the picture<\/option>\s*<option value="face">Follow a face \(beta\)<\/option>/, 'the default comes first');
  assert.match(on, /not necessarily whoever is talking/, 'the page is honest about what it follows');
  assert.match(on, /takes a little longer/, 'and about the cost');
  const off = renderUploadPage({ ...uploadInfo, faceFraming: false });
  assert.doesNotMatch(off, /<option value="face">|Follow a face|whoever is talking/);
  assert.match(off, /<select name="framing">\s*<option value="center">Middle of the picture<\/option>\s*<option value="fit">/, 'what the server can still do is offered');
  assert.match(off, /name="captionStyle"/, 'the other choices are untouched');
  assert.match(on, /<option value="face">Follow a face \(beta\)<\/option>\s*<option value="fit">Whole picture, blurred background<\/option>/, 'the whole picture is a choice too');
  assert.match(on, /good for slides, screens and sport/);
});

test('the upload page offers the four shapes of clip, vertical first, and names the quality by what every shape shares', () => {
  const page = renderUploadPage(uploadInfo);
  assert.match(page, /<select name="aspect">\s*<option value="vertical">Vertical 9:16[^<]*<\/option>\s*<option value="portrait">Portrait 4:5[^<]*<\/option>\s*<option value="square">Square 1:1<\/option>\s*<option value="landscape">Landscape 16:9[^<]*<\/option>\s*<\/select>/, 'the default comes first');
  assert.match(page, /<option value="hd">Best \(1080p\)<\/option><option value="standard">Faster \(720p\)<\/option>/, 'the size depends on the shape, so the choice is not named by one');
  assert.doesNotMatch(page, /1080×1920|720×1280/);
  assert.match(page, /vertical, unless you choose another shape/);
  assert.doesNotMatch(renderUploadPage({ ...uploadInfo, clipSize: { width: 720, height: 1280 } }), /value="standard"/, 'a server already at the fast size offers no faster one');
});

test('a clip says how it was framed when it was asked to follow a face, in words that are escaped, and says nothing when nothing was asked', () => {
  const followed = renderJobPage(job(), [clip({ framing: 'Followed a face, seen in 80% of the moments checked.' })]);
  assert.match(followed, /<div class="meta">Followed a face, seen in 80% of the moments checked\.<\/div>/);
  const centred = renderJobPage(job(), [clip({ framing: 'Centred: no face was found in the video.' })]);
  assert.match(centred, /<div class="meta">Centred: no face was found in the video\.<\/div>/);
  assert.doesNotMatch(renderJobPage(job(), [clip({ framing: null })]), /Followed a face|Centred:/, 'a clip made from the middle by default needs no explanation');
  const hostile = renderJobPage(job(), [clip({ framing: '<img src=x onerror=alert(1)>' })]);
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the upload page lets the look of the captions be chosen, each choice starting from what captions always looked like, and says what the colour is for', () => {
  const page = renderUploadPage(uploadInfo);
  assert.match(page, /<select name="captionAccent">\s*<option value="gold">Gold<\/option>\s*<option value="green">Green<\/option>\s*<option value="cyan">Cyan<\/option>\s*<option value="pink">Pink<\/option>\s*<option value="red">Red<\/option>\s*<\/select>/, 'gold, the colour it always was, comes first');
  assert.match(page, /<select name="captionPosition">\s*<option value="lower">Lower part[^<]*<\/option>\s*<option value="middle">Middle<\/option>\s*<option value="top">Top<\/option>\s*<\/select>/, 'the lower part comes first');
  assert.match(page, /<select name="captionSize">\s*<option value="small">Small<\/option>\s*<option value="medium" selected>Medium<\/option>\s*<option value="large">Large<\/option>\s*<\/select>/, 'medium is the one that starts selected');
  assert.match(page, /colour is for the word being spoken, so it shows with the two styles that light a word/, 'the page does not promise a colour for plain phrases');
  assert.ok(page.indexOf('name="captionStyle"') < page.indexOf('name="captionAccent"') && page.indexOf('name="captionSize"') < page.indexOf('name="framing"'), 'the look sits with the captions, before the framing');
});

test('the timings of a job whose transcript was reused say so in plain words', () => {
  const html = renderJobPage(job({ stageTimings: { extracting_audio: 2000, reusing_transcript: 150, detecting_highlights: 20, extracting_clips: 61_000 } }), [clip({})]);
  assert.match(html, /<tr><td>Reusing what was heard in this video before<\/td><td>0 s<\/td><\/tr>/);
  assert.doesNotMatch(html, /Listening to the speech/, 'the speech was not listened to this time');
  assert.ok(html.indexOf('Extracting the audio') < html.indexOf('Reusing what was heard') && html.indexOf('Reusing what was heard') < html.indexOf('Finding the best moments') && html.indexOf('Finding the best moments') < html.indexOf('Rendering the clips'), 'in the order things happen');
});

test('how long clips are kept is said in plain words, in the singular for one day', () => {
  assert.equal(keptFor(1), 'Clips are deleted a day after they are made.');
  assert.equal(keptFor(2), 'Clips are deleted 2 days after they are made.');
  assert.equal(keptFor(14), 'Clips are deleted 14 days after they are made.');
});

test('the day a job is deleted is counted from when it finished, in UTC, and is not guessed when the time is not a time', () => {
  assert.equal(deletedOn('2026-10-01T10:05:00.000Z', 14), '2026-10-15');
  assert.equal(deletedOn('2026-10-01T23:59:59.999Z', 1), '2026-10-02', 'the last moment of a day is still that day');
  assert.equal(deletedOn('2026-12-20T00:00:00.000Z', 30), '2027-01-19', 'across the end of a year');
  assert.equal(deletedOn('not a time', 7), undefined);
  assert.equal(deletedOn('', 7), undefined);
});

test('a job that is over offers to be deleted, with words that fit what it is; a job that is still being worked on does not', () => {
  const done = renderJobPage(job(), [clip()]);
  assert.match(done, /<a class="btn danger" href="\/jobs\/job-1\/delete">Delete this video and its clips<\/a>/);
  const failed = renderJobPage(job({ status: 'failed', stage: 'failed', errorMessage: 'No speech was found.' }), []);
  assert.match(failed, /<a class="btn danger" href="\/jobs\/job-1\/delete">Delete this job<\/a>/);
  for (const [status, stage] of [['queued', 'queued'], ['processing', 'transcribing'], ['processing', 'extracting_clips']] as const) {
    assert.doesNotMatch(renderJobPage(job({ status, stage, progress: 40 }), []), /\/delete|Delete this/, `a job that is ${status} (${stage}) cannot be deleted`);
  }
  assert.doesNotMatch(renderJobPage(job(), [clip()]), /<script/, 'the pages stay free of JavaScript');
  const hostile = renderJobPage(job({ id: '"><script>alert(1)</script>' }), [clip()]);
  assert.doesNotMatch(hostile, /<script>alert/, 'the address of the job is escaped where it is put into the page');
  assert.match(hostile, /href="\/jobs\/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;\/delete"/);
});

test('the job page says how long clips are kept only when they are, only for a finished job that has clips, and until which day', () => {
  const kept = renderJobPage(job(), [clip()], Date.now(), { retentionDays: 14 });
  assert.match(kept, /<p class="muted">Clips are deleted 14 days after they are made\. These are kept until 2026-10-15\. Download the clips you want to keep\.<\/p>/);
  assert.doesNotMatch(renderJobPage(job(), [clip()]), /Clips are deleted|kept until/, 'nothing is said while clips are kept until a person deletes them');
  assert.doesNotMatch(renderJobPage(job(), [clip()], Date.now(), { retentionDays: 0 }), /Clips are deleted|kept until/);
  assert.doesNotMatch(renderJobPage(job(), [], Date.now(), { retentionDays: 14 }), /Clips are deleted|kept until/, 'with no clips there is nothing to download');
  assert.doesNotMatch(renderJobPage(job(), [clip({ status: 'failed', errorMessage: 'x' })], Date.now(), { retentionDays: 14 }), /Clips are deleted|kept until/, 'nor with only clips that could not be made');
  assert.doesNotMatch(renderJobPage(job({ status: 'processing', stage: 'transcribing', progress: 50 }), [clip()], Date.now(), { retentionDays: 14 }), /Clips are deleted|kept until/, 'the clock starts when the job is over');
  assert.doesNotMatch(renderJobPage(job({ status: 'failed', stage: 'failed', errorMessage: 'x' }), [clip()], Date.now(), { retentionDays: 14 }), /Clips are deleted|kept until/, 'a failed job promises no clips');
  const unknownDay = renderJobPage(job({ updatedAt: 'garbage', stageTimings: { transcribing: 1000 } }), [clip()], Date.now(), { retentionDays: 14 });
  assert.match(unknownDay, /Clips are deleted 14 days after they are made\. Download the clips you want to keep\./);
  assert.doesNotMatch(unknownDay, /kept until|NaN|undefined|Invalid/, 'no day is made up');
});

test('the upload page says how long clips are kept, and says nothing when they are kept until deleted', () => {
  assert.match(renderUploadPage({ ...uploadInfo, retentionDays: 30 }), /<p class="notice">Clips are deleted 30 days after they are made\. Download the clips you want to keep\.<\/p>/);
  assert.match(renderUploadPage({ ...uploadInfo, retentionDays: 1 }), /Clips are deleted a day after they are made\./);
  assert.doesNotMatch(renderUploadPage(uploadInfo), /Clips are deleted/);
  assert.doesNotMatch(renderUploadPage({ ...uploadInfo, retentionDays: 0 }), /Clips are deleted/);
});

test('the page that asks before deleting says what is lost, posts with a plain form, offers the way back, and escapes what came from the video', () => {
  const page = renderDeleteConfirmPage(job({ id: 'job-9', originalFilename: '<b>talk</b>.mp4' }));
  assert.match(page, /<form method="post" action="\/jobs\/job-9\/delete"><button type="submit" class="danger">Yes, delete it for good<\/button><\/form>/);
  assert.match(page, /<a href="\/jobs\/job-9">No, keep it<\/a>/);
  assert.match(page, /cannot be undone/);
  assert.match(page, /Clips you already downloaded stay where you saved them/);
  assert.doesNotMatch(page, /<b>talk/);
  assert.match(page, /&lt;b&gt;talk&lt;\/b&gt;\.mp4/);
  assert.doesNotMatch(page, /<script/);
  assert.match(page, /The clips made from it, its transcript and the record of this job are deleted for good\./, 'what is lost is said');
  const hostile = renderDeleteConfirmPage(job({ id: '"><script>alert(1)</script>' }));
  assert.doesNotMatch(hostile, /<script>alert/, 'the address of the job is escaped where it is put into the form and the link');
  assert.equal((hostile.match(/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) ?? []).length, 2);
});

test('the page shown after deleting says so and leads on, with nothing about the job in it', () => {
  const page = renderDeletedPage();
  assert.match(page, /<h1>Deleted<\/h1>/);
  assert.match(page, /were deleted/);
  assert.match(page, /<a href="\/test-upload">Upload another video<\/a>/);
  assert.doesNotMatch(page, /<script|job-1|talk\.mp4/);
});

// ---- Stopping a video -------------------------------------------------------------------------------------------------------------

const stopLink = /<a class="btn danger" href="\/jobs\/job-1\/stop">Stop this video<\/a>/;
const stoppedJob = () => job({ status: 'failed', stage: 'stopped', errorMessage: plainWords.stopped, progress: 40 });

test('a video that is being worked on offers to be stopped, and one that is over or already being stopped does not', () => {
  for (const [status, stage] of [['queued', 'queued'], ['queued', 'waiting_for_capacity'], ['processing', 'transcribing'], ['processing', 'extracting_clips']] as const) {
    const page = renderJobPage(job({ status, stage, progress: 40 }), []);
    assert.match(page, stopLink, `a video that is ${status} (${stage}) can be stopped`);
    assert.doesNotMatch(page, /\/delete|Delete this/, 'and cannot be deleted while it is worked on');
  }
  assert.doesNotMatch(renderJobPage(job(), [clip()]), /Stop this video|\/stop/, 'a finished video has nothing to stop');
  assert.doesNotMatch(renderJobPage(job({ status: 'failed', stage: 'failed', errorMessage: 'No speech was found.' }), []), /Stop this video|\/stop/, 'neither has one that failed');
  assert.doesNotMatch(renderJobPage(stoppedJob(), []), /Stop this video|\/stop/, 'neither has one that was stopped');
  assert.doesNotMatch(renderJobPage(job({ status: 'processing', stage: 'transcribing', progress: 40 }), [], Date.now(), { stopping: true }), /Stop this video|\/stop/, 'a video that is being stopped is not offered to be stopped again');
  const hostile = renderJobPage(job({ id: '"><script>alert(1)</script>', status: 'processing', stage: 'transcribing' }), []);
  assert.doesNotMatch(hostile, /<script>alert/, 'the address of the job is escaped where it is put into the link');
  assert.match(hostile, /href="\/jobs\/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;\/stop"/);
});

test('a video that is being stopped says so, shows no progress and no way to stop it again, and keeps refreshing until the clean-up is over', () => {
  const page = renderJobPage(job({ status: 'processing', stage: 'transcribing', progress: 40 }), [], Date.now(), { stopping: true });
  assert.match(page, /<h1>Stopping your video<\/h1>/);
  assert.match(page, /Status: <strong>stopping<\/strong>/);
  assert.match(page, /What was made so far is being thrown away\./);
  assert.match(page, /<meta http-equiv="refresh" content="5">/, 'the page looks again, and then shows that the video was stopped');
  assert.doesNotMatch(page, /<progress|Still working|Processing your video|transcribing|Transcribing/i, 'it does not go on as if the work went on');
  assert.doesNotMatch(page, /class="card error"/, 'a stop is not an error');
  const resumed = job({ status: 'processing', stage: 'transcribing', progress: 40, attempts: 2 });
  assert.match(renderJobPage(resumed, []), /Resumed automatically after the server restarted \(attempt 2\)\./, 'a video that went on after a restart says so');
  assert.doesNotMatch(renderJobPage(resumed, [], Date.now(), { stopping: true }), /Resumed automatically/, 'but not while it is being stopped');
  const notStopping = renderJobPage(job({ status: 'processing', stage: 'transcribing', progress: 40 }), []);
  assert.match(notStopping, /<h1>Processing your video<\/h1>/);
  assert.match(notStopping, /<progress/, 'a video that is not being stopped is shown as before');
  assert.doesNotMatch(notStopping, /Stopping|stopping/);
});

test('a video that the person stopped says so in words of its own: not "failed", not in the colour of an error, with no way to stop it, and with a way to delete the job', () => {
  const page = renderJobPage(stoppedJob(), []);
  assert.match(page, /<h1>You stopped this video<\/h1>/);
  assert.match(page, /Status: <strong>stopped<\/strong>/);
  assert.doesNotMatch(page, /failed|could not be processed|\(stopped\)/i, 'the video did not fail');
  assert.doesNotMatch(page, /class="card error"/, 'it is not an error');
  assert.match(page, /You stopped this video before it was finished\. Nothing from it was kept\./, 'the words stored with the job are shown');
  assert.doesNotMatch(page, /<meta http-equiv="refresh"|<progress/, 'there is nothing left to wait for');
  assert.match(page, /<a class="btn danger" href="\/jobs\/job-1\/delete">Delete this job<\/a>/);
  assert.match(page, /<a href="\/test-upload">Upload another video<\/a>/);
  const failed = renderJobPage(job({ status: 'failed', stage: 'failed', errorMessage: 'No speech was found.' }), []);
  assert.match(failed, /<h1>This video could not be processed<\/h1>/, 'a video that failed is shown as before');
  assert.match(failed, /class="card error"/);
  assert.match(failed, /Status: <strong>failed<\/strong>/);
});

test('the page that asks before stopping says what is lost, posts with a plain form, offers the way back, and escapes what came from the video', () => {
  const page = renderStopConfirmPage(job({ id: 'job-9', originalFilename: '<b>talk</b>.mp4', status: 'processing', stage: 'transcribing' }));
  assert.match(page, /<h1>Stop this video\?<\/h1>/);
  assert.match(page, /<form method="post" action="\/jobs\/job-9\/stop"><button type="submit" class="danger">Yes, stop it<\/button><\/form>/);
  assert.match(page, /<a href="\/jobs\/job-9">No, let it go on<\/a>/);
  assert.match(page, /The work on it ends now, and what was made so far is thrown away\./, 'what is lost is said');
  assert.match(page, /to get clips from this video, upload it again/);
  assert.doesNotMatch(page, /<b>talk/);
  assert.match(page, /&lt;b&gt;talk&lt;\/b&gt;\.mp4/);
  assert.doesNotMatch(page, /<script/, 'the pages have no JavaScript at all');
  const hostile = renderStopConfirmPage(job({ id: '"><script>alert(1)</script>' }));
  assert.doesNotMatch(hostile, /<script>alert/, 'the address of the job is escaped where it is put into the form and the link');
  assert.equal((hostile.match(/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) ?? []).length, 2);
});
