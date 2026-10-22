import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeneratedClip, VideoJob } from './domain.js';
import { defaultJobOptions } from './domain.js';
import { renderJobPage, renderUploadPage } from './pages.js';

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
