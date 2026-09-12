import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import type { AppConfig } from './config.js';
import { StudioDatabase } from './database.js';
import type { VideoJob } from './domain.js';
import { FfmpegAdapter } from './ffmpeg.js';
import { VideoPipeline } from './pipeline.js';
import { createTranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector, type HighlightOptions } from './highlights.js';
import { FfmpegClipRenderer, isSafeClipIdentifier, resolveClipOutputPath } from './clips.js';

const acceptedExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const acceptedMimeTypes = new Set(['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm', 'video/x-msvideo', 'video/x-m4v']);

export function createApp(config: AppConfig) {
  mkdirSync(config.UPLOAD_DIR, { recursive: true });
  mkdirSync(config.TEMP_DIR, { recursive: true });
  mkdirSync(config.OUTPUT_DIR, { recursive: true });
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const db = new StudioDatabase(config.DATABASE_PATH);
  const transcriber = createTranscriptionEngine(config);
  const highlightOptions: HighlightOptions = { minDurationSeconds: config.HIGHLIGHT_MIN_DURATION_SECONDS, maxDurationSeconds: config.HIGHLIGHT_MAX_DURATION_SECONDS, maxCandidates: config.HIGHLIGHT_MAX_CANDIDATES, overlapThreshold: config.HIGHLIGHT_OVERLAP_THRESHOLD, weights: { density: config.HIGHLIGHT_WEIGHT_DENSITY, emphasis: config.HIGHLIGHT_WEIGHT_EMPHASIS, question: config.HIGHLIGHT_WEIGHT_QUESTION, number: config.HIGHLIGHT_WEIGHT_NUMBER, contrast: config.HIGHLIGHT_WEIGHT_CONTRAST, hook: config.HIGHLIGHT_WEIGHT_HOOK, completeness: config.HIGHLIGHT_WEIGHT_COMPLETENESS } };
  const renderer = new FfmpegClipRenderer(config.FFMPEG_PATH, config.CLIP_VIDEO_CODEC, config.CLIP_AUDIO_CODEC, config.CLIP_CRF, config.CLIP_PRESET, config.CLIP_VERTICAL_WIDTH, config.CLIP_VERTICAL_HEIGHT);
  const pipeline = new VideoPipeline(db, new FfmpegAdapter(config.FFPROBE_PATH, config.FFMPEG_PATH), transcriber, new DeterministicHighlightDetector(), highlightOptions, renderer, config.CLIP_MAX_CANDIDATES, config.UPLOAD_DIR, config.TEMP_DIR, config.OUTPUT_DIR, logger);
  const storage = multer.diskStorage({ destination: config.UPLOAD_DIR, filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`) });
  const upload = multer({ storage, limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 }, fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!acceptedExtensions.has(ext) || (file.mimetype && !acceptedMimeTypes.has(file.mimetype))) return cb(new Error('Only MP4, MOV, MKV, WebM, AVI, and M4V video files are accepted.'));
    cb(null, true);
  }});
  const app = express();
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '32kb' }));
  app.get('/test-upload', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Video Processing Test</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px}button{padding:10px 16px;margin-top:12px}pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f5;padding:12px;border-radius:8px}</style></head><body><h1>Video Processing Test</h1><p>Temporary mobile test page.</p><input id="video" type="file" accept="video/*"><br><button id="upload" type="button">Upload video</button><pre id="out">Choose a video, then tap Upload video.</pre><script>const video=document.getElementById('video');const out=document.getElementById('out');const button=document.getElementById('upload');let busy=false;async function readResponse(r){const text=await r.text();if(!text)return {error:{code:'EMPTY_RESPONSE',message:'The server closed the upload request without returning a response.'}};try{return JSON.parse(text)}catch{return {error:{code:'NON_JSON_RESPONSE',message:'The server returned an unexpected response.',raw:text.slice(0,500)}}}}async function uploadVideo(){if(busy)return;const file=video.files&&video.files[0];if(!file){out.textContent='Please choose a video first.';return}busy=true;button.disabled=true;out.textContent='Uploading '+(file.size/1024/1024).toFixed(1)+' MB...';const data=new FormData();data.append('video',file);try{const r=await fetch('/api/jobs',{method:'POST',body:data});const j=await readResponse(r);if(!r.ok||j.error){out.textContent=JSON.stringify(j,null,2);return}const id=j.job.id;out.textContent='Upload complete. Job: '+id+'\n\nProcessing...';async function poll(){try{const sr=await fetch('/api/jobs/'+id);const sj=await readResponse(sr);out.textContent=JSON.stringify(sj,null,2);if(sj.job&&sj.job.status!=='completed'&&sj.job.status!=='failed'){setTimeout(poll,3000)}}catch(err){out.textContent='Polling failed: '+String(err)}}setTimeout(poll,1000)}catch(err){out.textContent='Upload failed: '+String(err)}finally{busy=false;button.disabled=false}}button.addEventListener('click',uploadVideo);</script></body></html>`);
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'short-form-video-studio' }));
  app.post('/api/jobs', upload.single('video'), (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: { code: 'VIDEO_REQUIRED', message: 'Attach one video file using the “video” field.' } });
      const now = new Date().toISOString();
      const job: VideoJob = { id: randomUUID(), originalFilename: req.file.originalname, storedFilename: req.file.filename, mimeType: req.file.mimetype, sizeBytes: req.file.size, status: 'queued', stage: 'queued', errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: now, updatedAt: now };
      db.createJob(job); pipeline.enqueue(job.id);
      res.status(202).json({ job });
    } catch (error) { next(error); }
  });
  app.get('/api/jobs/:id', (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' } });
    res.json({ job, clips: db.listClips(job.id) });
  });
  app.get('/api/jobs/:id/transcript', (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' } });
    res.json({ jobId: job.id, status: job.status, stage: job.stage, segments: db.listTranscript(job.id) });
  });
  app.get('/api/jobs/:id/highlights', (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' } });
    res.json({ jobId: job.id, status: job.status, stage: job.stage, candidates: db.listHighlights(job.id) });
  });
  app.get('/api/jobs/:jobId/clips/:clipId', (req, res) => {
    if (!isSafeClipIdentifier(req.params.jobId) || !isSafeClipIdentifier(req.params.clipId)) return res.status(404).json({ error: { code: 'CLIP_NOT_FOUND', message: 'Generated clip not found.' } });
    const job = db.getJob(req.params.jobId); const clip = job && db.getClip(job.id, req.params.clipId);
    if (!job || !clip || clip.status !== 'completed' || clip.outputFilename !== `${clip.id}.mp4`) return res.status(404).json({ error: { code: 'CLIP_NOT_FOUND', message: 'Generated clip not found.' } });
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
    res.status(uploadCode || error.message.startsWith('Only ') ? 400 : 500).json({ error: { code: uploadCode ? 'INVALID_UPLOAD' : 'INTERNAL_ERROR', message: uploadCode === 'LIMIT_FILE_SIZE' ? `Video exceeds the ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit.` : error.message || 'Unexpected server error.' } });
  });
  return { app, db };
}