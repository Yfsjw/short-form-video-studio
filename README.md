# Short-Form Video Studio

Turns a long video into short clips with captions, vertical (9:16) unless another shape is chosen. Upload a video, and the service finds the most promising
passages from the speech in it, cuts them out, reframes them to the chosen shape and burns the captions in.

The pipeline is deliberately plain and inspectable: **no proprietary AI API, no invented output.** Speech recognition is a
local `whisper.cpp` model, highlight ranking is a deterministic scoring function over the transcript, and every clip is a
real FFmpeg render of a real time range of the uploaded video. If a stage cannot do its job, the job fails with the reason.

## How a video travels through the system

```
upload ─► job row (Postgres) ─► video copied to Cloudflare R2 ─► ffprobe ─► audio extraction ─► whisper.cpp transcript (or the one kept from the same sound)
      ─► highlight ranking ─► (optional: look for a face to follow) ─► FFmpeg render (crop to the chosen shape + burned-in captions) ─► clips uploaded to R2 ─► download link
```

| Piece | What it is |
| --- | --- |
| API | Express + TypeScript (`apps/api`). One process receives uploads **and** runs the jobs. |
| Database | PostgreSQL (Neon in production): jobs, transcripts, highlight candidates, clips. |
| File storage | Cloudflare R2 (S3 API). The uploaded video is kept there while a job is unfinished; finished clips are served from there through short-lived signed links. |
| Speech | `whisper.cpp` on the CPU (`ggml-base.en`, English). |
| Video | `ffprobe` / `ffmpeg`. |
| Pages | The service serves two small phone-friendly pages itself, with no JavaScript: `/test-upload` (upload form with a few options) and `/jobs/<id>` (a progress bar while the job runs; the clips playable on the page, each with a download button, once it is done). An upload leads straight to its `/jobs/<id>` page. `apps/web` is a separate React client that is **not** part of the current deployment. |

## Durability and recovery

The free hosting tier this project runs on restarts, redeploys and sleeps, and its disk is wiped every time. Nothing about a
job is allowed to depend on the process or its disk surviving:

1. **The upload is copied to R2 first.** Right after the upload is accepted the video is copied to `sources/<job id>/` in the
   bucket and the copy is verified with a `HEAD` request (stored size must equal the sent size; the transfer is retried up to
   three times). Only then is any CPU spent on it. If the copy cannot be made the job fails immediately and says so. Every call
   to R2 is abandoned after 15 seconds without a connection or 60 seconds of complete silence (the limit is on silence, not on
   duration, so a slow but live transfer of a big video is never cut off); without that, a connection that stalls would leave a
   job waiting for ever while its heartbeat made it look alive. Calls are retried, so against an R2 that accepts connections but
   never answers, an upload or a delete gives up after roughly three minutes and a download after roughly nine (the number of
   attempts was measured; the times follow from the limits): a slow, honest failure, never an endless wait.
2. **Running jobs prove they are alive.** Every running job refreshes its database row every `JOB_HEARTBEAT_SECONDS`.
3. **Interrupted jobs are found and resumed.** When the server starts, and afterwards for as long as the process lives (every
   half of `JOB_STALE_AFTER_SECONDS` while some unfinished job still looks like it belongs to another live server, for example
   during a zero-downtime redeploy; otherwise every three times `JOB_STALE_AFTER_SECONDS`, which also catches a job that the old
   server accepted after the new one had done its start-up check and was then shut down), it looks for queued/processing jobs
   that nothing has touched for `JOB_STALE_AFTER_SECONDS`. For each one:
   - started `JOB_MAX_ATTEMPTS` times already → failed for good with an honest message (a video that crashes the server must
     not cause an endless crash loop);
   - its video never reached R2 and is not on this disk → failed with an honest message ("please upload again");
   - otherwise it is taken over with a single atomic database update (two servers can never both take it), the video is
     restored from R2 (size-checked; a transfer that breaks is retried up to three times), clips left by the interrupted
     attempt are discarded, and processing starts again from the beginning. If R2 cannot be read at that moment the job is
     **not** failed (that would delete the only copy of the customer's video for a problem that probably passes): the attempt
     is abandoned like one whose server died, the job shows the stage `waiting_to_retry`, and it is tried again a little later,
     within the same `JOB_MAX_ATTEMPTS`. Only an object that R2 says is gone fails the job.
4. **Nothing is kept longer than needed.** When a job ends, either way, its stored source video is deleted from R2 and the
   local scratch copies are removed. If the process died or R2 failed at exactly that moment, the next recovery pass deletes
   the leftover. The local copy of a video that is *not* yet safe in R2 is never deleted while its job may still be resumed.
5. **Startup tells the truth about storage.** On boot the server writes a test object to R2, reads it back and deletes it, then
   logs `Durable storage self-test passed` (or a loud error). `GET /api/health` reports the result. With
   `REQUIRE_DURABLE_STORAGE=true` the server refuses to start at all when any R2 setting is missing, instead of quietly falling
   back to the local disk.
6. **Start-up never waits long for R2.** Resuming a job needs only the database; deleting the stored videos of jobs that were
   given up on or had already finished comes afterwards and is the one step that talks to R2. Start-up waits for it for at most
   30 seconds, then logs a warning and opens the server while the clean-up carries on in the background. A slow or silent R2
   can delay a clean-up, but not the opening of the server (a host treats a server that does not open as a failed start) and not
   the resuming of other jobs.
7. **The database is expected to fail too.** The start-up schema check takes no lock on the tables when they are already up to
   date (tested against the lock every open write holds), so a new server starting during a zero-downtime deploy does not queue
   behind the old server's open transactions; and a connection that the database cuts in the middle of a transaction fails
   that one request instead of ending the process.

Job stages you can see on the status page: `preparing_source`, `saving_source`, `restoring_source`, `waiting_for_capacity`,
`waiting_to_retry`, `probing_video`, `extracting_audio`, `transcribing`, `detecting_highlights`, `extracting_clips`, `clip_extraction_complete`.

### Honest limits of this design

- **A sleeping free instance does not process anything.** Render's free web services spin down after about 15 minutes without
  inbound traffic and kill whatever is running. Two things try to prevent that while there is work: the job page refreshes
  itself every 5 seconds (but a locked phone stops it), and the server itself requests its own `/api/health` at its public
  address (`RENDER_EXTERNAL_URL`, which Render provides) every 4 minutes **only while a job is being processed or an upload is
  arriving**, and stops when the work is done (`KEEP_AWAKE_WHILE_PROCESSING=false` switches it off). That an idle free instance
  really does fall asleep is confirmed by Render's own logs of this service (after each deploy they stop about 15 minutes later,
  with no failure in between, although Render's health check runs every few seconds). Render does not document whether a request
  a service makes to itself counts as inbound traffic, so **whether the keep-awake request really prevents the spin-down has to be
  measured on the live service and has not been**. If it does not work, nothing is lost: the job is resumed from R2 the next time
  anything wakes the service. A paid instance removes the limit for certain.
- **The first moments of an upload are not covered.** The copy to R2 starts right after the upload is accepted and takes time
  proportional to the file size. If the server dies in that window the video exists only on the dying disk, so the job is
  failed with a clear "please upload again" message instead of being resumed.
- **Single instance.** Jobs run inside the API process. `JOB_CONCURRENCY` (default 1) limits how many are in the heavy
  stages at once; a 512 MB instance cannot afford more.
- **A stalled heartbeat is treated as death.** If a live process stopped refreshing its jobs for longer than
  `JOB_STALE_AFTER_SECONDS` (say, a long database outage) another process may take the job over while the first still works on
  it. There is no fencing between them.
- **A resumed job starts again from the beginning.** Clips made by an interrupted attempt are thrown away rather than reused:
  that is simpler and cannot mix the output of two attempts, at the price of repeating work after every interruption. The
  transcript is the exception: it is the longest stage and it is kept as soon as it exists, so what a restart repeats is the
  rendering, not the listening (see [Not listening twice](#not-listening-twice); this holds for engines that can be cached and
  while `TRANSCRIPT_CACHE_DAYS` is above 0).
- **A database that goes silent is not timed out.** node-postgres has no default timeout for connections or queries and none is
  configured here. A connection the database *closes* is handled (see point 7 above); one that is accepted and then never
  answered would stall the request or job that uses it.
- **Clips are kept until deleted.** Source videos are removed after their job; generated clips stay in R2 and the bucket has no
  retention rule. Add a lifecycle rule in the Cloudflare dashboard if clips should expire.

### What the free instance has actually done

One real video, uploaded from a phone on 15 October 2026: 45 seconds, 1080×1920, 28.1 MB. It reached R2 within seconds and went
from the saved upload to the finished clip (one highlight, one clip) in 10 minutes 51 seconds, about 14 times the length of the
video. Render's metrics for that run: the CPU was at or close to its limit for ten minutes in a row (every minute averaged 0.13–0.15 of
the 0.15 limit, while Render's documentation lists the free plan as 0.1 CPU), and memory peaked at about 475 MiB of the 512 MiB
limit (93%). Memory was about 80 MB before the job and about 187 MB for the 15 minutes after it, so it did not return to its
starting level; whether a second job right after the first still fits has not been tested.

This is one sample, not a benchmark, and it was a short video: longer, larger or higher-resolution videos, and back-to-back jobs,
have not been tried. What it does show is that the free instance is good for demonstrations with short videos and not for
customers. Render's documentation (October 2026) lists these web service sizes: Starter 0.5 CPU / 512 MB, Standard 1 CPU / 2 GB,
Pro 2 CPU / 4 GB. Starter has the same memory as the free plan, so it would not relieve the memory pressure; prices are on
render.com/pricing.

The start-up check of the video tools (see "Start-up check of the video tools") ran on the live service on 24 October 2026 and passed all
eleven of its checks in 19.2 seconds: FFmpeg and ffprobe `5.1.9-0+deb12u1` (the host is Debian 12), the `libx264` and `aac` encoders, all
six filters, the bundled caption font actually in use (not one installed on the server), whisper.cpp with a 57 MB model, and tiny real
clips showing that captions are drawn (160 bright points), that the whole-picture layout shows the whole picture, that the crop window
moves, and that the face follower follows the portrait of the test video across the picture (seen in 100% of the moments checked). That
shows the tools the clips need exist and behave on that host, on three-second test clips. It says nothing about how fast a customer's
video is made there (see above).

## Prerequisites

- Node.js **22+**.
- PostgreSQL reachable through `DATABASE_URL` (the default points at a local instance on `localhost:5432`).
- FFmpeg, including `ffprobe`, on `PATH` (`sudo apt-get install ffmpeg`, or `brew install ffmpeg`). CI runs the whole test suite on
  FFmpeg 5.1 (a Debian 12 container, the version Render's server has), 6.1 and 8.
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
refusing to start without R2 when `REQUIRE_DURABLE_STORAGE` is on; the keep-awake request being made while a job runs or an
upload arrives and not otherwise; a server that still opens, and still resumes other jobs, when R2 has stopped answering during
start-up; the real AWS SDK giving up on a server that accepts a connection and never answers (with the short limits the tests
use and with the 6 s-and-over route production uses); the database cutting a connection in the middle of a transaction.
CI runs the whole suite on every push and pull request.
The face-following tests run the real detector and the real FFmpeg on videos made from one test photograph
(`apps/api/test-assets`, with where it comes from).
What the tests do **not** cover: the real R2 service (checked by the startup self-test instead), real whisper.cpp output,
large (hundreds of MB) videos on a 512 MB instance, whether Render really counts the keep-awake request as traffic, and face
following on recordings of real people.

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
| `KEEP_AWAKE_WHILE_PROCESSING` | `false` stops the server from requesting its own `/api/health` while work is in progress (default `true`; only active when `RENDER_EXTERNAL_URL` is set). Anything other than a clear yes/no is rejected. |
| `RENDER_EXTERNAL_URL` | Set by Render itself to the service's public address; not something to configure by hand. A missing or malformed value just disables the keep-awake request. |
| `UPLOAD_DIR`, `TEMP_DIR`, `OUTPUT_DIR` | Local scratch directories (uploads, per-job audio/whisper output, rendered clips). |
| `MAX_UPLOAD_BYTES` | Largest accepted upload (default 2 GiB). The upload page states the limit. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Binary locations when not on `PATH`. |
| `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH`, `TRANSCRIPTION_LANGUAGE`, `TRANSCRIPTION_TIMEOUT_MS` | whisper.cpp command, model, language code (default `en`) and time limit. |
| `TRANSCRIPTION_ENGINE` | `whisper_cpp` (default, runs on this machine) or `openai_compatible` (a hosted service, see [Faster speech recognition](#faster-speech-recognition-with-a-hosted-service-optional)). |
| `TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_API_MODEL` | Only for `openai_compatible`: the service's base address (ending in `/v1`), its key (never logged, never shown in a message) and the model (default `whisper-1`). The address and key are required when that engine is chosen. |
| `TRANSCRIPTION_CHUNK_SECONDS`, `TRANSCRIPTION_API_CONCURRENCY`, `TRANSCRIPTION_API_TIMEOUT_MS` | Only for `openai_compatible`: about how many seconds of audio go in one request (default 600), how many requests run at once (default 3) and the time limit of one request (default 300000 ms). |
| `TRANSCRIPT_CACHE_DAYS` | How many days the transcript of a sound is kept after it was last used, so that the same video is not listened to twice (0–365, default 30; `0` keeps nothing and clears what was kept the next time the server starts). See [Not listening twice](#not-listening-twice). |
| `CLIP_MAX_CANDIDATES` | Highest-ranked candidates rendered per job (default 3). |
| `CLIP_VERTICAL_WIDTH`, `CLIP_VERTICAL_HEIGHT` | Output size of a vertical clip; must be 9:16 (default 1080×1920). The other shapes are worked out from it (see `aspect` under [Job options](#job-options)). |
| `CLIP_VIDEO_CODEC`, `CLIP_AUDIO_CODEC`, `CLIP_CRF`, `CLIP_PRESET` | FFmpeg encoding (defaults `libx264`, `aac`, 23, `veryfast`). |
| `FACE_FRAMING_ENABLED` | `false` removes the "Follow a face" choice from the upload page and makes every clip be cut from the middle (default `true`; a person still has to choose it per video). Anything other than a clear yes/no is rejected. See [Following a face](#following-a-face-beta-opt-in). |
| `TOOLCHAIN_CHECK_ENABLED` | `false` switches off the start-up check of the video tools (default `true`). See [Start-up check of the video tools](#start-up-check-of-the-video-tools). Anything other than a clear yes/no is rejected. |
| `HIGHLIGHT_MIN_DURATION_SECONDS`, `HIGHLIGHT_MAX_DURATION_SECONDS` | Candidate window bounds (20 and 60 s). |
| `HIGHLIGHT_MAX_CANDIDATES`, `HIGHLIGHT_OVERLAP_THRESHOLD` | Ranked candidates kept and overlap suppression threshold (default 0.3: two clips may share at most 30 % of the shorter one, so the clips are different moments). |
| `HIGHLIGHT_WEIGHT_*` | Non-negative scoring weights (density, emphasis, question, number, contrast, hook, completeness, standalone, continuity, length). |
| `COBALT_API_URL`, `COBALT_API_KEY`, `YOUTUBE_DOWNLOAD_TIMEOUT_MS` | Optional YouTube ingestion through a separately hosted [Cobalt](https://github.com/imputnet/cobalt) instance. |
| `CORS_ORIGIN` | Allowed web-client origin. |
| `ACCESS_CODE` | Optional shared access code (at least 8 characters; a shorter one stops the server from starting). When set, everything except `/api/health` asks for it: people type it once on `/login` and get a 30-day cookie, programs send it as `Authorization: Bearer <code>`. Unset or blank means open to anyone, as before. See [The access code](#the-access-code-optional). |

## API

- `POST /api/jobs` — multipart request with one `video` field and, optionally, the job options below. Returns `202` with the job. An option that is not allowed is refused with `400` (`INVALID_OPTIONS`) before anything is stored.
- `POST /api/youtube` — JSON `{ "url": "<YouTube URL>" }` (the job options below can be added); only available when `COBALT_API_URL` is configured.
- `GET /api/jobs/:id` — the job (`status`, `stage`, `progress`, `stageTimings`, `options`, `attempts`, `errorMessage`, …) and its clips. The internal storage location is never exposed.
- `GET /api/jobs/:id/transcript` — timestamped transcript segments.
- `GET /api/jobs/:id/highlights` — ranked highlight candidates with their scoring signals.
- `GET /api/jobs/:jobId/clips/:clipId` — redirects to a short-lived signed R2 link (add `?download=1` to force a download). In local-only mode the file is streamed from disk.
- `GET /api/health` — `{ status, service, storage: { backend: "r2" | "local-only", selfTest, checkedAt }, access: { codeRequired }, toolchain: { state, checkedAt, failed } }`. Always open, even when an access code is set. `toolchain` is the result of the [start-up check of the video tools](#start-up-check-of-the-video-tools): `state` is `pending`, `running`, `passed`, `failed`, `skipped` or `disabled`, and `failed` names the checks that failed (never versions or paths).
- `GET /login`, `POST /login` (form field `code`, optional `next`), `GET /logout` — the way in when `ACCESS_CODE` is set; without it `/login` just sends the person on. With a code set, every other route answers `401` `ACCESS_CODE_REQUIRED` (under `/api/`) or sends the browser to `/login` until the code is given.
- `GET /test-upload`, `POST /test-upload`, `GET /jobs/:id` — the built-in phone-friendly pages. `GET /` redirects to `/test-upload`.

### Job options

Chosen per upload (the upload page has them under "Options"; a blank choice means "automatic"), stored with the job, so a job that
is resumed after a restart is finished the way it was started.

| Option | Values | Meaning |
| --- | --- | --- |
| `clipCount` | `1`–`5` | At most this many clips (default: `CLIP_MAX_CANDIDATES`). |
| `clipLength` | `auto`, `short` (15–30 s), `medium` (30–60 s), `long` (60–90 s) | Length of each clip (`auto` uses `HIGHLIGHT_MIN/MAX_DURATION_SECONDS`). |
| `aspect` | `vertical`, `portrait`, `square`, `landscape` | The shape of the clips: `vertical` 9:16 (default; Shorts, Reels, TikTok), `portrait` 4:5 and `square` 1:1 (feed posts), `landscape` 16:9 (YouTube). With the default size they are 1080×1920, 1080×1350, 1080×1080 and 1920×1080: every shape has the same short side. The captions are laid out for the shape (lower in the shapes where nothing is drawn over the picture, a little smaller in landscape), a face is followed with a window of the shape's width, and a landscape clip cut from a landscape video keeps all of it (so there is nothing for a face to be followed in). A job stored before shapes existed is vertical. |
| `quality` | `hd`, `standard` | `hd` is the configured clip size of the shape (1080 pixels on its short side by default); `standard` is two thirds of it (720), which renders noticeably faster on a small server. |
| `framing` | `center`, `face`, `fit` | How the picture is placed in the clip. `center` (default): the middle of the picture is cut out. `face`: the window follows a face (beta, see [Following a face](#following-a-face-beta-opt-in)); costs extra processing time. `fit`: nothing is cut off: the whole picture is shown across the width of the clip, over a blurred copy of itself (good for slides, screens and sport). |
| `captionStyle` | `classic`, `highlight`, `pop`, `none` | `classic`: short phrases in white. `highlight`: the same phrases with the word being spoken lit in gold. `pop`: a few big upper-case words at a time, the spoken word lit, popping in. `none`: leave the picture clean. See [Captions](#captions). |
| `captionAccent` | `gold`, `green`, `cyan`, `pink`, `red` | The colour of the word being spoken, in the two styles that light a word (`highlight` and `pop`). Gold is the default and the colour it always had. Plain phrases (`classic`) have no lit word, so the colour changes nothing there. |
| `captionPosition` | `lower`, `middle`, `top` | Where the captions go. `lower` (default) is where they always were: in a vertical clip the bottom of the text is about 70% of the way down, clear of the buttons and titles that Shorts, Reels and TikTok draw over the bottom of the picture (the other shapes put it lower still, as nothing is drawn over them). `middle` is the middle of the picture. `top` leaves about 15% of a vertical clip free above the text (the apps draw there too) and a little less in the other shapes. |
| `captionSize` | `small`, `medium`, `large` | How large the letters are: 0.8, 1 (default, the size they always had) and 1.25 times the usual size. Larger letters fit fewer words on a line, so fewer are shown at once (the groups are kept to about two lines); smaller letters fit more. |

### Progress and timings

`progress` (0–100) follows the real work: whisper.cpp's own percentage (`-pp`) fills the long transcription stage, the clips fill
the last stage one by one. `stageTimings` records how long each stage of the latest attempt took in milliseconds (a stage appears
once it has finished), and the totals are written to the log line that ends every job. On a small server this is how to see
where the time goes before deciding what to speed up.

Accepted extensions: MP4, MOV, MKV, WebM, AVI, M4V. Extension and declared MIME type are checked before a job is created and
`ffprobe` then checks that the file really contains a readable video stream. An upload that is abandoned halfway, or whose job
cannot be created, leaves nothing behind on the disk.

### Deterministic highlight ranking

The detector makes no semantic, LLM or "AI understanding" claim: every signal is a plain rule over the words and their timing. It
enumerates contiguous timestamped transcript windows within the configured duration bounds and clamps each to the probed video
duration. Windows that end at sentence punctuation (or at the end of the recording) come first. When there are fewer of those than
clips asked for (speech with little punctuation, or a short video) the missing ones are filled in with windows that may start or
end in the middle of a sentence, and each of those says so in its reasons. A video shorter than the shortest clip allowed gets one
clip made of all its speech, and speech with no usable length at all gives a clear error instead of an empty result. A lower-ranked
candidate is dropped if it overlaps an accepted one by at least `HIGHLIGHT_OVERLAP_THRESHOLD` of the shorter of the two, so the
clips are different moments.

The score is a 0–100 weighted average of inspectable signals: transcript word density (normalised at 3 words/second), emphatic
words, question marks, numeric detail, contrast/turning-point words, an opening hook ("Here's why…", "What if…", "3 ways…") in the
first words, sentence-boundary completeness, whether the passage starts cleanly (not with "and so…" or "um"), continuity (pauses
longer than 0.6 s count against it) and a length that suits short video (a little past the middle of the allowed range). Every
candidate stores its signal values, weights, contributions, human-readable reasons and source transcript indexes, and a suggested
**title** that is one of the clip's own sentences (the one that reads most like a headline: a question, a hook, a number, strong
wording), cleaned of spoken filler and shortened; it never invents words. The job page shows each clip's title, score and reasons,
labelled as rule-based. A later ML/LLM ranker can implement the same `HighlightDetector` interface without changing the API or the
rendering stage.

### Clip rendering

For each highest-ranked candidate (up to `CLIP_MAX_CANDIDATES`) FFmpeg cuts the passage with a little room around its speech: 0.25 s
before the first word and 0.4 s after the last, never into the neighbouring words, so neither end is clipped and no sliver of the
word before or after is heard (it uses the timing of every word when the transcript has it, and of the segments when not). The seek
is frame-accurate and placed before the input, so the range does not depend on source keyframes, the clip's own timeline starts at
zero (which is what the captions are counted from), and a clip deep inside a long video does not require decoding everything
before it. FFmpeg then
**scales the picture to fill the shape of the clip (9:16 unless another was chosen) and crops it** (from the centre, or along the path of a face when the person chose `framing: face`),
burns in the captions for the words spoken inside the range (see below), and encodes H.264/AAC with `+faststart`. Without that
choice the crop is fixed to the centre of the frame. With `framing: fit` nothing is cropped: the whole picture is scaled to the
width of the clip and laid over a blurred copy of the same picture that fills the rest of the frame. The copy is made at an eighth
of the size before it is blurred and enlarged, so it costs little, and FFmpeg measures the picture it is given (after turning a phone
video that is stored sideways), so any shape of video, from ultra-wide to taller than the clip, fits. A candidate that fails keeps a failed clip record with its error and
processing continues; the job completes only if at least one clip was made.

### Following a face (beta, opt-in)

A 9:16 clip shows only about a third of the width of a 16:9 video, so a person who stands off-centre can be cut in half. With
`framing: face` the window is moved to keep a face in view. It is off unless the person asks for it, because it costs processing time.

1. **Pictures.** For each clip FFmpeg is asked for small grey pictures of the stretch that becomes the clip: 2 per second, 480 px wide
   (fewer per second for a very long clip, never more than 180 for one clip).
2. **Faces.** A frontal-face detector looks at each picture. It is the classic Viola–Jones method with OpenCV's
   `haarcascade_frontalface_alt2` cascade (`apps/api/assets/cascades`, with its licence notice), written in TypeScript: no native
   library, no hosted service, nothing about the video leaves the server. It is a detector built from fixed rules and trained
   numbers, **not an AI model that understands the scene**, and the page says "beta". A test checks that it finds the same faces as
   OpenCV itself does in the same picture.
3. **The path.** Plain rules turn what was seen into a path for the window (`apps/api/src/framing.ts`): sightings in successive pictures
   are linked into tracks, the most visible track is followed, the window does not move while the face stays within a small dead zone,
   it moves at a limited speed, it waits 1.5 s when the face is lost for a moment, and it jumps at a cut in the video (found by
   comparing consecutive pictures). The path is handed to FFmpeg as a formula of time for its `crop` filter, so the clip is still
   encoded once.
4. **Fallback.** If no face is seen often enough, or the video cannot be checked, or the server has the feature switched off
   (`FACE_FRAMING_ENABLED=false`), the clip is cut from the middle exactly as before, and the clip card says so ("Centred: …" or
   "Followed a face, …"). A problem with framing never costs the person the clip.

What it does **not** do: it follows the most visible face, **not the person who is speaking** (sound plays no part), so in an
interview it can stay on the listener; it finds faces that look at the camera or nearly so, not profiles, heads turned away or
very small faces (under about a fifteenth of the width of the picture); it does not follow bodies, animals or objects, does not
zoom, and cannot keep two faces that are far apart in the window at once. Looking for faces is CPU work done before the clip is
encoded: it took tens of milliseconds per picture on a development machine, and a free instance has a small fraction of that CPU,
so a clip of a minute can add minutes there (this is why it is a choice).

Verified so far: the detector against OpenCV's result for one photograph; the path rules with unit tests (static, walking, leaving
and returning, two faces, cuts); and the whole chain with the real FFmpeg on synthetic videos made from that photograph (the face
stays in the middle of the rendered clip where a centred clip loses it), plus the options, storage, pipeline and page around it.
It was also tried by hand on four real recordings (public sample videos, not part of this repository). On a recording of a man
turning, tilting and bowing his head a face was found in 77 % of the pictures (the rest are the head turned to the side, bowed or
strongly tilted, which this detector does not see) and none of 18 randomly chosen detections was wrong; on a recording of a woman
moving her head it also found one in 77 % and followed it; in a corridor where people only now and then walk by, too little was
seen and the clip was left in the middle, as designed. A minute of video took about 4 seconds to check on a development machine.
Not yet verified: recordings of people actually talking (those samples have no speech), interviews and other footage of several
people sitting still, and the speed on the production instance.

### Captions

whisper.cpp is started with `-ojf`, which reports the pieces of every segment with their own times; the program joins them into
words (a piece that starts with a space starts a new word; punctuation stays with its word) and stores the words with the
transcript (`transcript_segments.words_json`). Times that cannot be trusted (none reported, everything at the same instant, all
squeezed into a corner of the segment) are discarded, and a segment without word timing, such as a transcript stored by an earlier
release, has its words spread over the segment by length instead: the captions are then a little off but never missing. These are
the engine's own estimates (whisper.cpp's token timestamps, not a forced alignment), so on some voices a lit word runs a little
early or late; this has been checked on synthetic timings and on the format of whisper.cpp's output read from its source, **not
yet on a real recording** on the server.

What is on screen at once is decided by plain rules, not a model: a group ends at the end of a sentence, after a comma once it is
long enough, at a pause, or when it would no longer fit (about 30 characters for `classic`, 22 for `highlight`, 16 for `pop`); it
does not end on a word such as "a" or "the" that belongs with the next one; a sentence does not end on a group of one word when
the group before it can spare a word; a group stays up a moment after its last word, never into the next group. A word wider than
the picture is set smaller instead of running off its edge.

The look can be changed without changing what the captions say, with three choices on the upload page: the colour of the spoken word
(`captionAccent`: gold, green, cyan, pink or red; it is the colour of the lit word, so it shows with `highlight` and `pop` and changes
nothing for `classic`), where the captions go (`captionPosition`: the lower part, the middle or the top) and how large the letters are
(`captionSize`: 0.8, 1 or 1.25 times the usual size). The defaults are exactly what captions looked like before there was a choice: the
files of the default look were compared byte for byte with the previous release for every style and shape. Larger letters fit fewer
words on a line, so a larger size also shows fewer words at once (a group is kept to about two lines) and a smaller one shows more; a
word that is wider than the picture is still set smaller than the chosen size. The top position leaves about 15% of a vertical clip free
(the apps draw there as well). Captions are drawn over whatever is in the picture, so with a followed face the middle or the top can
cover it: the lower part is the safe choice. Checked with the real FFmpeg and its caption renderer, reading single pixels: where the text
is in every shape and every place (lower, middle, top; plain, lit and pop-in words), the colour of the lit word for each of the five
accents (and that the other words stay white, and that the lit word moves along with the speech), the height of the letters (0.8 and 1.25
times), and that at the largest size nothing runs off the picture in any shape or place; also by eye on real footage, and with twenty-two
deliberate breakages of the code, every one of which the tests caught.

Each clip gets two caption files: a plain `.srt` of the same phrases, kept in storage next to the clip, and a styled `.ass` that
FFmpeg's libass burns into the picture (and that is thrown away afterwards). The letters are drawn with **Inter ExtraBold, which
ships with the program** (`apps/api/assets/fonts`, with its SIL Open Font License): a server without fonts of its own draws no
captions at all (reproduced locally with a font configuration that lists no fonts), so the font is not left to whatever the server
happens to have. A test renders a clip with such an empty font configuration and checks the captions are there. Inter covers Latin,
Greek and Cyrillic; other scripts (Arabic, CJK, Devanagari, Thai) need their own font files added to the same directory and are not
supported yet.

### Faster speech recognition with a hosted service (optional)

whisper.cpp on the free instance needs about 14 times the length of the video (measured once, above). A hosted service that speaks
the OpenAI `audio/transcriptions` protocol (OpenAI, Groq and others that copy it) does the same work in seconds to minutes. It is
off by default; set `TRANSCRIPTION_ENGINE=openai_compatible` together with `TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY` and
`TRANSCRIPTION_API_MODEL` (for example `whisper-1`, or `whisper-large-v3-turbo` at Groq) to use it. Put the key in the host's
environment settings, never in the repository. `TRANSCRIPTION_LANGUAGE=auto` lets the service detect the language, any other
value is passed as the language code, which is also how languages other than English become possible (whisper.cpp with the
English-only model cannot do them).

What the engine does: the audio is cut into pieces of about `TRANSCRIPTION_CHUNK_SECONDS`, each cut in the middle of the longest
pause close to where the piece should end (so no word is cut in half); each piece is compressed to mono AAC at 48 kbit/s (about
21 MB per hour, far below the 25 MB that services accept per request); up to `TRANSCRIPTION_API_CONCURRENCY` pieces are sent at a
time with `response_format=verbose_json` and word timestamps; the answers are joined on the clock of the whole recording into the
same transcript whisper.cpp produces, word timing included (the service gives words without punctuation, so each is matched with
the text of its segment to get its punctuation back, which the captions need). Segments the service marks as not speech (the
thresholds Whisper itself uses: more than 0.6 chance of no speech and a mean log-probability below -1) are dropped, because
silence and music make Whisper write phrases nobody said. A busy or unreachable service (HTTP 408, 425, 429, 5xx, a timeout, a
network error) is waited for and asked again up to four times, following `Retry-After`; a rejected key, a refused audio file or an
answer that is not `verbose_json` fails the job at once with a plain message that never contains the key or anything that echoes it.
When one piece fails the others are stopped.

What it costs and what it means: **the audio of every video is sent to that service**, which has its own terms, prices and limits
(check the provider's current ones), and a service with a key that costs money is only as safe as the access to this upload page,
which is open to anyone who can reach it unless an access code is set (see [The access code](#the-access-code-optional)).

Evidence: the engine is tested against a stand-in service that reads the real multipart request (request shape, key header,
options, ordering of answers, retries, failures, no key in any message) with real FFmpeg for the pauses and the pieces. It has not
been run against a real service yet: whether OpenAI's or Groq's actual answers read the same way, their rate limits, and the speed
and quality for real recordings are not proven.

### Not listening twice

Recognising the speech is by far the longest stage on the free instance (about 14 times the length of the video, see above), so a
video whose sound has been recognised before is not recognised again. After the audio is extracted, the program takes the
SHA-256 of the 16 kHz mono sound it is about to hand to speech recognition and looks it up, together with a key that names the engine
and everything its answer depends on besides the sound: for whisper.cpp the model's file name and size and the language; for a hosted
service its address, model, language and the piece length (never the key). The same sound with another model or language is another
entry and is listened to again, and an engine that cannot name itself (or a whisper.cpp whose model file cannot be read) is never
cached. A transcript that is found is used as it was kept, word timing included. The job page then shows "Reusing what was heard in
this video before" in place of "Listening to the speech", and the log line that ends the job says `transcriptReused: true`.

It helps when the same video is uploaded again to try another shape, caption look or framing; when a video is uploaded twice by
mistake; and when a job has to start over after a restart or failed in a later stage, because the transcript is kept as soon as it
exists. It cannot know that two *different* files say the same words: the key is the sound itself, so the same recording saved in
another format, trimmed or re-encoded is listened to again.

What is kept is the text and the word times of what was said (table `transcript_cache`), not the video and not the sound. It is kept
for `TRANSCRIPT_CACHE_DAYS` days (default 30) after it was last used and every use renews it; what has not been needed for that long is
forgotten when the server starts and after each new transcript is kept. With `0` nothing is kept, and what was kept is cleared at the next
start. Nobody can read a transcript by asking for it: it is only ever found by uploading the same sound, and the only thing that
reveals is that the job was faster. A stored transcript that is damaged, has nothing in it or does not make sense (times that run
backwards, the same segment twice) counts as not kept, and a transcript of nothing is never kept, so a failed or silent run is not repeated
for ever. Whatever goes wrong with the cache (it cannot be read or written) is logged as an error and costs time, never the job.

Evidence: the key, the reading back, the database table, the pipeline (reused or not, per engine, language and model, after a failed
job, with a damaged or empty transcript, with the cache broken, forgetting old transcripts) and the whole application over HTTP
(the same video uploaded twice reaches the speech engine once; with `TRANSCRIPT_CACHE_DAYS=0` it reaches it twice) are covered by tests that
use real FFmpeg and a real Postgres database. To check that those tests would notice a mistake, the code was also broken on purpose in 64
different ways, one at a time (a constant fingerprint, a key that ignores the language, a prune that deletes the wrong rows, a failing
cache that fails the job, and so on); all were noticed except one that changes nothing (the program refuses to keep an empty transcript in
two places, and removing only one of them leaves the other doing the job). That check was run by hand and is not part of the repository.
**Not proven yet:** a reused transcript on the live service (it needs the same real video to be uploaded twice there), and
how much time it saves on real recordings (the saving is the whole listening stage, which was 10 minutes for the one 45-second video
measured, but that is one sample).

### The access code (optional)

Without a code, anybody who knows the address can upload videos (each one costs processing time, storage and, with a hosted speech
service, money) and read any job whose address they have. Setting `ACCESS_CODE` puts one shared code in front of the whole
service. It is not an account system: there are no names, no per-person limits, and nobody can be removed without changing the
code for everybody.

- **Setting it.** Put it in the host's environment settings, never in the repository. At least 8 characters (a shorter one stops the
  server from starting, and the message does not repeat it); several unrelated words are better than something short with symbols,
  because the code is the only protection. Changing it logs everybody out, and removing it opens the service again.
- **People.** Any page asks for the code on `/login`. The right code gives a cookie (`studio_access`, 30 days, `HttpOnly`,
  `SameSite=Lax`, `Secure` when the service is served over https) and goes on to the page the person wanted, only ever a place on
  this server. `/logout` removes the cookie.
- **Programs.** `Authorization: Bearer <code>` or `X-Access-Code: <code>`. A code in the address (`?code=…`) is never accepted:
  addresses end up in histories and logs.
- **What stays open.** `/api/health` (Render's health check and the keep-awake request need it; it only says whether a code is
  required), `/login` and `/logout`. Everything else, uploads included, is refused before anything is stored.
- **How it is checked.** The code is compared in constant time as SHA-256 digests. The cookie does not contain the code: it is a
  keyed fingerprint made with scrypt, so a leaked cookie cannot be turned back into the code by trying guesses quickly. After ten
  wrong codes from one address within 15 minutes that address must wait for the window to end, even with the right code, and each
  wrong code is answered after a short pause. Someone who is already in (cookie or header) is never affected by other people's
  wrong guesses.
- **Logs.** A wrong guess is logged as "A wrong access code was given" with the client address and never with what was typed. The
  request logs replace the cookie, the `Authorization` and `X-Access-Code` headers, `Set-Cookie` and the redirect address (which is
  the signed clip download address) with `[hidden]`.

What it does not do: a clip link already handed out by `/api/jobs/:jobId/clips/:clipId` is a signed R2 address that works for an
hour without the code, because R2 serves it, not this service. The attempt limiter lives in memory, so a restart resets it, and it
tells people apart by the address Express reports; behind a proxy that may be an address shared by many people, and then a flood of
wrong codes could keep new people from logging in for a while (it cannot let anyone in, and it never affects cookies or headers).

Evidence: the code, the cookie, the limiter and the redaction are covered by unit tests and by end-to-end tests over real HTTP (a
closed gate stores nothing, login and logout, cookie attributes, header forms, the throttle, no secret in the logs during a real
upload and clip download), and the tests were mutation-checked (fifteen deliberate breakages of the gate are all caught). Not
proven: behaviour on the live Render service with a real code, which client address Render's proxy shows, and the `Secure` cookie
behind Render's https.

### Start-up check of the video tools

The tests prove that the code is right for the FFmpeg and whisper.cpp of the development machine and of CI. They cannot know what a
host installs, and a host that updates FFmpeg, or builds it without the caption library, would otherwise be found out by the first
customer's clip. So once the server is listening, and only when it has nothing else to do, it looks at the machine it really runs
on and writes the result to the log. "Nothing else to do" means no job running and no request being handled: a check on top of a
running job could use up the memory of the 512 MB instance, so it looks again every 20 seconds and gives up after 10 minutes (state
`skipped`, said in the log).

- FFmpeg and ffprobe start and say which version they are. The video and audio encoders named in `CLIP_VIDEO_CODEC` and `CLIP_AUDIO_CODEC`
  and the filters the clips use (`ass`, `crop`, `scale`, `split`, `boxblur`, `overlay`) exist. They are looked up in FFmpeg's own
  listings and, when a name is not found there (the layout of the listings has changed between FFmpeg versions, and the check has
  to be right on whichever one the host installs), FFmpeg is asked about that one name (`ffmpeg -h filter=NAME`,
  `-h encoder=NAME`) before it is called missing. The bundled caption font is installed.
- whisper.cpp, when it is the speech engine: the program is executable and prints its usage text, and the model file is there and
  not truncated. The model is not loaded (that needs far more memory than a small server can spare), and a hosted speech service is
  not called (that would send audio and cost money).
- Tiny real clips (144x256, one second) made by the very code that makes the customers' clips, judged by single pixels, because an
  FFmpeg that ignores a filter option still produces a playable video: the captions are drawn, with the bundled font and not with one
  that happens to be installed on the server (libass reports which it used); the whole-picture layout shows the whole picture over a
  dark blurred copy; and a crop window planned to move from the left edge to the right does move.
- When "Follow a face" is on offer: the real face follower watches a three-second video of a public-domain portrait (the one in
  `apps/api/test-assets`) crossing the picture, and has to follow it across.

The log gets one line, `Toolchain check passed (…)` at info level with every step (what was found, how long it took), or
`Toolchain check FAILED: <names>` at error level. `/api/health` shows only a summary, `toolchain: { state, checkedAt, failed }`,
because versions and paths are nobody's business but the operator's. A failed check does not make the health check fail: a host
would restart the service for ever, and a server whose captions are broken can still make clips without them.
`TOOLCHAIN_CHECK_ENABLED=false` switches the check off.

Evidence: every step is tested against the real FFmpeg and against stand-in programs that break exactly one thing (no caption
filter, captions silently dropped, a wrong font folder, a crop window that never moves or starts in the wrong place, a whole picture
cut instead of fitted, a program that is not FFmpeg, a truncated model, a portrait without a face...), and twenty-four deliberate
breakages of the check itself were each caught by those tests. What the check says on the live service is shown in its log (see
"What the free instance has actually done").

## Not implemented

Speaker tracking (the optional face following follows the most visible face, not whoever is talking), semantic or LLM highlight selection, languages other than English
out of the box (whisper.cpp needs a multilingual model instead of the English-only `ggml-base.en` that `setup:whisper` downloads and
`TRANSCRIPTION_LANGUAGE` set to the language code; the hosted engine above can take other languages but has not been tried with one; and the
caption font only covers Latin, Greek and Cyrillic), user accounts and real authentication (the only protection is the optional shared [access code](#the-access-code-optional); **without it anyone who can reach the service can upload**), per-user quotas,
malware scanning, a separate worker tier, and retention rules for generated clips. YouTube ingestion depends on a third-party Cobalt
service whose availability and terms of use are outside this repository. Operators are responsible for having the right to
process the videos users upload.

## Deployment notes

Currently deployed as one free Render web service (512 MB RAM, `npm install && npm run build`, then
`npm run start --workspace=@studio/api`, health check `/api/health`) with Neon PostgreSQL and a Cloudflare R2 bucket. The build
compiles whisper.cpp from source, so builds take several minutes and are not cached. `package-lock.json` is committed, so every
build installs exactly the dependency versions CI tested (the AWS SDK that talks to R2, for one, is released almost daily);
upgrade on purpose with `npm update`, run the tests, and commit the lockfile. whisper.cpp is pinned the same way: `setup:whisper`
in the root `package.json` fetches one exact commit (`7e26d3b0…`, the one the service was running when the pin was added) instead
of whatever is newest, because the upstream project changes daily and a change to its command line or output would only show up
when a customer's job reaches transcription. To move to a newer whisper.cpp, change that hash, build it, and run a real
transcription before deploying. Set the four `R2_*` variables,
`DATABASE_URL`, and `REQUIRE_DURABLE_STORAGE=true` there, and `ACCESS_CODE` as soon as the address is shared with anybody. On the free instance one real test took about 14 times the length of
the video (see "What the free instance has actually done"), so only short videos are practical there and a bigger instance is
the fix. For anything beyond a single small instance use
authenticated uploads with quotas, a separate worker tier fed by a durable queue, and resource limits.
