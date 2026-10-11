import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import type { AppConfig } from './config.js';
import { StudioDatabase } from './database.js';
import { createStorage, missingR2Settings, type DurableStorage } from './storage.js';
import type { NewVideoJob, VideoJob } from './domain.js';
import { FfmpegAdapter } from './ffmpeg.js';
import { VideoPipeline } from './pipeline.js';
import { createTranscriptionEngine, type TranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector, type HighlightOptions } from './highlights.js';
import { FfmpegClipRenderer, isSafeClipIdentifier, resolveClipOutputPath } from './clips.js';
import { downloadYouTubeVideo } from './youtube.js';

const acceptedExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const acceptedMimeTypes = new Set(['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm', 'video/x-msvideo', 'video/x-m4v']);

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** What the API shows about a job: the internal storage key stays on the server. */
function toPublicJob(job: VideoJob): Omit<VideoJob, 'sourceStorageKey'> {
  const { sourceStorageKey: _internal, ...visible } = job;
  return visible;
}

export interface StorageStatus {
  backend: 'r2' | 'local-only';
  /** Result of the write/read-back/delete round trip done once at startup (only meaningful for r2). */
  selfTest: 'pending' | 'passed' | 'failed' | 'not-applicable';
  checkedAt: string | null;
}

/** Test seams. Production passes nothing and gets the real implementations built from the config. */
export interface AppOverrides {
  storage?: DurableStorage;
  transcriber?: TranscriptionEngine;
  /** Isolates the database tables in their own Postgres schema (used by tests). */
  databaseSchema?: string;
}

export async function createApp(config: AppConfig, overrides: AppOverrides = {}) {
  const durableStorage = overrides.storage ?? createStorage(config);
  if (config.REQUIRE_DURABLE_STORAGE && !durableStorage.isDurable) {
    throw new Error(`REQUIRE_DURABLE_STORAGE is on but durable storage (Cloudflare R2) is not fully configured. Missing settings: ${missingR2Settings(config).join(', ') || 'none listed'}.`);
  }
  mkdirSync(config.UPLOAD_DIR, { recursive: true });
  mkdirSync(config.TEMP_DIR, { recursive: true });
  mkdirSync(config.OUTPUT_DIR, { recursive: true });
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const db = await StudioDatabase.connect(config.DATABASE_URL, overrides.databaseSchema);
  const transcriber = overrides.transcriber ?? createTranscriptionEngine(config);
  const highlightOptions: HighlightOptions = { minDurationSeconds: config.HIGHLIGHT_MIN_DURATION_SECONDS, maxDurationSeconds: config.HIGHLIGHT_MAX_DURATION_SECONDS, maxCandidates: config.HIGHLIGHT_MAX_CANDIDATES, overlapThreshold: config.HIGHLIGHT_OVERLAP_THRESHOLD, weights: { density: config.HIGHLIGHT_WEIGHT_DENSITY, emphasis: config.HIGHLIGHT_WEIGHT_EMPHASIS, question: config.HIGHLIGHT_WEIGHT_QUESTION, number: config.HIGHLIGHT_WEIGHT_NUMBER, contrast: config.HIGHLIGHT_WEIGHT_CONTRAST, hook: config.HIGHLIGHT_WEIGHT_HOOK, completeness: config.HIGHLIGHT_WEIGHT_COMPLETENESS } };
  const renderer = new FfmpegClipRenderer(config.FFMPEG_PATH, config.CLIP_VIDEO_CODEC, config.CLIP_AUDIO_CODEC, config.CLIP_CRF, config.CLIP_PRESET, config.CLIP_VERTICAL_WIDTH, config.CLIP_VERTICAL_HEIGHT);
  const pipeline = new VideoPipeline(db, new FfmpegAdapter(config.FFPROBE_PATH, config.FFMPEG_PATH), transcriber, new DeterministicHighlightDetector(), highlightOptions, renderer, config.CLIP_MAX_CANDIDATES, config.UPLOAD_DIR, config.TEMP_DIR, config.OUTPUT_DIR, logger, durableStorage, {
    concurrency: config.JOB_CONCURRENCY,
    maxAttempts: config.JOB_MAX_ATTEMPTS,
    staleAfterMs: config.JOB_STALE_AFTER_SECONDS * 1000,
    heartbeatMs: config.JOB_HEARTBEAT_SECONDS * 1000,
    recheckMs: Math.max(1000, config.JOB_STALE_AFTER_SECONDS * 500),
  });

  // Prove at startup (and leave a clear line in the logs) whether durable storage really works,
  // instead of finding out when the first customer's upload fails.
  const storageStatus: StorageStatus = { backend: durableStorage.isDurable ? 'r2' : 'local-only', selfTest: durableStorage.isDurable ? 'pending' : 'not-applicable', checkedAt: null };
  if (durableStorage.isDurable) {
    durableStorage.selfTest().then(() => {
      storageStatus.selfTest = 'passed'; storageStatus.checkedAt = new Date().toISOString();
      logger.info('Durable storage self-test passed: wrote a test object to R2, read it back and deleted it');
    }, (error: unknown) => {
      storageStatus.selfTest = 'failed'; storageStatus.checkedAt = new Date().toISOString();
      logger.error({ err: error }, 'Durable storage self-test FAILED: uploads will not be saved. Check the R2 credentials, bucket name and account id');
    });
  } else {
    logger.warn('Durable storage (R2) is NOT configured: uploaded videos, generated clips and unfinished jobs are lost whenever the server restarts. Set REQUIRE_DURABLE_STORAGE=true to make this a startup error.');
  }

  // Jobs a previous process left unfinished (restart, redeploy, free-tier sleep, out-of-memory kill):
  // resume the ones whose video can still be obtained, fail the rest with an honest reason.
  const recovery = await pipeline.recoverInterruptedJobs();
  if (recovery.resumed.length || recovery.failed.length || recovery.waiting) logger.info({ resumedJobIds: recovery.resumed, failedJobIds: recovery.failed, stillOwnedByAnotherProcess: recovery.waiting }, 'Checked for jobs interrupted by a previous process');

  const maxUploadMb = Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024);
  const storage = multer.diskStorage({ destination: config.UPLOAD_DIR, filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`) });
  const upload = multer({ storage, limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 }, fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!acceptedExtensions.has(ext) || (file.mimetype && !acceptedMimeTypes.has(file.mimetype))) return cb(new Error('Only MP4, MOV, MKV, WebM, AVI, and M4V video files are accepted.'));
    cb(null, true);
  }});
  /** An upload that never became a job (the database was unreachable, say) must not sit on the disk for nothing. */
  const discardUpload = (storedFilename: string | undefined) => (storedFilename ? rm(join(config.UPLOAD_DIR, storedFilename), { force: true }).catch(() => undefined) : Promise.resolve());
  const app = express();
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/test-upload', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Upload a video</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px}button{padding:10px 16px;margin-top:12px}pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f5;padding:12px;border-radius:8px}.note{font-weight:600}</style></head><body><h1>Upload a video</h1><p class="note">Choose a video (MP4, MOV, MKV, WebM, AVI or M4V) of up to ${maxUploadMb} MB.</p><p>It is turned into short vertical clips with captions. The next page shows your clips as soon as they are ready.</p><form action="/test-upload" method="post" enctype="multipart/form-data"><input name="video" type="file" accept="video/*" required><br><button type="submit">Upload video</button></form><pre>Large videos take a while to upload over a mobile connection. Keep this page open and the screen on until the next page appears. Videos are processed one at a time, and videos over about 100 MB have not been tested on this server yet.</pre></body></html>`);
  });

  app.post('/test-upload', (req, res, next) => {
    upload.single('video')(req, res, async (error?: unknown) => {
      if (error) {
        const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
          ? `This video is larger than the ${maxUploadMb} MB limit.`
          : error instanceof Error ? error.message : 'Upload failed unexpectedly.';
        req.log.error({ err: error }, 'Upload failed');
        return res.status(400).type('html').send(`<!doctype html><html><body><h1>Upload failed</h1><p>${escapeHtml(message)}</p><p><a href="/test-upload">Try again</a></p></body></html>`);
      }
      try {
        if (!req.file) return res.status(400).type('html').send('<h1>Upload failed</h1><p>No video file was received.</p><p><a href="/test-upload">Try again</a></p>');
        const now = new Date().toISOString();
        const job: NewVideoJob = { id: randomUUID(), originalFilename: req.file.originalname, storedFilename: req.file.filename, mimeType: req.file.mimetype, sizeBytes: req.file.size, status: 'queued', stage: 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
        try { await db.createJob(job); } catch (error) { await discardUpload(req.file.filename); throw error; }
        pipeline.enqueue(job.id);
        res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Upload received</title></head><body><h1>Upload received</h1><p>Your video reached the backend successfully.</p><pre>Job ID: ${job.id}\nFile: ${escapeHtml(req.file.originalname)}\nSize: ${(req.file.size / 1024 / 1024).toFixed(1)} MB\nStatus: queued</pre><p>Open <a href="/jobs/${job.id}">the job status</a> to monitor processing.</p><p><a href="/test-upload">Upload another video</a></p></body></html>`);
      } catch (error) {
        next(error);
      }
    });
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'short-form-video-studio', storage: storageStatus }));
  app.post('/api/youtube', async (req, res, next) => {
    try {
      if (!config.COBALT_API_URL) return res.status(503).json({ error: { code: 'YOUTUBE_INGESTION_NOT_CONFIGURED', message: 'YouTube ingestion is not configured on this deployment.' } });
      const youtubeUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!youtubeUrl) return res.status(400).json({ error: { code: 'YOUTUBE_URL_REQUIRED', message: 'Provide a YouTube URL in the “url” field.' } });

      const id = randomUUID();
      const now = new Date().toISOString();
      const downloaded = await downloadYouTubeVideo({ youtubeUrl, cobaltUrl: config.COBALT_API_URL, cobaltApiKey: config.COBALT_API_KEY, outputDir: config.UPLOAD_DIR, jobId: id, timeoutMs: config.YOUTUBE_DOWNLOAD_TIMEOUT_MS });
      const job: NewVideoJob = { id, originalFilename: downloaded.originalFilename, storedFilename: downloaded.storedFilename, mimeType: downloaded.mimeType, sizeBytes: downloaded.sizeBytes, status: 'queued', stage: 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
      try { await db.createJob(job); } catch (error) { await discardUpload(downloaded.storedFilename); throw error; }
      pipeline.enqueue(job.id);
      res.status(202).json({ job, source: 'youtube' });
    } catch (error) { next(error); }
  });

  app.post('/api/jobs', upload.single('video'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: { code: 'VIDEO_REQUIRED', message: 'Attach one video file using the “video” field.' } });
      const now = new Date().toISOString();
      const job: NewVideoJob = { id: randomUUID(), originalFilename: req.file.originalname, storedFilename: req.file.filename, mimeType: req.file.mimetype, sizeBytes: req.file.size, status: 'queued', stage: 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
      try { await db.createJob(job); } catch (error) { await discardUpload(req.file.filename); throw error; }
      pipeline.enqueue(job.id);
      res.status(202).json({ job });
    } catch (error) { next(error); }
  });
  app.get('/api/jobs/:id', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' } });
    res.json({ job: toPublicJob(job), clips: await db.listClips(job.id) });
  });
  // Human-friendly counterpart to the JSON route above: a big clickable download
  // link instead of asking the person to read raw JSON and copy a clip id by hand
  // on a phone screen. No JavaScript at all -- auto-refresh is a plain <meta> tag,
  // so there's no inline <script> here to ever break again the way /test-upload did.
  app.get('/jobs/:id', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).type('html').send('<!doctype html><html><body><h1>Not found</h1><p>No job exists for this id.</p></body></html>');
    const clips = await db.listClips(job.id);
    const stillWorking = job.status !== 'completed' && job.status !== 'failed';
    res.type('html').send(String.raw`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
${stillWorking ? '<meta http-equiv="refresh" content="5">' : ''}
<title>Job status</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:32px auto;padding:0 16px}
  .status{padding:12px;border-radius:8px;background:#f5f5f5;margin:12px 0}
  .download{display:block;text-align:center;padding:16px;margin:12px 0;background:#1a73e8;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold}
  .error{background:#fdecea;color:#a33}
</style>
</head>
<body>
<h1>Video status</h1>
<div class="status ${job.status === 'failed' ? 'error' : ''}">
  <div>Status: <strong>${job.status}</strong> (${job.stage})</div>
  ${job.status === 'failed' && job.errorMessage ? `<div style="margin-top:8px">${escapeHtml(job.errorMessage)}</div>` : ''}
  ${stillWorking ? '<div style="margin-top:8px">Still working -- this page refreshes itself every 5 seconds.</div>' : ''}
  ${stillWorking && job.attempts > 1 ? `<div style="margin-top:8px">Resumed automatically after the server restarted (attempt ${job.attempts}).</div>` : ''}
</div>
${clips.filter((clip) => clip.status === 'completed').map((clip) => `<a class="download" href="/api/jobs/${job.id}/clips/${clip.id}?download=1">Download clip (${clip.durationSeconds ? Math.round(clip.durationSeconds) + 's' : ''})</a>`).join('')}
<p><a href="/test-upload">Upload another video</a></p>
</body>
</html>`);
  });
  app.get('/api/jobs/:id/transcript', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' } });
    res.json({ jobId: job.id, status: job.status, stage: job.stage, segments: await db.listTranscript(job.id) });
  });
  app.get('/api/jobs/:id/highlights', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' } });
    res.json({ jobId: job.id, status: job.status, stage: job.stage, candidates: await db.listHighlights(job.id) });
  });
  app.get('/api/jobs/:jobId/clips/:clipId', async (req, res) => {
    if (!isSafeClipIdentifier(req.params.jobId) || !isSafeClipIdentifier(req.params.clipId)) return res.status(404).json({ error: { code: 'CLIP_NOT_FOUND', message: 'Generated clip not found.' } });
    const job = await db.getJob(req.params.jobId); const clip = job && await db.getClip(job.id, req.params.clipId);
    if (!job || !clip || clip.status !== 'completed' || clip.outputFilename !== `${clip.id}.mp4`) return res.status(404).json({ error: { code: 'CLIP_NOT_FOUND', message: 'Generated clip not found.' } });
    if (durableStorage.isDurable) {
      const url = await durableStorage.getDownloadUrl(clip.outputPath, req.query.download === '1' ? clip.outputFilename : undefined);
      if (url) return res.redirect(url);
    }
    const outputPath = resolveClipOutputPath(config.OUTPUT_DIR, job.id, clip.id, clip.outputFilename);
    if (!outputPath) return res.status(404).json({ error: { code: 'CLIP_NOT_FOUND', message: 'Generated clip not found.' } });
    try { accessSync(outputPath, constants.R_OK); }
    catch { return res.status(410).json({ error: { code: 'CLIP_OUTPUT_MISSING', message: 'The generated clip file is no longer available.' } }); }
    res.type('video/mp4');
    if (req.query.download === '1') return res.download(outputPath, clip.outputFilename);
    res.sendFile(outputPath);
  });
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }));
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    req.log.error({ err: error }, 'Request failed');
    const uploadCode = error instanceof multer.MulterError ? error.code : undefined;
    res.status(uploadCode || error.message.startsWith('Only ') ? 400 : 500).json({ error: { code: uploadCode ? 'INVALID_UPLOAD' : 'INTERNAL_ERROR', message: uploadCode === 'LIMIT_FILE_SIZE' ? `Video exceeds the ${maxUploadMb} MB upload limit.` : error.message || 'Unexpected server error.' } });
  });
  const close = async (options?: { dropSchema?: boolean }) => { pipeline.close(); await db.close(options); };
  return { app, db, pipeline, storageStatus, close };
}
