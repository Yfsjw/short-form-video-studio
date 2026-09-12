import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GeneratedClip, HighlightCandidate, JobStatus, TranscriptSegment, VideoJob } from './domain.js';

export class StudioDatabase {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS video_jobs (
        id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, stored_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
        error_message TEXT, duration_seconds REAL, width INTEGER, height INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS generated_clips (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id), candidate_id TEXT NOT NULL,
        start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, duration_seconds REAL NOT NULL,
        output_path TEXT NOT NULL, output_filename TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT,
        caption_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id), segment_index INTEGER NOT NULL,
        start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(job_id, segment_index)
      );
      CREATE TABLE IF NOT EXISTS highlight_candidates (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id), candidate_index INTEGER NOT NULL,
        start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, score REAL NOT NULL, quality TEXT NOT NULL,
        reasons_json TEXT NOT NULL, signals_json TEXT NOT NULL, source_segment_indexes_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(job_id, candidate_index)
      );`);
    this.migrateGeneratedClips();
  }
  private migrateGeneratedClips() {
    const existing = new Set(this.db.prepare('PRAGMA table_info(generated_clips)').all().map((column: any) => column.name));
    const additions: Array<[string, string]> = [['candidate_id', "TEXT NOT NULL DEFAULT ''"], ['duration_seconds', 'REAL NOT NULL DEFAULT 0'], ['output_filename', "TEXT NOT NULL DEFAULT ''"], ['status', "TEXT NOT NULL DEFAULT 'queued'"], ['error_message', 'TEXT'], ['caption_path', 'TEXT'], ['updated_at', "TEXT NOT NULL DEFAULT ''"]];
    for (const [name, definition] of additions) if (!existing.has(name)) this.db.exec(`ALTER TABLE generated_clips ADD COLUMN ${name} ${definition}`);
  }
  createJob(job: VideoJob) {
    this.db.prepare(`INSERT INTO video_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.originalFilename, job.storedFilename, job.mimeType, job.sizeBytes, job.status, job.stage, job.errorMessage, job.durationSeconds, job.width, job.height, job.createdAt, job.updatedAt);
  }
  updateJob(id: string, fields: Partial<Pick<VideoJob, 'status' | 'stage' | 'errorMessage' | 'durationSeconds' | 'width' | 'height'>>) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const column: Record<string, string> = { errorMessage: 'error_message', durationSeconds: 'duration_seconds', sizeBytes: 'size_bytes' };
    const sql = `UPDATE video_jobs SET ${entries.map(([key]) => `${column[key] ?? key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, value]) => value ?? null), new Date().toISOString(), id);
  }
  getJob(id: string): VideoJob | undefined { return this.mapJob(this.db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id)); }
  listClips(jobId: string): GeneratedClip[] { return this.db.prepare('SELECT * FROM generated_clips WHERE job_id = ? ORDER BY created_at').all(jobId).map((row) => this.mapClip(row)).filter((clip): clip is GeneratedClip => Boolean(clip)); }
  createClip(clip: GeneratedClip) {
    this.db.prepare('INSERT INTO generated_clips (id, job_id, candidate_id, start_seconds, end_seconds, duration_seconds, output_path, output_filename, status, error_message, caption_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(clip.id, clip.jobId, clip.candidateId, clip.startSeconds, clip.endSeconds, clip.durationSeconds, clip.outputPath, clip.outputFilename, clip.status, clip.errorMessage, clip.captionPath, clip.createdAt, clip.updatedAt);
  }
  updateClip(id: string, fields: Partial<Pick<GeneratedClip, 'status' | 'errorMessage' | 'durationSeconds' | 'captionPath'>>) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined); if (!entries.length) return;
    const columns: Record<string, string> = { errorMessage: 'error_message', durationSeconds: 'duration_seconds', captionPath: 'caption_path' };
    this.db.prepare(`UPDATE generated_clips SET ${entries.map(([key]) => `${columns[key] ?? key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value ?? null), new Date().toISOString(), id);
  }
  getClip(jobId: string, clipId: string): GeneratedClip | undefined { return this.mapClip(this.db.prepare('SELECT * FROM generated_clips WHERE job_id = ? AND id = ?').get(jobId, clipId)); }
  replaceTranscript(jobId: string, segments: Array<Omit<TranscriptSegment, 'id' | 'jobId' | 'createdAt'>>) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM transcript_segments WHERE job_id = ?').run(jobId);
      const insert = this.db.prepare('INSERT INTO transcript_segments (id, job_id, segment_index, start_seconds, end_seconds, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const createdAt = new Date().toISOString();
      for (const segment of segments) insert.run(randomUUID(), jobId, segment.segmentIndex, segment.startSeconds, segment.endSeconds, segment.text, createdAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listTranscript(jobId: string): TranscriptSegment[] { return this.db.prepare('SELECT * FROM transcript_segments WHERE job_id = ? ORDER BY segment_index').all(jobId).map((row) => this.mapTranscript(row)); }
  replaceHighlights(jobId: string, candidates: Array<Omit<HighlightCandidate, 'id' | 'jobId' | 'candidateIndex' | 'createdAt'>>) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM highlight_candidates WHERE job_id = ?').run(jobId);
      const insert = this.db.prepare('INSERT INTO highlight_candidates (id, job_id, candidate_index, start_seconds, end_seconds, score, quality, reasons_json, signals_json, source_segment_indexes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const createdAt = new Date().toISOString();
      candidates.forEach((candidate, candidateIndex) => insert.run(randomUUID(), jobId, candidateIndex, candidate.startSeconds, candidate.endSeconds, candidate.score, candidate.quality, JSON.stringify(candidate.reasons), JSON.stringify(candidate.signals), JSON.stringify(candidate.sourceSegmentIndexes), createdAt));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listHighlights(jobId: string): HighlightCandidate[] { return this.db.prepare('SELECT * FROM highlight_candidates WHERE job_id = ? ORDER BY candidate_index').all(jobId).map((row) => this.mapHighlight(row)); }
  close() { this.db.close(); }
  private mapJob(row: any): VideoJob | undefined { if (!row) return undefined; return { id: row.id, originalFilename: row.original_filename, storedFilename: row.stored_filename, mimeType: row.mime_type, sizeBytes: row.size_bytes, status: row.status as JobStatus, stage: row.stage, errorMessage: row.error_message, durationSeconds: row.duration_seconds, width: row.width, height: row.height, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private mapClip(row: any): GeneratedClip | undefined { if (!row) return undefined; return { id: row.id, jobId: row.job_id, candidateId: row.candidate_id, startSeconds: row.start_seconds, endSeconds: row.end_seconds, durationSeconds: row.duration_seconds, outputPath: row.output_path, outputFilename: row.output_filename, status: row.status, errorMessage: row.error_message, captionPath: row.caption_path, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private mapTranscript(row: any): TranscriptSegment { return { id: row.id, jobId: row.job_id, segmentIndex: row.segment_index, startSeconds: row.start_seconds, endSeconds: row.end_seconds, text: row.text, createdAt: row.created_at }; }
  private mapHighlight(row: any): HighlightCandidate { return { id: row.id, jobId: row.job_id, candidateIndex: row.candidate_index, startSeconds: row.start_seconds, endSeconds: row.end_seconds, score: row.score, quality: row.quality, reasons: JSON.parse(row.reasons_json), signals: JSON.parse(row.signals_json), sourceSegmentIndexes: JSON.parse(row.source_segment_indexes_json), createdAt: row.created_at }; }
}
