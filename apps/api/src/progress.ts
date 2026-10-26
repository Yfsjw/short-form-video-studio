/**
 * Where each processing stage sits on the 0 to 100 scale people see, and what it is called for them.
 * Transcription is by far the longest stage on a small server, so it gets the widest range and is filled in
 * from whisper.cpp's own percentage; rendering is filled in clip by clip.
 */
const stages: Record<string, { label: string; from: number; to: number }> = {
  queued: { label: 'Waiting to start', from: 0, to: 0 },
  preparing_source: { label: 'Receiving your video', from: 1, to: 3 },
  saving_source: { label: 'Saving your video safely', from: 1, to: 4 },
  restoring_source: { label: 'Restoring your video after a restart', from: 1, to: 4 },
  waiting_for_capacity: { label: 'Waiting for the server to finish another video', from: 4, to: 4 },
  waiting_to_retry: { label: 'Waiting to try again', from: 4, to: 4 },
  probing_video: { label: 'Reading the video', from: 5, to: 6 },
  extracting_audio: { label: 'Extracting the audio', from: 6, to: 10 },
  transcribing: { label: 'Listening to the speech', from: 10, to: 70 },
  reusing_transcript: { label: 'Reusing what was heard in this video before', from: 10, to: 70 },
  detecting_highlights: { label: 'Finding the best moments', from: 70, to: 72 },
  extracting_clips: { label: 'Rendering the clips', from: 72, to: 99 },
  clip_extraction_complete: { label: 'Done', from: 100, to: 100 },
  failed: { label: 'Failed', from: 0, to: 0 },
};

/** A readable name for a stage; an unknown stage (a newer release's, say) is shown as it is. */
export function stageLabel(stage: string): string { return stages[stage]?.label ?? stage.replaceAll('_', ' '); }

/** The progress, as a whole number from 0 to 100, for being `fraction` (0 to 1) of the way through `stage`. */
export function stageProgress(stage: string, fraction = 0): number {
  const range = stages[stage];
  if (!range) return 0;
  const clamped = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
  return Math.round(range.from + (range.to - range.from) * clamped);
}

/** Adds up how long each stage took, for the one-line summary ("Finished in 4 min 12 s"). */
export function totalMilliseconds(timings: Record<string, number>): number {
  return Object.values(timings).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

/** 3 s, 4 min 12 s, 1 h 05 min. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** Records how long each stage of one run took. `enter` closes the stage that was running; a stage entered twice (a restored source, say) adds up. */
export class StageClock {
  private current: { stage: string; since: number } | undefined;
  private readonly finished: Record<string, number> = {};
  constructor(private readonly now: () => number = Date.now) {}
  enter(stage: string) { this.leave(); this.current = { stage, since: this.now() }; }
  private leave() {
    if (!this.current) return;
    this.finished[this.current.stage] = (this.finished[this.current.stage] ?? 0) + Math.max(0, this.now() - this.current.since);
    this.current = undefined;
  }
  /** The stages that have finished so far. */
  snapshot(): Record<string, number> { return { ...this.finished }; }
  /** Closes the stage that is running and returns everything. */
  finish(): Record<string, number> { this.leave(); return this.snapshot(); }
}
