# Short-Form Video Studio

Turns a long video into short vertical clips with captions. Upload a video, and the service finds the most promising
passages from the speech in it, cuts them out, reframes them to 9:16 and burns the captions in.

The pipeline is deliberately plain and inspectable: **no proprietary AI API, no invented output.** Speech recognition is a
local `whisper.cpp` model, highlight ranking is a deterministic scoring function over the transcript, and every clip is a
real FFmpeg render of a real time range of the uploaded video. If a stage cannot do its job, the job fails with the reason.

## How a video travels through the system

```
upload ─► job row (Postgres) ─► video copied to Cloudflare R2 ─► ffprobe ─► audio extraction ─► whisper.cpp transcript
      ─► highlight ranking ─► FFmpeg render (9:16 centre crop + burned-in captions) ─► clips uploaded to R2 ─► download link
```

| Piece | What it is |
| --- | --- |
| API | Express + TypeScript (`apps/api`). One process receives uploads **and** runs the jobs. |
| Database | PostgreSQL (Neon in production): jobs, transcripts, highlight candidates, clips. |
| File storage | Cloudflare R2 (S3 API). The uploaded video is kept there while a job is unfinished; finished clips are served from there through short-lived signed links. |
| Speech | `whisper.cpp` on the CPU (`ggml-base.en`, English). |
| Video | `ffprobe` / `ffmpeg`. |
| Pages | The service serves two small phone-friendly pages itself: `/test-upload` (upload form) and `/jobs/<id>` (progress and download links). `apps/web` is a separate React client that is **not** part of the current deployment. |

## Durability and recovery

The free hosting tier this project runs on restarts, redeploys and sleeps, and its disk is wiped every time. Nothing about a
job is allowed to depend on the process or its disk surviving:

1. **The upload is copied to R2 first.** Right after the upload is accepted the video is copied to `sources/<job id>/` in the
   bucket and the copy is verified with a `HEAD` request (stored size must equal the sent size; the transfer is retried up to
   three times). Only then is any CPU spent on it. If the copy cannot be made the job fails immediately and says so.
2. **Running jobs prove they are alive.** Every running job refreshes its database row every `JOB_HEARTBEAT_SECONDS`.
3. **Interrupted jobs are found and resumed.** When the server starts (and again, about every half of `JOB_STALE_AFTER_SECONDS`,
   for as long as some unfinished job still looks like it belongs to another live server, for example during a zero-downtime
   redeploy) it looks for queued/processing jobs that nothing has touched for `JOB_STALE_AFTER_SECONDS`. For each one:
   - started `JOB_MAX_ATTEMPTS` times already → failed for good with an honest message (a video that crashes the server must
     not cause an endless crash loop);
   - its video never reached R2 and is not on this disk → failed with an honest message ("please upload again");
   - otherwise it is taken over with a single atomic database update (two servers can never both take it), the video is
     restored from R2 (size-checked), clips left by the interrupted attempt are discarded, and processing starts again.
4. **Nothing is kept longer than needed.** When a job ends, either way, its stored source video is deleted from R2 and the
   local scratch copies are removed. If the process died or R2 failed at exactly that moment, the next recovery pass deletes
   the leftover. The local copy of a video that is *not* yet safe in R2 is never deleted while its job may still be resumed.
5. **Startup tells the truth about storage.** On boot the server writes a test object to R2, reads it back and deletes it, then
   logs `Durable storage self-test passed` (or a loud error). `GET /api/health` reports the result. With
   `REQUIRE_DURABLE_STORAGE=true` the server refuses to start at all when any R2 setting is missing, instead of quietly falling
   back to the local disk.

Job stages you can see on the status page: `preparing_source`, `saving_source`, `restoring_source`, `waiting_for_capacity`,
`probing_video`, `extracting_audio`, `transcribing`, `detecting_highlights`, `extracting_clips`, `clip_extraction_complete`.

### Honest limits of this design

- **A sleeping free instance does not process anything.** Render's free web services spin down after about 15 minutes without
  inbound traffic and kill whatever is running. The job page refreshes itself every 5 seconds, so a job page that stays open
  (and is not suspended by the phone's browser) keeps the service awake; otherwise the job is resumed from R2 the next time
  anything wakes the service. A paid instance (or a periodic request to `/api/health` from outside) removes this limit.
- **The first moments of an upload are not covered.** The copy to R2 starts right after the upload is accepted and takes time
  proportional to the file size. If the server dies in that window the video exists only on the dying disk, so the job is
  failed with a clear "please upload again" message instead of being resumed.
- **Single instance.** Jobs run inside the API process. `JOB_CONCURRENCY` (default 1) limits how many are in the heavy
  stages at once; a 512 MB instance cannot afford more.
- **A stalled heartbeat is treated as death.** If a live process stopped refreshing its jobs for longer than
  `JOB_STALE_AFTER_SECONDS` (say, a long database outage) another process may take the job over while the first still works on
  it. There is no fencing between them.
- **Clips are kept until deleted.** Source videos are removed after their job; generated clips stay in R2 and the bucket has no
  retention rule. Add a lifecycle rule in the Cloudflare dashboard if clips should expire.

## Prerequisites

- Node.js **22+**.
- PostgreSQL reachable through `DATABASE_URL` (the default points at a local instance on `localhost:5432`).
- FFmpeg, including `ffprobe`, on `PATH` (`sudo apt-get install ffmpeg`, or `brew install ffmpeg`).
- A [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-cli` executable and a GGML model such as `ggml-base.en.bin`
  (`npm run setup:whisper` builds both into `.render/`, which is where the defaults look).
- Cloudflare R2 credentials are optional for local development (see below) and required in production.

## Run locally

```bash
npm install
cp .env.example .env     # then edit it
set -a; . ./.env; set +a # the server reads real environment variables; it does not load .env by itself
npm run dev
```

The API listens on `http://localhost:3001`; open `/test-upload` to upload a video. Without R2 settings the server starts in a
clearly labelled **local-only** mode (`/api/health` says `"backend": "local-only"` and the log carries a warning): videos and
clips stay on the local disk and are lost if that disk is.

Production build: `npm run build` (compiles whisper.cpp, then the apps), then `npm run start --workspace=@studio/api`.

## Tests

```bash
npm test      # needs PostgreSQL (DATABASE_URL) and ffmpeg
npm run check # type check
```

The suite includes end-to-end tests that boot the real application and talk to it over HTTP with a real Postgres database,
real multipart uploads and real FFmpeg/ffprobe; only R2 (kept in memory) and speech recognition (fixed text) are replaced.
They cover: upload → durable copy → clips → signed download; a server killed in the middle of a job and replaced by a fresh
one with an empty disk, which finishes the job from R2; uploads abandoned halfway; uploads above the old 20 MB cap;
refusing to start without R2 when `REQUIRE_DURABLE_STORAGE` is on. CI runs the whole suite on every push and pull request.
What the tests do **not** cover: the real R2 service (checked by the startup self-test instead), real whisper.cpp output,
and large (hundreds of MB) videos on a 512 MB instance.

## Configuration

All configuration comes from environment variables; see [`.env.example`](.env.example). Defaults are in `apps/api/src/config.ts`.

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | API listener. |
| `DATABASE_URL` | PostgreSQL connection string. |
| `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2 (durable storage). All four must be set to enable it. |
| `REQUIRE_DURABLE_STORAGE` | `true` makes startup fail when any R2 setting is missing. Anything other than a clear yes/no is rejected. Default `false`. |
| `JOB_CONCURRENCY` | Jobs allowed in the CPU/memory-heavy stages at once (1–8, default 1). |
| `JOB_MAX_ATTEMPTS` | Times a job may be started in total, the first run included (1–10, default 3). |
| `JOB_STALE_AFTER_SECONDS`, `JOB_HEARTBEAT_SECONDS` | A job untouched for the first value is considered abandoned (default 60); live jobs refresh every second value (default 15, must be at most half of the first). |
| `UPLOAD_DIR`, `TEMP_DIR`, `OUTPUT_DIR` | Local scratch directories (uploads, per-job audio/whisper output, rendered clips). |
| `MAX_UPLOAD_BYTES` | Largest accepted upload (default 2 GiB). The upload page states the limit. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Binary locations when not on `PATH`. |
| `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH`, `TRANSCRIPTION_LANGUAGE`, `TRANSCRIPTION_TIMEOUT_MS` | whisper.cpp command, model, language code (default `en`) and time limit. |
| `CLIP_MAX_CANDIDATES` | Highest-ranked candidates rendered per job (default 3). |
| `CLIP_VERTICAL_WIDTH`, `CLIP_VERTICAL_HEIGHT` | Output size; must be 9:16 (default 1080×1920). |
| `CLIP_VIDEO_CODEC`, `CLIP_AUDIO_CODEC`, `CLIP_CRF`, `CLIP_PRESET` | FFmpeg encoding (defaults `libx264`, `aac`, 23, `veryfast`). |
| `HIGHLIGHT_MIN_DURATION_SECONDS`, `HIGHLIGHT_MAX_DURATION_SECONDS` | Candidate window bounds (20 and 60 s). |
| `HIGHLIGHT_MAX_CANDIDATES`, `HIGHLIGHT_OVERLAP_THRESHOLD` | Ranked candidates kept and overlap suppression threshold. |
| `HIGHLIGHT_WEIGHT_*` | Non-negative scoring weights (density, emphasis, question, number, contrast, hook, completeness). |
| `COBALT_API_URL`, `COBALT_API_KEY`, `YOUTUBE_DOWNLOAD_TIMEOUT_MS` | Optional YouTube ingestion through a separately hosted [Cobalt](https://github.com/imputnet/cobalt) instance. |
| `CORS_ORIGIN` | Allowed web-client origin. |

## API

- `POST /api/jobs` — multipart request with one `video` field. Returns `202` with the job.
- `POST /api/youtube` — JSON `{ "url": "<YouTube URL>" }`; only available when `COBALT_API_URL` is configured.
- `GET /api/jobs/:id` — the job (`status`, `stage`, `attempts`, `errorMessage`, …) and its clips. The internal storage location is never exposed.
- `GET /api/jobs/:id/transcript` — timestamped transcript segments.
- `GET /api/jobs/:id/highlights` — ranked highlight candidates with their scoring signals.
- `GET /api/jobs/:jobId/clips/:clipId` — redirects to a short-lived signed R2 link (add `?download=1` to force a download). In local-only mode the file is streamed from disk.
- `GET /api/health` — `{ status, service, storage: { backend: "r2" | "local-only", selfTest, checkedAt } }`.
- `GET /test-upload`, `POST /test-upload`, `GET /jobs/:id` — the built-in phone-friendly pages.

Accepted extensions: MP4, MOV, MKV, WebM, AVI, M4V. Extension and declared MIME type are checked before a job is created and
`ffprobe` then checks that the file really contains a readable video stream. An upload that is abandoned halfway, or whose job
cannot be created, leaves nothing behind on the disk.

### Deterministic highlight ranking

The detector makes no semantic, LLM or "AI understanding" claim. It enumerates contiguous timestamped transcript windows within
the configured duration bounds, preferring windows that end at sentence punctuation. It clamps each window to the probed video
duration, rejects invalid ranges, scores every window, then suppresses a lower-ranked candidate if it overlaps an accepted one
by at least the configured fraction of the shorter candidate.

The score is a 0–100 weighted average of inspectable signals: transcript word density (normalised at 3 words/second),
emphatic-word count, question punctuation, numeric detail, contrast/turning-point terms, opening-hook phrases, and
start/end sentence-boundary completeness. Every candidate stores its signal values, weights, contributions, human-readable
reasons and source transcript indexes. A later ML/LLM ranker can implement the same `HighlightDetector` interface without
changing the API or the rendering stage.

### Clip rendering

For each highest-ranked candidate (up to `CLIP_MAX_CANDIDATES`) FFmpeg cuts the exact requested range (post-input seeking, so
the range does not depend on source keyframes), **scales the picture to fill 9:16 and crops the centre**, burns in the
transcript segments that fall inside the range as captions, and encodes H.264/AAC with `+faststart`. The crop is fixed to the
centre of the frame: nothing follows faces or speakers. A candidate that fails keeps a failed clip record with its error and
processing continues; the job completes only if at least one clip was made.

## Not implemented

Face or speaker tracking (reframing is a fixed centre crop), semantic or LLM highlight selection, languages other than English
out of the box, user accounts and authentication (**anyone who can reach the service can upload**), per-user quotas, malware
scanning, a separate worker tier, and retention rules for generated clips. YouTube ingestion depends on a third-party Cobalt
service whose availability and terms of use are outside this repository. Operators are responsible for having the right to
process the videos users upload.

## Deployment notes

Currently deployed as one free Render web service (512 MB RAM, `npm install && npm run build`, then
`npm run start --workspace=@studio/api`, health check `/api/health`) with Neon PostgreSQL and a Cloudflare R2 bucket. The build
compiles whisper.cpp from source, so builds take several minutes and are not cached. Set the four `R2_*` variables,
`DATABASE_URL`, and `REQUIRE_DURABLE_STORAGE=true` there. whisper.cpp on a shared CPU takes roughly the duration of the source
media or longer, so long videos need patience (or a bigger instance). For anything beyond a single small instance use
authenticated uploads with quotas, a separate worker tier fed by a durable queue, and resource limits.
