import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { GeneratedClip, HighlightCandidate, JobStatus, TranscriptSegment, VideoJob } from './domain.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS video_jobs (
    id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, stored_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL, size_bytes BIGINT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
    error_message TEXT, duration_seconds DOUBLE PRECISION, width INTEGER, height INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS generated_clips (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id), candidate_id TEXT NOT NULL DEFAULT '',
    start_seconds DOUBLE PRECISION NOT NULL, end_seconds DOUBLE PRECISION NOT NULL, duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    output_path TEXT NOT NULL, output_filename TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', error_message TEXT,
    caption_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id), segment_index INTEGER NOT NULL,
    start_seconds DOUBLE PRECISION NOT NULL, end_seconds DOUBLE PRECISION NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(job_id, segment_index)
  );
  CREATE TABLE IF NOT EXISTS highlight_candidates (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES video_jobs(id), candidate_index INTEGER NOT NULL,
    start_seconds DOUBLE PRECISION NOT NULL, end_seconds DOUBLE PRECISION NOT NULL, score DOUBLE PRECISION NOT NULL, quality TEXT NOT NULL,
    reasons_json TEXT NOT NULL, signals_json TEXT NOT NULL, source_segment_indexes_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(job_id, candidate_index)
  );
`;

/**
 * Postgres-backed store (previously SQLite, which lived on Render's ephemeral local disk
 * and was wiped every time the free-tier service slept/restarted -- see the "external
 * storage" migration). Same public interface as before; every method is now async because
 * `pg` is a network client, not an in-process engine.
 */
export class StudioDatabase {
  private constructor(private readonly pool: Pool, private readonly schema?: string) {}

  /**
   * Connects and ensures the schema exists. Pass `schema` to isolate a run (e.g. one
   * Postgres schema per test file) instead of sharing the default "public" schema.
   */
  static async connect(connectionString: string, schema?: string): Promise<StudioDatabase> {
    const needsSsl = /sslmode=require/.test(connectionString) || /neon\.tech/.test(connectionString);
    const poolConfig: import('pg').PoolConfig = { connectionString, ssl: needsSsl ? { rejectUnauthorized: true } : undefined };
    if (schema) {
      // Applied by Postgres itself as each physical connection is opened, so every
      // connection the pool hands out already has the right search_path -- no race
      // with whichever query happens to run first on a freshly-opened connection.
      poolConfig.options = `-c search_path="${schema}"`;
    }
    const pool = new Pool(poolConfig);
    if (schema) {
      const bootstrap = await pool.connect();
      try {
        await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await bootstrap.query(SCHEMA_SQL);
      } finally { bootstrap.release(); }
    } else {
      await pool.query(SCHEMA_SQL);
    }
    return new StudioDatabase(pool, schema);
  }

  async createJob(job: VideoJob) {
    await this.pool.query(
      'INSERT INTO video_jobs (id, original_filename, stored_filename, mime_type, size_bytes, status, stage, error_message, duration_seconds, width, height, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [job.id, job.originalFilename, job.storedFilename, job.mimeType, job.sizeBytes, job.status, job.stage, job.errorMessage, job.durationSeconds, job.width, job.height, job.createdAt, job.updatedAt]
    );
  }

  async updateJob(id: string, fields: Partial<Pick<VideoJob, 'status' | 'stage' | 'errorMessage' | 'durationSeconds' | 'width' | 'height'>>) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const column: Record<string, string> = { errorMessage: 'error_message', durationSeconds: 'duration_seconds' };
    const setClauses = entries.map(([key], i) => `${column[key] ?? key} = $${i + 1}`);
    const values = entries.map(([, value]) => value ?? null);
    await this.pool.query(
      `UPDATE video_jobs SET ${setClauses.join(', ')}, updated_at = $${entries.length + 1} WHERE id = $${entries.length + 2}`,
      [...values, new Date().toISOString(), id]
    );
  }

  async getJob(id: string): Promise<VideoJob | undefined> {
    const result = await this.pool.query('SELECT * FROM video_jobs WHERE id = $1', [id]);
    return this.mapJob(result.rows[0]);
  }

  async listClips(jobId: string): Promise<GeneratedClip[]> {
    const result = await this.pool.query('SELECT * FROM generated_clips WHERE job_id = $1 ORDER BY created_at', [jobId]);
    return result.rows.map((row) => this.mapClip(row)).filter((clip): clip is GeneratedClip => Boolean(clip));
  }

  async createClip(clip: GeneratedClip) {
    await this.pool.query(
      'INSERT INTO generated_clips (id, job_id, candidate_id, start_seconds, end_seconds, duration_seconds, output_path, output_filename, status, error_message, caption_path, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [clip.id, clip.jobId, clip.candidateId, clip.startSeconds, clip.endSeconds, clip.durationSeconds, clip.outputPath, clip.outputFilename, clip.status, clip.errorMessage, clip.captionPath, clip.createdAt, clip.updatedAt]
    );
  }

  async updateClip(id: string, fields: Partial<Pick<GeneratedClip, 'status' | 'errorMessage' | 'durationSeconds' | 'captionPath'>>) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const columns: Record<string, string> = { errorMessage: 'error_message', durationSeconds: 'duration_seconds', captionPath: 'caption_path' };
    const setClauses = entries.map(([key], i) => `${columns[key] ?? key} = $${i + 1}`);
    const values = entries.map(([, value]) => value ?? null);
    await this.pool.query(
      `UPDATE generated_clips SET ${setClauses.join(', ')}, updated_at = $${entries.length + 1} WHERE id = $${entries.length + 2}`,
      [...values, new Date().toISOString(), id]
    );
  }

  async getClip(jobId: string, clipId: string): Promise<GeneratedClip | undefined> {
    const result = await this.pool.query('SELECT * FROM generated_clips WHERE job_id = $1 AND id = $2', [jobId, clipId]);
    return this.mapClip(result.rows[0]);
  }

  async replaceTranscript(jobId: string, segments: Array<Omit<TranscriptSegment, 'id' | 'jobId' | 'createdAt'>>) {
    await this.withTransaction(async (client) => {
      await client.query('DELETE FROM transcript_segments WHERE job_id = $1', [jobId]);
      const createdAt = new Date().toISOString();
      for (const segment of segments) {
        await client.query(
          'INSERT INTO transcript_segments (id, job_id, segment_index, start_seconds, end_seconds, text, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), jobId, segment.segmentIndex, segment.startSeconds, segment.endSeconds, segment.text, createdAt]
        );
      }
    });
  }

  async listTranscript(jobId: string): Promise<TranscriptSegment[]> {
    const result = await this.pool.query('SELECT * FROM transcript_segments WHERE job_id = $1 ORDER BY segment_index', [jobId]);
    return result.rows.map((row) => this.mapTranscript(row));
  }

  async replaceHighlights(jobId: string, candidates: Array<Omit<HighlightCandidate, 'id' | 'jobId' | 'candidateIndex' | 'createdAt'>>) {
    await this.withTransaction(async (client) => {
      await client.query('DELETE FROM highlight_candidates WHERE job_id = $1', [jobId]);
      const createdAt = new Date().toISOString();
      let candidateIndex = 0;
      for (const candidate of candidates) {
        await client.query(
          'INSERT INTO highlight_candidates (id, job_id, candidate_index, start_seconds, end_seconds, score, quality, reasons_json, signals_json, source_segment_indexes_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [randomUUID(), jobId, candidateIndex, candidate.startSeconds, candidate.endSeconds, candidate.score, candidate.quality, JSON.stringify(candidate.reasons), JSON.stringify(candidate.signals), JSON.stringify(candidate.sourceSegmentIndexes), createdAt]
        );
        candidateIndex += 1;
      }
    });
  }

  async listHighlights(jobId: string): Promise<HighlightCandidate[]> {
    const result = await this.pool.query('SELECT * FROM highlight_candidates WHERE job_id = $1 ORDER BY candidate_index', [jobId]);
    return result.rows.map((row) => this.mapHighlight(row));
  }

  /** Pass { dropSchema: true } in tests to clean up the isolated schema created by connect(). Never drops anything without both a schema and this explicit flag, so production callers can't accidentally wipe data. */
  async close(options?: { dropSchema?: boolean }) {
    if (options?.dropSchema && this.schema) {
      await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
    }
    await this.pool.end();
  }

  private async withTransaction(work: (client: PoolClient) => Promise<void>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private mapJob(row: any): VideoJob | undefined { if (!row) return undefined; return { id: row.id, originalFilename: row.original_filename, storedFilename: row.stored_filename, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), status: row.status as JobStatus, stage: row.stage, errorMessage: row.error_message, durationSeconds: row.duration_seconds, width: row.width, height: row.height, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private mapClip(row: any): GeneratedClip | undefined { if (!row) return undefined; return { id: row.id, jobId: row.job_id, candidateId: row.candidate_id, startSeconds: row.start_seconds, endSeconds: row.end_seconds, durationSeconds: row.duration_seconds, outputPath: row.output_path, outputFilename: row.output_filename, status: row.status, errorMessage: row.error_message, captionPath: row.caption_path, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private mapTranscript(row: any): TranscriptSegment { return { id: row.id, jobId: row.job_id, segmentIndex: row.segment_index, startSeconds: row.start_seconds, endSeconds: row.end_seconds, text: row.text, createdAt: row.created_at }; }
  private mapHighlight(row: any): HighlightCandidate { return { id: row.id, jobId: row.job_id, candidateIndex: row.candidate_index, startSeconds: row.start_seconds, endSeconds: row.end_seconds, score: row.score, quality: row.quality, reasons: JSON.parse(row.reasons_json), signals: JSON.parse(row.signals_json), sourceSegmentIndexes: JSON.parse(row.source_segment_indexes_json), createdAt: row.created_at }; }
}
