# Short-Form Video Studio

A runnable foundation for an AI-powered short-form video workflow. It accepts a local video upload, persists a processing job, verifies media metadata, and runs local timestamped transcription. It does **not** fabricate highlights, captions, or clips.

## Architecture

- **Web:** React, TypeScript, and Vite (`apps/web`). The browser uploads a video and polls the API for durable job state.
- **API:** Express and TypeScript (`apps/api`). It validates multipart uploads, stores files outside public routes, exposes a small JSON API, logs requests and pipeline failures, and returns actionable errors.
- **Persistence:** SQLite using Node's built-in `node:sqlite` (`data/studio.db` by default). `video_jobs` and `generated_clips` tables are created on startup. For multi-instance deployment, replace this adapter with a PostgreSQL implementation while retaining the domain and pipeline contracts.
- **Media:** `ffprobe` verifies source media, FFmpeg extracts mono 16 kHz WAV audio into a per-job temporary directory, and a replaceable `TranscriptionEngine` adapter invokes local `whisper.cpp`. A replaceable `HighlightDetector` ranks transcript-derived ranges, then a replaceable `ClipRenderer` produces real MP4 files from the best persisted candidates before the job becomes complete.

## Prerequisites

- Node.js **22.5+** (the SQLite adapter uses `node:sqlite`; Node 24 LTS recommended).
- FFmpeg, including `ffprobe`, on `PATH`. On Debian/Ubuntu: `sudo apt-get install ffmpeg`. On macOS with Homebrew: `brew install ffmpeg`.
- A local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-cli` executable and a compatible GGML/GGUF model. Build or install whisper.cpp, download a model such as `ggml-base.en.bin`, then set `WHISPER_CPP_PATH` and `WHISPER_MODEL_PATH` if they are not at the defaults.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The API starts at `http://localhost:3001`.

To run production builds:

```bash
npm run build
npm run start --workspace=@studio/api
# Serve apps/web/dist with a static web server/reverse proxy.
```

## Configuration

All runtime configuration is environment-based; see [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | API listener configuration. |
| `DATABASE_PATH` | SQLite database location. |
| `UPLOAD_DIR` | Non-public directory for source uploads. |
| `MAX_UPLOAD_BYTES` | Maximum accepted upload size (default: 2 GiB). |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Absolute command paths when binaries are not on `PATH`. |
| `TEMP_DIR` | Parent directory for per-job audio and whisper output; cleaned after every job. |
| `TRANSCRIPTION_ENGINE` | Local engine identifier (currently `whisper_cpp`). |
| `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH` | whisper.cpp command and local model file. |
| `TRANSCRIPTION_LANGUAGE` | Whisper language code; default is `en`. |
| `TRANSCRIPTION_TIMEOUT_MS` | Maximum local transcription duration; default is one hour. |
| `OUTPUT_DIR` | Private filesystem root for generated MP4 output; each job receives its own UUID directory. |
| `CLIP_MAX_CANDIDATES` | Maximum ranked highlight candidates rendered to MP4 per job; default is 3. |
| `CLIP_VIDEO_CODEC`, `CLIP_AUDIO_CODEC`, `CLIP_CRF`, `CLIP_PRESET` | FFmpeg MP4 encoding settings; defaults prioritize browser compatibility (`libx264` + `aac`) and reliable output. |
| `HIGHLIGHT_MIN_DURATION_SECONDS`, `HIGHLIGHT_MAX_DURATION_SECONDS` | Inclusive candidate-window duration bounds (20 and 60 seconds by default). |
| `HIGHLIGHT_MAX_CANDIDATES`, `HIGHLIGHT_OVERLAP_THRESHOLD` | Maximum ranked ranges and suppression threshold based on overlap relative to the shorter range. |
| `HIGHLIGHT_WEIGHT_DENSITY`, `HIGHLIGHT_WEIGHT_EMPHASIS`, `HIGHLIGHT_WEIGHT_QUESTION`, `HIGHLIGHT_WEIGHT_NUMBER`, `HIGHLIGHT_WEIGHT_CONTRAST`, `HIGHLIGHT_WEIGHT_HOOK`, `HIGHLIGHT_WEIGHT_COMPLETENESS` | Non-negative deterministic baseline scoring weights. |
| `CORS_ORIGIN` | Allowed web application origin. |

## API

- `POST /api/jobs` — multipart request with one `video` field. Returns `202` with a job.
- `GET /api/jobs/:id` — returns the job and any generated clips.
- `GET /api/jobs/:id/transcript` — returns timestamped transcript segments for the job.
- `GET /api/jobs/:id/highlights` — returns ranked transcript-derived highlight candidates; it does not return media files.
- `GET /api/jobs/:jobId/clips/:clipId` — streams a completed MP4 owned by that job; add `?download=1` to download it.
- `GET /api/health` — service health endpoint.

The accepted extensions are MP4, MOV, MKV, WebM, AVI, and M4V. Extension and declared MIME type are validated before a job is created; `ffprobe` then validates the actual readable video stream.

## Current capability and intentional limits

**Works now:** local disk upload handling with size/type limits, durable job records, asynchronous job state changes, real `ffprobe` media verification, FFmpeg audio extraction, local whisper.cpp timestamped transcription, deterministic transcript-derived highlight ranking, and real FFmpeg MP4 extraction from persisted candidates. SQLite stores transcript/candidate/clip lifecycle records, and the UI can play/download completed clips. A transcription, highlight-detection, or all-clips extraction failure leaves a durable failed job with the underlying stage error; no transcript text, candidate range, or generated media is invented.

### Deterministic highlight ranking

The baseline detector makes no semantic, LLM, or “AI understanding” claim. It enumerates contiguous timestamped transcript windows within the configured duration bounds, preferring windows that end at sentence punctuation. It clamps each window to the probed video duration, rejects invalid ranges, scores every window, then suppresses a lower-ranked candidate if it overlaps an accepted candidate by at least the configured fraction of the shorter candidate.

Score is a 0–100 weighted average of inspectable normalized signals: transcript word density (normalized at 3 words/second), emphatic-word count, question punctuation, numeric-detail presence, contrast/turning-point terms, opening hook phrases, and start/end sentence-boundary completeness. Every candidate stores its signal values, configured weights, weighted contributions, human-readable reasons, and source transcript indexes. For example, contiguous transcript segments that span 22 seconds, start with “Here is…”, contain “42 percent” and “but”, and end on a sentence boundary receive contributions from hook, number, contrast, density, and completeness—not a fabricated semantic score.

A later ML/LLM ranker can implement the same `HighlightDetector` interface and persist the same candidate contract without changing the API, frontend, or future FFmpeg extraction stage.

### Clip extraction

For each highest-ranked persisted candidate (up to `CLIP_MAX_CANDIDATES`), the pipeline creates a `generated_clips` record, then uses FFmpeg with the source as input, post-input `-ss <start>` seeking, and `-t <duration>`. It maps the primary video stream plus optional audio, encodes H.264/AAC into MP4, and uses `+faststart` for browser playback. Post-input seeking re-encodes the exact requested range rather than depending on source keyframes; FFmpeg streams the source and does not load it entirely into memory. The renderer validates that a non-empty output file exists before the clip becomes `completed`.

Files are written only beneath `OUTPUT_DIR/<job UUID>/<clip UUID>.mp4`; the database stores a relative output key and the API verifies job/clip ownership and UUID filenames before serving it. A failed candidate retains a failed clip record and its error, incomplete output is removed, and processing continues to the next candidate. The overall job completes only if at least one clip completed; it fails when no candidate exists or every extraction failed.

Manual smoke test with a local MP4 and installed dependencies:

```bash
cp .env.example .env
# Set WHISPER_CPP_PATH and WHISPER_MODEL_PATH to a working local whisper.cpp installation.
npm install
npm run dev
# Open http://localhost:5173, upload a spoken local MP4, wait for clip extraction,
# then play a generated clip or use its Download MP4 action.
```

**Not implemented yet:** vertical reframing, subtitles, face/speaker tracking, YouTube URL ingestion, proprietary AI APIs, remote/object output storage, user authentication, malware scanning, distributed workers/queues, and PostgreSQL. Generated files currently consume local `OUTPUT_DIR` disk and are not managed by retention/quotas; the UI distinguishes real clip output from candidate ranges.

## Deployment notes

This is suitable as a single-instance MVP foundation. whisper.cpp runs locally and requires no proprietary API, but CPU-only transcription can take roughly the duration of the source media or longer depending on model and hardware. Budget model memory (hundreds of MB to multiple GB), temporary disk for 16 kHz WAV audio (about 115 MB/hour), source/output disk, and a worker time limit. For production at scale, use object storage for uploads/results, PostgreSQL, a durable queue and worker process, authenticated upload authorization, per-user quotas, virus scanning, worker resource limits, and FFmpeg-capable compute. Video processing is CPU, memory, disk, and bandwidth intensive; the API process should not be used as the long-term worker tier.
