import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeneratedClip, VideoJob } from './domain.js';
import { defaultJobOptions } from './domain.js';
import { renderJobPage } from './pages.js';

const job = (overrides: Partial<VideoJob> = {}): VideoJob => ({
  id: 'job-1', originalFilename: 'talk.mp4', storedFilename: 'talk.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'completed', stage: 'completed', errorMessage: null,
  durationSeconds: 120, width: 1920, height: 1080, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:05:00.000Z', sourceStorageKey: null, attempts: 1,
  options: defaultJobOptions, stageTimings: {}, progress: 100, ...overrides,
});
const clip = (overrides: Partial<GeneratedClip> = {}): GeneratedClip => ({
  id: 'clip-1', jobId: 'job-1', candidateId: 'cand-1', startSeconds: 10, endSeconds: 55, durationSeconds: 45, outputPath: 'o.mp4', outputFilename: 'o.mp4', status: 'completed', errorMessage: null,
  captionPath: null, createdAt: '2026-10-01T10:04:00.000Z', updatedAt: '2026-10-01T10:04:30.000Z', title: null, score: null, reasons: [], ...overrides,
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
