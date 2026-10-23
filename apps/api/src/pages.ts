import type { GeneratedClip, VideoJob } from './domain.js';
import { MAX_CLIP_COUNT, clipLengthRanges, outputSizeFor } from './options.js';
import { formatDuration, stageLabel, totalMilliseconds } from './progress.js';

/**
 * The pages people see. They are plain HTML with no JavaScript at all: a script that fails on someone's phone leaves a blank
 * page (it already happened once), while a form and a refresh tag keep working. Everything that comes from outside (file names,
 * stored error messages) goes through escapeHtml.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `
  :root{--text:#14181f;--muted:#5b6472;--bg:#f4f6f9;--card:#fff;--line:#dfe3e9;--accent:#1a73e8;--accent-text:#fff;--good:#0f7a55;--bad:#b3261e;--bad-bg:#fdecea;--track:#e3e8ef}
  @media (prefers-color-scheme:dark){:root{--text:#eef1f5;--muted:#a3adbb;--bg:#10141a;--card:#181d25;--line:#2a313c;--accent:#5b9bff;--accent-text:#08101c;--good:#4cc79a;--bad:#ff8a80;--bad-bg:#3a1a18;--track:#2a313c}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
  h1{font-size:1.6rem;line-height:1.2;margin:0 0 8px}
  .lead{color:var(--muted);margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 16px}
  .error{background:var(--bad-bg);border-color:var(--bad);color:var(--bad)}
  label.field{display:block;margin:0 0 14px}
  .label{display:block;font-weight:600;margin:0 0 4px}
  .hint,.muted{color:var(--muted);font-size:.9rem}
  input[type=file],input[type=password],select{width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font:inherit}
  details{margin:4px 0 16px}
  summary{cursor:pointer;font-weight:600;padding:6px 0}
  details[open] summary{margin-bottom:10px}
  button,.btn{display:block;width:100%;text-align:center;padding:14px 16px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
  .btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  .notice{white-space:pre-wrap;word-break:break-word;color:var(--muted);font-size:.9rem;margin:0}
  progress{width:100%;height:14px;border-radius:7px;overflow:hidden;appearance:none;-webkit-appearance:none;border:0;background:var(--track);display:block}
  progress::-webkit-progress-bar{background:var(--track)}
  progress::-webkit-progress-value{background:var(--accent);border-radius:7px}
  progress::-moz-progress-bar{background:var(--accent);border-radius:7px}
  .stage{font-weight:700;margin:0 0 10px}
  .row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin:8px 0 0}
  video{display:block;width:100%;max-height:70vh;border-radius:10px;background:#000;margin:0 0 10px}
  .clip h2{font-size:1.05rem;margin:0 0 4px;word-break:break-word}
  .clip .meta{color:var(--muted);font-size:.9rem;margin:0 0 10px}
  .clip details{margin:12px 0 0}
  .clip ul{margin:6px 0 0;padding-left:20px;color:var(--muted);font-size:.9rem}
  .clip .btn{margin-top:10px}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  td{padding:4px 0;border-top:1px solid var(--line)} td:last-child{text-align:right;color:var(--muted)}
  .id{font-size:.75rem;color:var(--muted);margin-top:24px;word-break:break-all}
  a{color:var(--accent)}
`;

function shell(title: string, body: string, options: { refreshSeconds?: number } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ''}
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface UploadPageInfo {
  maxUploadMb: number;
  /** Clips made when the person does not choose a number (CLIP_MAX_CANDIDATES). */
  defaultClipCount: number;
  /** Clip length used when the person does not choose one, in seconds. */
  defaultClipSeconds: { min: number; max: number };
  /** The configured clip size; the "fast" choice is derived from it. */
  clipSize: { width: number; height: number };
  /** Whether this server can follow a face (FACE_FRAMING_ENABLED); the choice is only offered when it can. */
  faceFraming: boolean;
}

export function renderUploadPage(info: UploadPageInfo): string {
  const fast = outputSizeFor(info.clipSize, 'standard');
  const sizeText = (size: { width: number; height: number }) => `${size.width}×${size.height}`;
  const counts = Array.from({ length: MAX_CLIP_COUNT }, (_, index) => index + 1);
  return shell('Upload a video', `
<h1>Upload a video</h1>
<p class="lead">Choose a video (MP4, MOV, MKV, WebM, AVI or M4V) of up to ${info.maxUploadMb} MB.</p>
<p class="lead">It is turned into short vertical clips with captions. The next page shows your clips as soon as they are ready.</p>
<form class="card" action="/test-upload" method="post" enctype="multipart/form-data">
  <label class="field"><span class="label">Video</span><input name="video" type="file" accept="video/*" required></label>
  <details>
    <summary>Options</summary>
    <label class="field"><span class="label">Number of clips</span>
      <select name="clipCount"><option value="">Automatic (up to ${info.defaultClipCount})</option>${counts.map((count) => `<option value="${count}">${count}</option>`).join('')}</select></label>
    <label class="field"><span class="label">Clip length</span>
      <select name="clipLength">
        <option value="">Automatic (${info.defaultClipSeconds.min}–${info.defaultClipSeconds.max} s)</option>
        <option value="short">Short (${clipLengthRanges.short.min}–${clipLengthRanges.short.max} s)</option>
        <option value="medium">Medium (${clipLengthRanges.medium.min}–${clipLengthRanges.medium.max} s)</option>
        <option value="long">Long (${clipLengthRanges.long.min}–${clipLengthRanges.long.max} s)</option>
      </select></label>
    <label class="field"><span class="label">Quality</span>
      <select name="quality"><option value="hd">Best (${sizeText(info.clipSize)})</option>${fast.width === info.clipSize.width ? '' : `<option value="standard">Faster (${sizeText(fast)})</option>`}</select></label>
    <label class="field"><span class="label">Captions</span>
      <select name="captionStyle">
        <option value="classic">Plain phrases</option>
        <option value="highlight">Phrases, the spoken word lit</option>
        <option value="pop">Big words that pop in</option>
        <option value="none">No captions</option>
      </select></label>
    <label class="field"><span class="label">Framing</span>
      <select name="framing">
        <option value="center">Middle of the picture</option>${info.faceFraming ? `
        <option value="face">Follow a face (beta)</option>` : ''}
        <option value="fit">Whole picture, blurred background</option>
      </select></label>
    <div class="hint">A clip is much narrower than most videos, so "Middle of the picture" keeps only about a third of the width. "Whole picture" keeps everything in view (good for slides, screens and sport) and fills the empty space with a blurred copy of the picture.${info.faceFraming ? ' "Follow a face" moves the picture to keep a face in view: the most visible one, not necessarily whoever is talking. It takes a little longer.' : ''}</div>
  </details>
  <button type="submit">Upload video</button>
</form>
<p class="notice">Large videos take a while to upload over a mobile connection. Keep this page open and the screen on until the next page appears. Videos are processed one at a time, and videos over about 100 MB have not been tested on this server yet.</p>`);
}

export function renderMessagePage(title: string, message: string, link: { href: string; text: string } = { href: '/test-upload', text: 'Try again' }): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><div class="card error">${escapeHtml(message)}</div><p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>`);
}

/** Why a moment was picked, in the words of the rules that picked it. Nothing for a clip made before the reasons were stored. */
function whyThisMoment(clip: GeneratedClip): string {
  if (clip.score === null && !clip.reasons.length) return '';
  const reasons = clip.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
  return `<details><summary>Why this moment${clip.score === null ? '' : ` · score ${Math.round(clip.score)} / 100`}</summary>
    <div class="hint">Chosen by plain rules over the transcript (words, pauses, length), not by an AI model.</div>${reasons ? `<ul>${reasons}</ul>` : ''}</details>`;
}

const STAGE_ORDER = ['preparing_source', 'saving_source', 'restoring_source', 'probing_video', 'extracting_audio', 'transcribing', 'detecting_highlights', 'extracting_clips'];

export function renderJobPage(job: VideoJob, clips: GeneratedClip[], now: number = Date.now()): string {
  const stillWorking = job.status !== 'completed' && job.status !== 'failed';
  const finished = job.status === 'completed';
  const readyClips = clips.filter((clip) => clip.status === 'completed');
  const unmadeClips = clips.filter((clip) => clip.status === 'failed').length;
  const elapsedMs = Math.max(0, now - Date.parse(job.createdAt));
  const clipUrl = (clip: GeneratedClip) => `/api/jobs/${job.id}/clips/${clip.id}`;
  const length = (clip: GeneratedClip) => (clip.durationSeconds ? `${Math.round(clip.durationSeconds)} s` : '');
  const timings = STAGE_ORDER.filter((stage) => job.stageTimings[stage] !== undefined).map((stage) => `<tr><td>${escapeHtml(stageLabel(stage))}</td><td>${formatDuration(job.stageTimings[stage])}</td></tr>`).join('');

  const heading = finished ? 'Your clips' : job.status === 'failed' ? 'This video could not be processed' : 'Processing your video';
  const status = `
<div class="card ${job.status === 'failed' ? 'error' : ''}">
  <div class="stage">Status: <strong>${job.status}</strong>${finished || job.stage === job.status ? '' : ` (${escapeHtml(job.stage)})`}</div>
  ${stillWorking ? `<div class="stage">${escapeHtml(stageLabel(job.stage))}</div><progress value="${job.progress}" max="100">${job.progress}%</progress><div class="row"><span>${job.progress}%</span><span class="muted">Running for ${formatDuration(elapsedMs)}</span></div>` : ''}
  ${job.status === 'failed' && job.errorMessage ? `<div style="margin-top:8px">${escapeHtml(job.errorMessage)}</div>` : ''}
  ${stillWorking ? '<div class="muted" style="margin-top:8px">Still working -- this page refreshes itself every 5 seconds.</div>' : ''}
  ${stillWorking && job.attempts > 1 ? `<div class="muted" style="margin-top:8px">Resumed automatically after the server restarted (attempt ${job.attempts}).</div>` : ''}
  ${finished ? `<div class="muted">Done in ${formatDuration(Object.keys(job.stageTimings).length ? totalMilliseconds(job.stageTimings) : Math.max(0, Date.parse(job.updatedAt) - Date.parse(job.createdAt)))}.${unmadeClips ? ` ${unmadeClips} clip${unmadeClips === 1 ? '' : 's'} could not be made.` : ''}</div>` : ''}
</div>`;

  // While the job runs the page reloads itself, which would cut off a video that is playing, so players only appear once it is over.
  const clipSection = finished
    ? readyClips.map((clip, index) => `
<section class="card clip">
  <h2>${clip.title ? escapeHtml(clip.title) : `Clip ${index + 1}`}</h2>
  <div class="meta">Clip ${index + 1}${length(clip) ? ` · ${length(clip)}` : ''}</div>${clip.framing ? `
  <div class="meta">${escapeHtml(clip.framing)}</div>` : ''}
  <video controls playsinline preload="metadata" src="${clipUrl(clip)}#t=0.1"></video>
  <a class="btn" href="${clipUrl(clip)}?download=1">Download clip (${length(clip)})</a>
  ${whyThisMoment(clip)}
</section>`).join('')
    : readyClips.map((clip) => `<a class="btn" style="margin:0 0 12px" href="${clipUrl(clip)}?download=1">Download clip (${length(clip)})</a>`).join('');

  return shell('Job status', `
<h1>${heading}</h1>
<p class="lead" style="word-break:break-word">${escapeHtml(job.originalFilename)}</p>
${status}
${clipSection}
${timings && finished ? `<details class="card"><summary>Where the time went</summary><table>${timings}</table></details>` : ''}
<p><a href="/test-upload">Upload another video</a></p>
<p class="id">Job ${escapeHtml(job.id)}</p>`, { refreshSeconds: stillWorking ? 5 : undefined });
}

/** The page where the access code is typed (see access.ts). `next` is where the person goes afterwards; it has been checked by safeNextPath. */
export function renderLoginPage(info: { next: string; problem?: 'wrong' | { waitSeconds: number } }): string {
  const problem = info.problem === undefined ? '' : info.problem === 'wrong'
    ? '<div class="card error">That code is not right.</div>'
    : `<div class="card error">Too many wrong codes. Try again in ${Math.max(1, Math.ceil(info.problem.waitSeconds / 60))} minute${info.problem.waitSeconds > 60 ? 's' : ''}.</div>`;
  return shell('Access code', `
<h1>Access code</h1>
<p class="lead">This service is private. Type the access code you were given.</p>${problem}
<form class="card" action="/login" method="post">
  <label class="field"><span class="label">Access code</span><input name="code" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus></label>
  <input type="hidden" name="next" value="${escapeHtml(info.next)}">
  <button type="submit">Open</button>
</form>`);
}
