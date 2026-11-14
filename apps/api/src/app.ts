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
import { createTranscriptionEngine } from './engines.js';
import { FaceClipFramer, type ClipFramer } from './face-track.js';
import { ToolchainMonitor, checkToolchain, type ToolchainReport } from './toolchain.js';
import { limitWords, refuseIfFull, refuseIfTooLong, type AdmissionRules, type Refusal, type ServerBusy } from './admission.js';
import { longestListenable, type MeasuredSpeeds } from './estimate.js';
import { forecastFor, loadOf, placeFreesIn, type Forecast, type ForecastSources } from './forecast.js';
import { describeBasis, SpeedBook, type KnownSpeeds } from './speeds.js';
import { automaticThreads, describeThreads, readMachineLimits, type MachineLimits } from './machine.js';
import type { TranscriptionEngine } from './transcription.js';
import { DeterministicHighlightDetector, type HighlightOptions } from './highlights.js';
import { FfmpegClipRenderer, isSafeClipIdentifier, resolveClipOutputPath } from './clips.js';
import { downloadYouTubeVideo } from './youtube.js';
import { KeepAwake } from './keepawake.js';
import { FailedAttemptLimiter, createAccessGate } from './access.js';
import { installAccessGate } from './access-http.js';
import { parseJobOptions } from './options.js';
import { escapeHtml, keptFor, renderDeleteConfirmPage, renderDeletedPage, renderJobPage, renderMessagePage, renderStopConfirmPage, renderUploadPage, type ServerNow } from './pages.js';
import { JobEraser, RetentionSweeper, type RetentionOptions } from './retention.js';
import { PlainFailure, onlyVideos, plainWords } from './failures.js';
import { decideToneMapping, probeToneMapping, type ToneMappingSupport } from './hdr.js';

const acceptedExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const acceptedMimeTypes = new Set(['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm', 'video/x-msvideo', 'video/x-m4v']);

/** The speeds that estimates are worked out from are learned from the latest videos this server finished: this many of them, and none older than this many days (see speeds.ts). */
const SPEED_SAMPLE_JOBS = 10;
const SPEED_SAMPLE_DAYS = 30;

/** What a person is told about an upload that the upload library refused. Its own short words are not repeated: they are not written for people. */
function uploadRefusal(error: multer.MulterError): string {
  if (error.code === 'LIMIT_UNEXPECTED_FILE') return 'Attach one video file using the “video” field.';
  if (error.code === 'LIMIT_FILE_COUNT') return 'Only one video can be uploaded at a time.';
  return 'The upload could not be understood.';
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
  /** What finds a face to follow in a clip: a stand-in for tests, or `null` to switch following off. Production passes nothing and gets the real one (unless FACE_FRAMING_ENABLED says no). */
  framer?: ClipFramer | null;
  /** Isolates the database tables in their own Postgres schema (used by tests). */
  databaseSchema?: string;
  /** How often the keep-awake check runs (default 4 minutes; tests make it fast). */
  keepAwakeIntervalMs?: number;
  /** Where the log lines go (default: the console) and how much is logged (default: LOG_LEVEL, else "info"). Tests read what is logged. */
  logDestination?: { write(line: string): void };
  logLevel?: string;
  /** How long a wrong access code waits before it is answered (default 400 ms; tests make it zero). */
  accessFailureDelayMs?: number;
  /** The longest start-up waits for the look at interrupted jobs before the server opens anyway (default 30 seconds; tests make it short). */
  bootRecoveryWaitMs?: number;
  /** What the check of the video tools does (a stand-in for tests; production passes nothing and gets the real check) and how often it looks whether the server is idle yet. It is given what the real check has to tell the server about the speeds it measured. */
  toolchainCheck?: (hooks: { onMeasured: (speeds: MeasuredSpeeds) => void }) => Promise<ToolchainReport>;
  toolchainRetryMs?: number;
  /** What limits the machine (default: the control group files of the container). It decides how many threads the programs are started with, and is what the start-up check reports. */
  machine?: () => Promise<MachineLimits>;
  /** What the trial of converting HDR colours finds (a stand-in for tests; production passes nothing and FFmpeg is asked, see hdr.ts). Not asked at all when CLIP_TONE_MAP_HDR is off, or is `auto` on a machine with little memory. */
  toneMapping?: () => Promise<ToneMappingSupport>;
  /** When and how the clips that are older than CLIP_RETENTION_DAYS are looked for (default: a minute after the start, then every hour; tests look when they want to). */
  retention?: Partial<Omit<RetentionOptions, 'days'>>;
  /** How fast this server works, as the estimates and the early refusals see it (a stand-in for tests; production passes nothing and it is learned from the finished videos and the start-up check, see speeds.ts). */
  speeds?: () => Promise<KnownSpeeds>;
}

const DEFAULT_BOOT_RECOVERY_WAIT_MS = 30_000;

/** What a person is told, and with which status and code, when a job was not deleted (a job that was deleted needs no words). */
const notDeleted = {
  missing: { status: 404, code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' },
  'not finished': { status: 409, code: 'JOB_NOT_FINISHED', message: 'This video is still being processed. It can be deleted once it is finished, or once you have stopped it.' },
  'storage failed': { status: 503, code: 'DELETE_FAILED', message: 'The files of this video could not be deleted right now, and nothing was removed. Please try again in a moment.' },
} as const;

/** What a person is told, and with which status and code, when asking for a job to be stopped did not stop anything (a job that is stopping needs no words). */
const notStopped = {
  missing: { status: 404, code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' },
  'already over': { status: 409, code: 'JOB_ALREADY_OVER', message: 'This video is already finished, so there is nothing to stop.' },
  'not running here': { status: 409, code: 'JOB_NOT_RUNNING', message: 'This video is not being worked on at this moment (it may be waiting to start again after a restart). Try again in a minute.' },
} as const;

export async function createApp(config: AppConfig, overrides: AppOverrides = {}) {
  const durableStorage = overrides.storage ?? createStorage(config);
  if (config.REQUIRE_DURABLE_STORAGE && !durableStorage.isDurable) {
    throw new Error(`REQUIRE_DURABLE_STORAGE is on but durable storage (Cloudflare R2) is not fully configured. Missing settings: ${missingR2Settings(config).join(', ') || 'none listed'}.`);
  }
  mkdirSync(config.UPLOAD_DIR, { recursive: true });
  mkdirSync(config.TEMP_DIR, { recursive: true });
  mkdirSync(config.OUTPUT_DIR, { recursive: true });
  // Whatever a request carries that proves who it is (the access cookie, the code in a header) or that opens a door (the signed address a clip
  // download is sent on to) stays out of the logs: the request line of every request is logged with its headers.
  const logger = pino({ level: overrides.logLevel ?? process.env.LOG_LEVEL ?? 'info', redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-access-code"]', 'res.headers["set-cookie"]', 'res.headers.location'], censor: '[hidden]' } }, overrides.logDestination);
  // Whether this FFmpeg can convert the colours of HDR video (an iPhone records HDR by default) is found out by trying it, once it is known that the machine is to.
  const tryToneMapping = async (): Promise<ToneMappingSupport> => { try { return await (overrides.toneMapping ?? (() => probeToneMapping(config.FFMPEG_PATH)))(); } catch (error) { return { works: false, detail: error instanceof Error ? error.message : String(error) }; } };
  const accessGate = createAccessGate(config.ACCESS_CODE);
  if (accessGate.enabled) logger.info('An access code is required for every page and every call except /api/health');
  else logger.warn('No ACCESS_CODE is set: anyone who can reach this address can upload videos and see every job. Set ACCESS_CODE (at least 8 characters) before sharing the address.');
  const db = await StudioDatabase.connect(config.DATABASE_URL, overrides.databaseSchema, logger);
  // How much of the machine this process may really use decides how many threads the programs are started with: they count the processors of the
  // host, not the share of them this container has, and threads beyond the share only wait for each other (see machine.ts for what was measured).
  const machineLimits = await (overrides.machine ?? readMachineLimits)().catch(() => undefined);
  const automatic = (most?: number) => (machineLimits ? automaticThreads(machineLimits, most) : undefined);
  const whisperThreads = config.WHISPER_THREADS || automatic(4);
  const clipThreads = config.CLIP_THREADS || automatic();
  logger.info({ processorShare: machineLimits?.cpuLimit ?? null, whisperThreads: whisperThreads ?? null, clipThreads: clipThreads ?? null }, `Threads: ${config.TRANSCRIPTION_ENGINE === 'whisper_cpp' ? `whisper.cpp with ${describeThreads(whisperThreads)}, ` : ''}FFmpeg with ${describeThreads(clipThreads)}${machineLimits?.cpuLimit != null ? ` (this machine may use ${machineLimits.cpuLimit.toFixed(2)} of a processor)` : ''}`);
  // Converting the colours of HDR video needs memory (about 90 MiB more for every clip, see hdr.ts), which the machine may not have: the container's limit, when it has one.
  let toneMapping = false;
  const toneMappingDecision = decideToneMapping(config.CLIP_TONE_MAP_HDR, machineLimits ? (machineLimits.memoryLimitBytes ?? machineLimits.totalMemoryBytes) : null);
  if (!toneMappingDecision.convert) logger.info({ toneMappingDecision }, `HDR video: ${toneMappingDecision.why}. Clips from HDR video are made as ordinary 8-bit pictures that play everywhere, but their colours look flat`);
  else {
    const support = await tryToneMapping();
    toneMapping = support.works;
    if (support.works) logger.info({ toneMapping: support }, `HDR video: its colours are converted to those of an ordinary picture (${support.detail})`);
    else logger.warn({ toneMapping: support }, `HDR video: this FFmpeg cannot convert its colours (${support.detail}). Clips from HDR video are made as ordinary 8-bit pictures that play everywhere, but their colours look flat`);
  }
  const transcriber = overrides.transcriber ?? createTranscriptionEngine(config, whisperThreads);
  const highlightOptions: HighlightOptions = { minDurationSeconds: config.HIGHLIGHT_MIN_DURATION_SECONDS, maxDurationSeconds: config.HIGHLIGHT_MAX_DURATION_SECONDS, maxCandidates: config.HIGHLIGHT_MAX_CANDIDATES, overlapThreshold: config.HIGHLIGHT_OVERLAP_THRESHOLD, weights: { density: config.HIGHLIGHT_WEIGHT_DENSITY, emphasis: config.HIGHLIGHT_WEIGHT_EMPHASIS, question: config.HIGHLIGHT_WEIGHT_QUESTION, number: config.HIGHLIGHT_WEIGHT_NUMBER, contrast: config.HIGHLIGHT_WEIGHT_CONTRAST, hook: config.HIGHLIGHT_WEIGHT_HOOK, completeness: config.HIGHLIGHT_WEIGHT_COMPLETENESS, standalone: config.HIGHLIGHT_WEIGHT_STANDALONE, continuity: config.HIGHLIGHT_WEIGHT_CONTINUITY, length: config.HIGHLIGHT_WEIGHT_LENGTH } };
  const framer: ClipFramer | undefined = overrides.framer === undefined
    ? (config.FACE_FRAMING_ENABLED ? new FaceClipFramer({ ffmpegPath: config.FFMPEG_PATH, outputAspect: config.CLIP_VERTICAL_WIDTH / config.CLIP_VERTICAL_HEIGHT, threads: clipThreads }) : undefined)
    : overrides.framer ?? undefined;
  const renderer = new FfmpegClipRenderer(config.FFMPEG_PATH, config.CLIP_VIDEO_CODEC, config.CLIP_AUDIO_CODEC, config.CLIP_CRF, config.CLIP_PRESET, config.CLIP_VERTICAL_WIDTH, config.CLIP_VERTICAL_HEIGHT, undefined, undefined, clipThreads, toneMapping);
  const ffmpeg = new FfmpegAdapter(config.FFPROBE_PATH, config.FFMPEG_PATH);
  const pipeline = new VideoPipeline(db, ffmpeg, transcriber, new DeterministicHighlightDetector(), highlightOptions, renderer, config.CLIP_MAX_CANDIDATES, config.UPLOAD_DIR, config.TEMP_DIR, config.OUTPUT_DIR, logger, durableStorage, {
    concurrency: config.JOB_CONCURRENCY,
    maxAttempts: config.JOB_MAX_ATTEMPTS,
    staleAfterMs: config.JOB_STALE_AFTER_SECONDS * 1000,
    heartbeatMs: config.JOB_HEARTBEAT_SECONDS * 1000,
    recheckMs: Math.max(1000, config.JOB_STALE_AFTER_SECONDS * 500),
    watchdogMs: Math.max(5000, config.JOB_STALE_AFTER_SECONDS * 3000),
    transcriptCacheDays: config.TRANSCRIPT_CACHE_DAYS,
  }, framer);
  // Forget the transcripts nobody has asked for lately; with 0 days (nothing is to be kept) that is all of them, so switching the cache off also clears it.
  // Best effort: housekeeping must never stop the server from starting.
  db.pruneTranscriptCache(new Date(Date.now() - config.TRANSCRIPT_CACHE_DAYS * 86_400_000).toISOString()).then((removed) => { if (removed) logger.info({ removed }, 'Forgot transcripts that nobody had needed for a while'); }, (error) => logger.warn({ err: error }, 'Could not forget old transcripts'));

  // Clips stay until a person deletes them (the button on the job page, DELETE /api/jobs/:id) or, when CLIP_RETENTION_DAYS is set, until they are that old.
  const eraser = new JobEraser({ db, storage: durableStorage, uploadDir: config.UPLOAD_DIR, outputDir: config.OUTPUT_DIR, logger });
  const retention = new RetentionSweeper({ db, eraser, logger }, { days: config.CLIP_RETENTION_DAYS, ...overrides.retention });
  if (retention.enabled) {
    logger.info({ clipRetentionDays: config.CLIP_RETENTION_DAYS }, `Clips are deleted ${config.CLIP_RETENTION_DAYS} days after their job finished (CLIP_RETENTION_DAYS); jobs that are already older than that are deleted shortly after the start`);
    retention.start();
  } else logger.info('Clips are kept until a person deletes them (CLIP_RETENTION_DAYS is 0)');

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
  const checkingForInterruptedJobs = pipeline.recoverInterruptedJobs().then((recovery) => {
    if (recovery.resumed.length || recovery.failed.length || recovery.waiting) logger.info({ resumedJobIds: recovery.resumed, failedJobIds: recovery.failed, stillOwnedByAnotherProcess: recovery.waiting }, 'Checked for jobs interrupted by a previous process');
  }).catch((error: unknown) => logger.error({ err: error }, 'Checking for jobs interrupted by a previous process failed')); // nobody may be waiting any more, so this must never become an unhandled rejection
  // Deciding what happens to each job takes a moment, but the clean-up that follows talks to the storage service, and a service that is slow
  // or has stopped answering must not keep the whole server shut (a host sees that as a failed start). So start-up waits a little, and the
  // check carries on in the background if it needs longer. Jobs that can be resumed are already running by then.
  const bootWaitMs = overrides.bootRecoveryWaitMs ?? DEFAULT_BOOT_RECOVERY_WAIT_MS;
  let giveUpWaiting: NodeJS.Timeout | undefined;
  const checkFinishedInTime = await Promise.race([
    checkingForInterruptedJobs.then(() => true),
    new Promise<boolean>((resolve) => { giveUpWaiting = setTimeout(() => resolve(false), bootWaitMs); }),
  ]);
  clearTimeout(giveUpWaiting);
  if (!checkFinishedInTime) logger.warn(`The check for interrupted jobs is still running after ${Math.round(bootWaitMs / 1000)} s (most likely the storage service is slow or not answering). The server starts now and the check carries on in the background.`);

  const maxUploadMb = Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024);
  const storage = multer.diskStorage({ destination: config.UPLOAD_DIR, filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`) });
  const upload = multer({ storage, limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 }, fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!acceptedExtensions.has(ext) || (file.mimetype && !acceptedMimeTypes.has(file.mimetype))) return cb(new PlainFailure(onlyVideos, { code: 'INVALID_UPLOAD' }));
    cb(null, true);
  }});
  /** An upload that never became a job (the database was unreachable, say) must not sit on the disk for nothing. */
  const discardUpload = (storedFilename: string | undefined) => (storedFilename ? rm(join(config.UPLOAD_DIR, storedFilename), { force: true }).catch(() => undefined) : Promise.resolve());
  // Requests that are being handled right now (a big upload from a phone can take many minutes). Health checks are left
  // out, so neither Render's own nor the keep-awake request below can make the server look busy all by itself.
  let requestsInFlight = 0;
  // How long a video takes, which is what the estimates and the early refusals are worked out from: learned from the videos this server finished lately, and until it has
  // finished enough of them, from what the start-up check measured (see speeds.ts). Plain sums over measured times: nothing here is a model, and nothing changes how a video is processed.
  const speedBook = new SpeedBook(() => db.listRecentRuns(SPEED_SAMPLE_JOBS, new Date(Date.now() - SPEED_SAMPLE_DAYS * 86_400_000).toISOString()), { onError: (error) => logger.warn({ err: error }, 'Could not read the finished videos to learn how fast this server is') });
  const knownSpeeds = overrides.speeds ?? (() => speedBook.current());
  // What is turned away at the door. A video is turned away for its length only when the engine that listens to it is stopped at a time limit (whisper.cpp is; a hosted service is not).
  const admissionRules: AdmissionRules = { queueLimit: config.JOB_QUEUE_LIMIT || undefined, listeningLimitSeconds: config.TRANSCRIPTION_ENGINE === 'whisper_cpp' ? config.TRANSCRIPTION_TIMEOUT_MS / 1000 : undefined };
  logger.info({ queueLimit: admissionRules.queueLimit ?? null, listeningLimitSeconds: admissionRules.listeningLimitSeconds ?? null }, admissionRules.queueLimit === undefined
    ? 'Any number of videos may wait for their turn (JOB_QUEUE_LIMIT is 0)'
    : `At most ${admissionRules.queueLimit} videos may wait for their turn; a video that arrives when that many already wait is turned away at once (JOB_QUEUE_LIMIT)`);
  const forecastSources: ForecastSources = {
    queue: () => pipeline.queueView(), runState: (jobId) => pipeline.runState(jobId), jobs: (ids) => db.getJobs(ids), speeds: knownSpeeds,
    defaults: { clipCount: config.CLIP_MAX_CANDIDATES, clipSeconds: { min: config.HIGHLIGHT_MIN_DURATION_SECONDS, max: config.HIGHLIGHT_MAX_DURATION_SECONDS } },
  };
  /** The check of the video tools tells what it measured: how fast this server makes a clip (the speed of listening is learned from finished videos only: see speeds.ts). */
  const noteMeasuredSpeeds = (speeds: MeasuredSpeeds) => {
    speedBook.noteMeasured(speeds);
    if (speeds.render !== undefined) logger.info({ renderSpeed: speeds.render }, `The start-up check measured how fast this server makes a clip: ${speeds.render.toFixed(1)} seconds of work for each second of clip.`);
  };
  /** The forecast of a video. Best effort: a page about a video must never fail because an estimate could not be made. */
  const forecastOf = (job: VideoJob): Promise<Forecast | undefined> => forecastFor(job, forecastSources).catch((error: unknown) => { logger.warn({ err: error }, 'Could not work out how long a video takes'); return undefined; });
  /** The answer to a video that arrives when as many already wait as the server takes on (nothing when it takes it). */
  const refuseIfFullNow = async (): Promise<ServerBusy | undefined> => {
    const waiting = pipeline.backlog;
    if (admissionRules.queueLimit === undefined || waiting < admissionRules.queueLimit) return undefined;
    return refuseIfFull(waiting, admissionRules, await placeFreesIn(forecastSources).catch(() => undefined));
  };
  /**
   * Looks at a video that has just arrived and says whether this server takes it: `refusal` is what to tell the person when it does not (it is too long to be listened to in the
   * time allowed, or the server is full), and `seen` is what looking at it showed (its length and size), to be kept with the job. A video that cannot be looked at is taken as it is: the
   * job then fails with words of its own when it is worked on, as before.
   */
  const lookAtArrival = async (storedFilename: string, log: Pick<typeof logger, 'info'>): Promise<{ refusal?: Refusal; seen: { durationSeconds: number | null; width: number | null; height: number | null } }> => {
    const seen = { durationSeconds: null as number | null, width: null as number | null, height: null as number | null };
    try { const { durationSeconds, width, height } = await ffmpeg.probe(join(config.UPLOAD_DIR, storedFilename)); Object.assign(seen, { durationSeconds, width, height }); }
    catch (error) { log.info({ err: error }, 'A video that has just arrived could not be looked at; it is taken as it is'); return { seen }; }
    const refusal = refuseIfTooLong(seen.durationSeconds ?? undefined, (await knownSpeeds()).speeds, admissionRules) ?? await refuseIfFullNow();
    return { ...(refusal ? { refusal } : {}), seen };
  };
  /** What a person at a form is shown when a video is turned away, and what a program is sent. */
  const retryHeader = (res: Response, refusal: Refusal) => { if (refusal.code === 'SERVER_BUSY') res.set('Retry-After', String(refusal.retryAfterSeconds)); };
  const refusalPage = (res: Response, refusal: Refusal) => { retryHeader(res, refusal); return res.status(refusal.status).type('html').send(renderMessagePage(refusal.code === 'SERVER_BUSY' ? 'The server is full' : 'This video is too long', refusal.message, { href: '/test-upload', text: 'Back to the upload page' })); };
  const refusalJson = (res: Response, refusal: Refusal) => { retryHeader(res, refusal); return res.status(refusal.status).json({ error: { code: refusal.code, message: refusal.message } }); };
  /** How busy the server is, and what it turns away, for the upload page and for programs. */
  const serverNow = async (): Promise<ServerNow & { places: number }> => {
    const load = await loadOf(forecastSources); const full = await refuseIfFullNow();
    const limit = admissionRules.listeningLimitSeconds; const known = limit === undefined ? undefined : await knownSpeeds();
    const longest = limit === undefined || !known ? undefined : longestListenable(known.speeds, limit);
    // The longest video that works rests on the same learned speeds as the times do, so what they rest on is told whenever either is.
    const basis = load.basis ?? (longest !== undefined && known ? describeBasis(known) : undefined);
    return {
      running: load.running, waiting: load.waiting, places: load.places,
      ...(load.newVideoStartsInSeconds !== undefined ? { startsInSeconds: load.newVideoStartsInSeconds } : {}), ...(basis ? { basis } : {}),
      ...(full ? { full: { message: full.message } } : {}), ...(limit !== undefined && longest !== undefined ? { longestVideo: { seconds: longest, limit: limitWords(limit) } } : {}),
    };
  };
  /** What the API says of the time of a video: the forecast, with whole seconds. */
  const publicEstimate = (forecast: Forecast) => ({ ...forecast, ...(forecast.startsInSeconds !== undefined ? { startsInSeconds: Math.round(forecast.startsInSeconds) } : {}), ...(forecast.finishesInSeconds !== undefined ? { finishesInSeconds: Math.round(forecast.finishesInSeconds) } : {}) });
  // The check of the video tools is started by whoever starts the server (server.ts), once it is listening: it waits for the server to be
  // idle, because a memory spike on top of a running job could kill a small instance. And once it runs it holds a place for the heavy
  // stages, as a job does, so that a video uploaded meanwhile waits instead of being worked on at the same time as the check.
  const toolchain = new ToolchainMonitor({
    check: () => pipeline.withCapacity(overrides.toolchainCheck ? () => overrides.toolchainCheck!({ onMeasured: noteMeasuredSpeeds }) : (() => checkToolchain({
      ffmpegPath: config.FFMPEG_PATH, ffprobePath: config.FFPROBE_PATH, videoCodec: config.CLIP_VIDEO_CODEC, audioCodec: config.CLIP_AUDIO_CODEC, crf: config.CLIP_CRF, preset: config.CLIP_PRESET,
      workDirectory: config.TEMP_DIR,
      whisper: config.TRANSCRIPTION_ENGINE === 'whisper_cpp' ? { binaryPath: config.WHISPER_CPP_PATH, modelPath: config.WHISPER_MODEL_PATH, ...(whisperThreads ? { threads: whisperThreads } : {}) } : null,
      faceFollowing: framer !== undefined,
      realSamples: config.TOOLCHAIN_REAL_SAMPLES, clipSize: { width: config.CLIP_VERTICAL_WIDTH, height: config.CLIP_VERTICAL_HEIGHT },
      clipThreads, toneMapping, machine: overrides.machine, onMeasured: noteMeasuredSpeeds,
    }))),
    isBusy: () => pipeline.activeJobCount > 0 || requestsInFlight > 0,
    logger,
    retryMs: overrides.toolchainRetryMs,
  });
  /** The page for a job that does not exist (any more): where clips are deleted after a time, it says so, because that is the likeliest reason. */
  const notFoundPage = () => renderMessagePage('Not found', `No job exists for this id.${config.CLIP_RETENTION_DAYS ? ` ${keptFor(config.CLIP_RETENTION_DAYS)}` : ''}`, { href: '/test-upload', text: 'Upload a video' });
  const app = express();
  // On Render the first proxy in front of the server is Render's own: believe it about the visitor's address and about https.
  if (config.RENDER_EXTERNAL_URL) app.set('trust proxy', 1);
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(pinoHttp({ logger }));
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    requestsInFlight += 1;
    // 'close' fires when the response is complete and also when the client goes away halfway.
    res.once('close', () => { requestsInFlight -= 1; });
    next();
  });
  // The access code (when one is set) comes before everything else, so that nothing is read or stored for someone who has not given it.
  installAccessGate(app, {
    gate: accessGate,
    limiter: new FailedAttemptLimiter({ maxFailures: 10, windowMs: 15 * 60_000 }),
    secureCookie: (req) => req.secure || (config.RENDER_EXTERNAL_URL?.startsWith('https://') ?? false),
    failureDelayMs: overrides.accessFailureDelayMs ?? 400,
    logger,
  });
  app.use(express.json({ limit: '32kb' }));

  // The bare address is what people open first and it has no page of its own, so it leads to the upload page instead of an error.
  app.get('/', (_req, res) => res.redirect(302, '/test-upload'));

  app.get('/test-upload', async (_req, res) => {
    // How busy the server is (and what it turns away) is told before a person picks a video; best effort, the page is the same without it.
    const now = await serverNow().catch((error: unknown) => { logger.warn({ err: error }, 'Could not work out how busy the server is'); return undefined; });
    res.type('html').send(renderUploadPage({ ...(now ? { now } : {}), maxUploadMb, defaultClipCount: config.CLIP_MAX_CANDIDATES, retentionDays: config.CLIP_RETENTION_DAYS || undefined, defaultClipSeconds: { min: config.HIGHLIGHT_MIN_DURATION_SECONDS, max: config.HIGHLIGHT_MAX_DURATION_SECONDS }, clipSize: { width: config.CLIP_VERTICAL_WIDTH, height: config.CLIP_VERTICAL_HEIGHT }, faceFraming: framer !== undefined }));
  });

  app.post('/test-upload', (req, res, next) => {
    upload.single('video')(req, res, async (error?: unknown) => {
      if (error) {
        // What is wrong with the upload is told in words meant for a person; anything else (the disk, say) is the server's business and stays in the log.
        const known = error instanceof multer.MulterError || error instanceof PlainFailure;
        const message = error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? `This video is larger than the ${maxUploadMb} MB limit.` : uploadRefusal(error))
          : error instanceof PlainFailure ? error.message : plainWords.server;
        req.log.error({ err: error }, 'Upload failed');
        return res.status(known ? 400 : 500).type('html').send(renderMessagePage('Upload failed', message));
      }
      try {
        if (!req.file) return res.status(400).type('html').send(renderMessagePage('Upload failed', 'No video file was received.'));
        const options = parseJobOptions(req.body);
        if (!options.ok) { await discardUpload(req.file.filename); return res.status(400).type('html').send(renderMessagePage('Upload failed', options.message)); }
        const arrival = await lookAtArrival(req.file.filename, req.log);
        if (arrival.refusal) { await discardUpload(req.file.filename); req.log.info({ code: arrival.refusal.code, videoSeconds: arrival.seen.durationSeconds }, 'A video was turned away'); return refusalPage(res, arrival.refusal); }
        const now = new Date().toISOString();
        const job: NewVideoJob = { id: randomUUID(), originalFilename: req.file.originalname, storedFilename: req.file.filename, mimeType: req.file.mimetype, sizeBytes: req.file.size, status: 'queued', stage: 'queued', errorMessage: null, ...arrival.seen, createdAt: now, updatedAt: now, options: options.options };
        try { await db.createJob(job); } catch (error) { await discardUpload(req.file.filename); throw error; }
        pipeline.enqueue(job.id);
        // Straight to the page that follows the job, instead of a confirmation page with a link to tap.
        res.redirect(303, `/jobs/${job.id}`);
      } catch (error) {
        // A person at a form is shown a page, not the JSON of an API (and not what the database said).
        req.log.error({ err: error }, 'Upload failed');
        res.status(500).type('html').send(renderMessagePage('Upload failed', plainWords.server));
      }
    });
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'short-form-video-studio', storage: storageStatus, access: { codeRequired: accessGate.enabled }, toolchain: config.TOOLCHAIN_CHECK_ENABLED ? toolchain.status : { state: 'disabled', checkedAt: null, failed: [] } }));
  app.post('/api/youtube', async (req, res, next) => {
    try {
      if (!config.COBALT_API_URL) return res.status(503).json({ error: { code: 'YOUTUBE_INGESTION_NOT_CONFIGURED', message: 'YouTube ingestion is not configured on this deployment.' } });
      const youtubeUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!youtubeUrl) return res.status(400).json({ error: { code: 'YOUTUBE_URL_REQUIRED', message: 'Provide a YouTube URL in the “url” field.' } });
      const options = parseJobOptions(req.body);
      if (!options.ok) return res.status(400).json({ error: { code: 'INVALID_OPTIONS', message: options.message } });
      // A server that is full says so before it downloads anything.
      const full = await refuseIfFullNow();
      if (full) { req.log.info({ code: full.code }, 'A video was turned away'); return refusalJson(res, full); }

      const id = randomUUID();
      const now = new Date().toISOString();
      const downloaded = await downloadYouTubeVideo({ youtubeUrl, cobaltUrl: config.COBALT_API_URL, cobaltApiKey: config.COBALT_API_KEY, outputDir: config.UPLOAD_DIR, jobId: id, timeoutMs: config.YOUTUBE_DOWNLOAD_TIMEOUT_MS });
      const arrival = await lookAtArrival(downloaded.storedFilename, req.log);
      if (arrival.refusal) { await discardUpload(downloaded.storedFilename); req.log.info({ code: arrival.refusal.code, videoSeconds: arrival.seen.durationSeconds }, 'A video was turned away'); return refusalJson(res, arrival.refusal); }
      const job: NewVideoJob = { id, originalFilename: downloaded.originalFilename, storedFilename: downloaded.storedFilename, mimeType: downloaded.mimeType, sizeBytes: downloaded.sizeBytes, status: 'queued', stage: 'queued', errorMessage: null, ...arrival.seen, createdAt: now, updatedAt: now, options: options.options };
      try { await db.createJob(job); } catch (error) { await discardUpload(downloaded.storedFilename); throw error; }
      pipeline.enqueue(job.id);
      res.status(202).json({ job, source: 'youtube' });
    } catch (error) { next(error); }
  });

  app.post('/api/jobs', upload.single('video'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: { code: 'VIDEO_REQUIRED', message: 'Attach one video file using the “video” field.' } });
      const options = parseJobOptions(req.body);
      if (!options.ok) { await discardUpload(req.file.filename); return res.status(400).json({ error: { code: 'INVALID_OPTIONS', message: options.message } }); }
      const arrival = await lookAtArrival(req.file.filename, req.log);
      if (arrival.refusal) { await discardUpload(req.file.filename); req.log.info({ code: arrival.refusal.code, videoSeconds: arrival.seen.durationSeconds }, 'A video was turned away'); return refusalJson(res, arrival.refusal); }
      const now = new Date().toISOString();
      const job: NewVideoJob = { id: randomUUID(), originalFilename: req.file.originalname, storedFilename: req.file.filename, mimeType: req.file.mimetype, sizeBytes: req.file.size, status: 'queued', stage: 'queued', errorMessage: null, ...arrival.seen, createdAt: now, updatedAt: now, options: options.options };
      try { await db.createJob(job); } catch (error) { await discardUpload(req.file.filename); throw error; }
      pipeline.enqueue(job.id);
      res.status(202).json({ job });
    } catch (error) { next(error); }
  });
  app.get('/api/jobs/:id', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'No processing job exists for this id.' } });
    const forecast = await forecastOf(job);
    res.json({ job: toPublicJob(job), clips: await db.listClips(job.id), ...(forecast && Object.keys(forecast).length ? { estimate: publicEstimate(forecast) } : {}) });
  });
  // How busy the server is and what it turns away: for programs (the upload page says the same in words). Times are estimates; they are left out when they cannot be told.
  app.get('/api/queue', async (_req, res) => {
    const now = await serverNow();
    res.json({ running: now.running, waiting: now.waiting, places: now.places, queueLimit: admissionRules.queueLimit ?? null, full: now.full !== undefined, ...(now.startsInSeconds !== undefined ? { newVideoStartsInSeconds: Math.round(now.startsInSeconds) } : {}), ...(now.basis ? { basis: now.basis } : {}), ...(now.longestVideo ? { longestVideoSeconds: Math.round(now.longestVideo.seconds) } : {}) });
  });
  // Human-friendly counterpart to the JSON route above: a progress bar while the job runs, and the clips playable on the page
  // (with a big download button each) once it is over. No JavaScript at all -- auto-refresh is a plain <meta> tag, so there is
  // no inline <script> here to ever break again the way /test-upload did.
  app.get('/jobs/:id', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).type('html').send(notFoundPage());
    const forecast = await forecastOf(job);
    res.type('html').send(renderJobPage(job, await db.listClips(job.id), Date.now(), { retentionDays: config.CLIP_RETENTION_DAYS || undefined, stopping: pipeline.isStopping(job.id), ...(forecast ? { forecast } : {}) }));
  });
  // Stopping a job that is being worked on, shaped like deleting one: JSON for the API; for the pages, a link to a page that asks once more and a form that does it.
  app.post('/api/jobs/:id/stop', async (req, res) => {
    const outcome = await pipeline.stop(req.params.id);
    if (outcome === 'stopping') return res.status(202).json({ stopping: true });
    res.status(notStopped[outcome].status).json({ error: { code: notStopped[outcome].code, message: notStopped[outcome].message } });
  });
  app.get('/jobs/:id/stop', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).type('html').send(notFoundPage());
    if (job.status === 'completed' || job.status === 'failed') return res.status(409).type('html').send(renderMessagePage('Already finished', notStopped['already over'].message, { href: `/jobs/${job.id}`, text: 'Back to the video' }));
    res.type('html').send(renderStopConfirmPage(job));
  });
  app.post('/jobs/:id/stop', async (req, res) => {
    const outcome = await pipeline.stop(req.params.id);
    if (outcome === 'stopping') return res.redirect(303, `/jobs/${encodeURIComponent(req.params.id)}`);
    if (outcome === 'missing') return res.status(404).type('html').send(notFoundPage());
    res.status(notStopped[outcome].status).type('html').send(renderMessagePage(outcome === 'already over' ? 'Already finished' : 'Not being worked on', notStopped[outcome].message, { href: `/jobs/${req.params.id}`, text: 'Back to the video' }));
  });
  // Deleting a job: the API answers JSON, the pages need no JavaScript (a link to a page that asks once more, and a form that does it).
  app.delete('/api/jobs/:id', async (req, res) => {
    const outcome = await eraser.erase(req.params.id, 'requested');
    if (outcome === 'erased') return res.status(204).end();
    res.status(notDeleted[outcome].status).json({ error: { code: notDeleted[outcome].code, message: notDeleted[outcome].message } });
  });
  app.get('/jobs/:id/delete', async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).type('html').send(notFoundPage());
    if (job.status !== 'completed' && job.status !== 'failed') return res.status(409).type('html').send(renderMessagePage('Not finished yet', notDeleted['not finished'].message, { href: `/jobs/${job.id}`, text: 'Back to the video' }));
    res.type('html').send(renderDeleteConfirmPage(job));
  });
  app.post('/jobs/:id/delete', async (req, res) => {
    const outcome = await eraser.erase(req.params.id, 'requested');
    if (outcome === 'erased') return res.type('html').send(renderDeletedPage());
    if (outcome === 'missing') return res.status(404).type('html').send(notFoundPage());
    res.status(notDeleted[outcome].status).type('html').send(renderMessagePage('Not deleted', notDeleted[outcome].message, { href: `/jobs/${req.params.id}`, text: 'Back to the video' }));
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
    // What is told is what is wrong with the request, in words written to be read. Whatever else went wrong (the database, the disk, a program, a
    // service) can carry addresses, paths and names that are nobody's business but the operator's, so it is answered in general words and the log has the rest.
    if (error instanceof multer.MulterError) return res.status(400).json({ error: { code: 'INVALID_UPLOAD', message: error.code === 'LIMIT_FILE_SIZE' ? `Video exceeds the ${maxUploadMb} MB upload limit.` : uploadRefusal(error) } });
    if (error instanceof PlainFailure) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    // A request the parser could not read (broken JSON, a body too large, an encoding it does not know) carries its own status, never to be echoed with its own words.
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) return res.status(status).json({ error: { code: 'INVALID_REQUEST', message: status === 413 ? 'The request is too large.' : 'The request could not be understood.' } });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: plainWords.server } });
  });

  // A free Render instance is spun down after 15 minutes without visitors, and a job running for longer than that
  // while nobody watches the page (a locked phone stops the refresh) would be killed. Only on Render (which provides the
  // public address), only while there is work.
  const keepAwake = config.KEEP_AWAKE_WHILE_PROCESSING && config.RENDER_EXTERNAL_URL
    ? new KeepAwake({ publicUrl: config.RENDER_EXTERNAL_URL, intervalMs: overrides.keepAwakeIntervalMs ?? 4 * 60_000, isBusy: () => pipeline.activeJobCount > 0 || requestsInFlight > 0, logger })
    : undefined;
  if (keepAwake) { keepAwake.start(); logger.info({ publicUrl: config.RENDER_EXTERNAL_URL }, 'While a job is processing or an upload is arriving, the instance keeps itself awake'); }

  const close = async (options?: { dropSchema?: boolean }) => { keepAwake?.stop(); toolchain.stop(); pipeline.close(); await retention.stop(); await db.close(options); };
  return { app, db, pipeline, storageStatus, toolchain, retention, close };
}
