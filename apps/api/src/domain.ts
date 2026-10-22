export const jobStatuses = ['queued', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof jobStatuses)[number];

/** How long the clips should be: `auto` leaves it to the server's defaults (HIGHLIGHT_MIN/MAX_DURATION_SECONDS). */
export const clipLengthChoices = ['auto', 'short', 'medium', 'long'] as const;
export type ClipLengthChoice = (typeof clipLengthChoices)[number];
/** `hd` is the server's configured size (1080x1920 unless changed); `standard` is two thirds of it (720x1280), which renders much faster. */
export const qualityChoices = ['hd', 'standard'] as const;
export type QualityChoice = (typeof qualityChoices)[number];
/**
 * How captions look. `classic`: short phrases in white. `highlight`: the same phrases with the word being spoken in colour.
 * `pop`: a few big upper-case words at a time, the word being spoken in colour, popping in. `none`: no captions.
 */
export const captionStyles = ['classic', 'highlight', 'pop', 'none'] as const;
export type CaptionStyle = (typeof captionStyles)[number];

/**
 * How the picture of a clip is placed in the vertical frame when the video is wider than the clip. `center`: the middle of the picture is cut out.
 * `face`: the window follows a face (see framing.ts); where no face is found, or none can be followed, the middle is used. `fit`: nothing is cut
 * off: the whole picture is shown across the width of the frame, over a blurred copy of itself that fills the rest.
 */
export const framingChoices = ['center', 'face', 'fit'] as const;
export type FramingChoice = (typeof framingChoices)[number];

/** What the person asked for when uploading. Stored with the job so a resumed job is finished the way it was started. */
export interface JobOptions {
  /** At most this many clips; null leaves it to the server's default (CLIP_MAX_CANDIDATES). */
  clipCount: number | null;
  clipLength: ClipLengthChoice;
  quality: QualityChoice;
  captionStyle: CaptionStyle;
  framing: FramingChoice;
}
export const defaultJobOptions: JobOptions = { clipCount: null, clipLength: 'auto', quality: 'hd', captionStyle: 'classic', framing: 'center' };

export interface VideoJob {
  id: string; originalFilename: string; storedFilename: string; mimeType: string; sizeBytes: number;
  status: JobStatus; stage: string; errorMessage: string | null; durationSeconds: number | null;
  width: number | null; height: number | null; createdAt: string; updatedAt: string;
  /** Key of the durable copy of the uploaded video; null until it has been saved to durable storage. */
  sourceStorageKey: string | null;
  /** How many times processing has been started for this job; the first run counts as 1. */
  attempts: number;
  options: JobOptions;
  /** How long each stage of the latest attempt took, in milliseconds (a stage appears once it has finished). */
  stageTimings: Record<string, number>;
  /** How far along processing is, 0 to 100. */
  progress: number;
}
/** What a caller supplies to create a job; the pipeline owns the storage key, the attempt counter, the timings and the progress. */
export type NewVideoJob = Omit<VideoJob, 'sourceStorageKey' | 'attempts' | 'options' | 'stageTimings' | 'progress'> & { options?: JobOptions };

export const clipStatuses = ['queued', 'processing', 'completed', 'failed'] as const;
export type ClipStatus = (typeof clipStatuses)[number];
export interface GeneratedClip {
  id: string; jobId: string; candidateId: string; startSeconds: number; endSeconds: number; durationSeconds: number; outputPath: string; outputFilename: string; status: ClipStatus; errorMessage: string | null; captionPath: string | null; createdAt: string; updatedAt: string;
  /** A suggested title taken from the words of the clip (a rule, not a model); null for a clip made before titles existed. */
  title: string | null;
  /** The rule-based score (0-100) of the passage the clip was cut from, and the rules it satisfied; null / empty for older clips. */
  score: number | null;
  reasons: string[];
  /** One line on how the picture of the clip was cut ("Followed a face, seen in 90% of the moments checked." / "Centred: no face was found..."); null when the person did not ask for face following, and for older clips. */
  framing: string | null;
}
/** One spoken word with the moment it starts and ends, in seconds from the start of the video. */
export interface TranscriptWord { text: string; startSeconds: number; endSeconds: number; }
export interface TranscriptSegment {
  id: string; jobId: string; segmentIndex: number; startSeconds: number; endSeconds: number; text: string; createdAt: string;
  /** The words of the segment with their own timing, when the speech recognition provided it (older transcripts and other engines may not). */
  words?: TranscriptWord[];
}
export type HighlightSignals = Record<string, { value: number; weight: number; contribution: number }>;
export interface HighlightCandidate { id: string; jobId: string; candidateIndex: number; startSeconds: number; endSeconds: number; score: number; quality: 'low' | 'medium' | 'high'; reasons: string[]; signals: HighlightSignals; sourceSegmentIndexes: number[]; createdAt: string; /** A suggested title taken from the words of the passage; null when there is nothing to base one on. */ title: string | null; }
