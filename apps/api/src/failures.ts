/**
 * What a person who uploaded a video is told when something goes wrong with it.
 *
 * Only a `PlainFailure` is told as it is: its words say what is wrong with the video or the request, and never what is inside the server
 * (file paths, the names and command lines of programs, what a program printed, the answer of a storage or speech service, a database
 * message). Anything else that goes wrong is told in general words that fit the stage the job was in, and the real cause stays in the log,
 * where the operator reads it. A `PlainFailure` that was made from another failure keeps it as its `cause`, and the log shows that too.
 */
export class PlainFailure extends Error {
  /** What a request that fails with this is answered with (a job that fails with it has no use for these two). */
  readonly status: number;
  readonly code: string;
  constructor(message: string, options?: { cause?: unknown; status?: number; code?: string }) {
    super(message, options);
    this.name = 'PlainFailure';
    this.status = options?.status ?? 400;
    this.code = options?.code ?? 'INVALID_REQUEST';
  }
}

/** The only file types the server takes, in the words told to someone who sends another. */
export const onlyVideos = 'Only MP4, MOV, MKV, WebM, AVI, and M4V video files are accepted.';

/** The words that more than one place needs. */
export const plainWords = {
  unreadableVideo: 'This file could not be read as a video. It may be damaged, cut short, or in a format this server does not support.',
  noSound: 'This video has no sound, so there is no speech to write captions from or to choose moments by. Upload a video in which someone is talking.',
  unreadableSound: 'The sound of this video could not be read. The file may be damaged, or its sound may be in a format this server does not support.',
  noClips: 'This video could not be turned into clips. Please try again, or try another video.',
  /** For a single clip that could not be made (the job goes on with the others). */
  oneClip: 'This clip could not be made.',
  /** For a request that failed for a reason inside the server (not a job: a job says more, by its stage). */
  server: 'Something went wrong on the server. Please try again in a moment.',
  /** For a job that failed in a stage that has no words of its own. */
  jobServer: 'This video could not be processed because of a problem on the server. Please try again in a few minutes.',
} as const;

const receiving = 'The video could not be received properly by the server. Please upload it again.';
const listening = 'The speech in this video could not be turned into text. Please try again, or try another video.';

/**
 * What is said for a failure that is not a `PlainFailure`, by the stage the job was in (the names are the ones in progress.ts). Looking at the
 * video and taking its sound out are not here on purpose: what is wrong with the file itself is told as a `PlainFailure` by the code that does
 * those two (ffmpeg.ts), so anything else that goes wrong in them is the server's (a program that is not installed, say) and is told as such.
 */
const generalWords: Record<string, string> = {
  preparing_source: receiving,
  saving_source: receiving,
  restoring_source: receiving,
  waiting_to_retry: receiving,
  transcribing: listening,
  reusing_transcript: listening,
  detecting_highlights: 'No clips could be chosen from this video. Please try again, or try another video.',
  extracting_clips: plainWords.noClips,
};

/** The words for the person who uploaded the video: a `PlainFailure` says it itself, anything else is told in general words for `stage`. */
export function failureMessage(error: unknown, stage?: string): string {
  if (error instanceof PlainFailure) return error.message;
  return (stage !== undefined && generalWords[stage]) || plainWords.jobServer;
}

/** A time limit in the words of a person: "90 seconds", "60 minutes". */
export function describeTimeLimit(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 120) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  return `${Math.round(seconds / 60)} minutes`;
}
