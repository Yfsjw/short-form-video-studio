export const jobStatuses = ['queued', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof jobStatuses)[number];

export interface VideoJob {
  id: string; originalFilename: string; storedFilename: string; mimeType: string; sizeBytes: number;
  status: JobStatus; stage: string; errorMessage: string | null; durationSeconds: number | null;
  width: number | null; height: number | null; createdAt: string; updatedAt: string;
}

export const clipStatuses = ['queued', 'processing', 'completed', 'failed'] as const;
export type ClipStatus = (typeof clipStatuses)[number];
export interface GeneratedClip { id: string; jobId: string; candidateId: string; startSeconds: number; endSeconds: number; durationSeconds: number; outputPath: string; outputFilename: string; status: ClipStatus; errorMessage: string | null; captionPath: string | null; createdAt: string; updatedAt: string; }
export interface TranscriptSegment { id: string; jobId: string; segmentIndex: number; startSeconds: number; endSeconds: number; text: string; createdAt: string; }
export type HighlightSignals = Record<string, { value: number; weight: number; contribution: number }>;
export interface HighlightCandidate { id: string; jobId: string; candidateIndex: number; startSeconds: number; endSeconds: number; score: number; quality: 'low' | 'medium' | 'high'; reasons: string[]; signals: HighlightSignals; sourceSegmentIndexes: number[]; createdAt: string; }
