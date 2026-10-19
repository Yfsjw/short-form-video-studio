import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { defaultJobOptions, type GeneratedClip, type HighlightCandidate, type JobStatus, type NewVideoJob, type TranscriptSegment, type VideoJob } from './domain.js';
import { readStoredOptions } from './options.js';
import { parseStoredWords } from './words.js';

const CREATE_TABLES_SQL = `
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

/** Columns that were added after the first production release, so a database created by an older release is missing them. */
const COLUMNS_ADDED_LATER: Array<{ table: string; name: string; definition: string }> = [
  { table: 'video_jobs', name: 'source_storage_key', definition: 'TEXT' },
  { table: 'video_jobs', name: 'attempts', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'video_jobs', name: 'options_json', definition: 'TEXT' },
  { table: 'video_jobs', name: 'stage_timings_json', definition: 'TEXT' },
  { table: 'video_jobs', name: 'progress', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'transcript_segments', name: 'words_json', definition: 'TEXT' },
];

type SqlRunner = (sql: string) => Promise<{ rows: any[] }>;

/** The stage timings of a job as stored (JSON text); anything unreadable counts as "nothing recorded". */
function parseTimings(json: string | null | undefined): Record<string, number> {
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) as Record<string, number>;
  } catch { return {}; }
}

/**
 * Creates whatever is missing and leaves what exists alone. The ALTER is only issued for a column that really is missing:
 * `ADD COLUMN IF NOT EXISTS` asks for an exclusive lock on the whole table before it looks, so even when the column is already
 * there it waits behind every open transaction that touched the table and holds up every query that arrives after it
 * (reproduced with one transaction left open). This runs at every start, and during a redeploy the previous instance is
 * still working: its heartbeats and a long transcript insert would stall behind the new instance's start-up.
 */
async function ensureSchema(run: SqlRunner) {
  await run(CREATE_TABLES_SQL);
  const present = new Map<string, Set<string>>();
  for (const table of new Set(COLUMNS_ADDED_LATER.map((column) => column.table))) {
    const existing = await run(`SELECT attname FROM pg_attribute WHERE attrelid = to_regclass('${table}') AND attnum > 0 AND NOT attisdropped`);
    present.set(table, new Set(existing.rows.map((row) => String(row.attname))));
  }
  for (const column of COLUMNS_ADDED_LATER) {
    if (!present.get(column.table)?.has(column.name)) await run(`ALTER TABLE ${column.table} ADD COLUMN IF NOT EXISTS ${column.name} ${column.definition}`);
  }
}

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
  static async connect(connectionString: string, schema?: string, logger?: { warn: (fields: object, message: string) => void }): Promise<StudioDatabase> {
    const needsSsl = /sslmode=require/.test(connectionString) || /neon\.tech/.test(connectionString);
    const poolConfig: import('pg').PoolConfig = { connectionString, ssl: needsSsl ? { rejectUnauthorized: true } : undefined };
    if (schema) {
      // Applied by Postgres itself as each physical connection is opened, so every
      // connection the pool hands out already has the right search_path -- no race
      // with whichever query happens to run first on a freshly-opened connection.
      poolConfig.options = `-c search_path="${schema}"`;
    }
    const pool = new Pool(poolConfig);
    // A connection sitting idle in the pool can be cut by the server (a serverless database restarting or suspending
    // its compute, a network hiccup). pg reports that as an 'error' event on the pool, and an 'error' event that nobody
    // listens to crashes the whole process -- reproduced with a Postgres session terminated behind the pool's back. By the
    // time the event arrives the pool has already thrown the dead connection away and opens a fresh one when it is next
    // needed, so noting it down is all that is left to do. (A connection that is in use fails its own query instead.)
    pool.on('error', (error) => {
      const fields = { err: error };
      const message = 'A database connection that was idle in the pool was closed by the server; the pool will open a new one when it is needed';
      if (logger) logger.warn(fields, message); else console.warn(message, error.message);
    });
    if (schema) {
      const bootstrap = await pool.connect();
      try {
        await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await ensureSchema((sql) => bootstrap.query(sql));
      } finally { bootstrap.release(); }
    } else {
      await ensureSchema((sql) => pool.query(sql));
    }
    return new StudioDatabase(pool, schema);
  }

  async createJob(job: NewVideoJob) {
    await this.pool.query(
      'INSERT INTO video_jobs (id, original_filename, stored_filename, mime_type, size_bytes, status, stage, error_message, duration_seconds, width, height, created_at, updated_at, options_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [job.id, job.originalFilename, job.storedFilename, job.mimeType, job.sizeBytes, job.status, job.stage, job.errorMessage, job.durationSeconds, job.width, job.height, job.createdAt, job.updatedAt, JSON.stringify(job.options ?? defaultJobOptions)]
    );
  }

  async updateJob(id: string, fields: Partial<Pick<VideoJob, 'status' | 'stage' | 'errorMessage' | 'durationSeconds' | 'width' | 'height' | 'sourceStorageKey' | 'progress' | 'stageTimings'>>) {
    const { stageTimings, ...plain } = fields;
    const entries = Object.entries({ ...plain, stageTimings: stageTimings === undefined ? undefined : JSON.stringify(stageTimings) }).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const column: Record<string, string> = { errorMessage: 'error_message', durationSeconds: 'duration_seconds', sourceStorageKey: 'source_storage_key', stageTimings: 'stage_timings_json' };
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
          'INSERT INTO transcript_segments (id, job_id, segment_index, start_seconds, end_seconds, text, created_at, words_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [randomUUID(), jobId, segment.segmentIndex, segment.startSeconds, segment.endSeconds, segment.text, createdAt, segment.words?.length ? JSON.stringify(segment.words) : null]
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

  /** Counts one more processing attempt for the job and returns the new total (1 on the first run). */
  async beginAttempt(id: string): Promise<number> {
    const result = await this.pool.query('UPDATE video_jobs SET attempts = attempts + 1, updated_at = $1 WHERE id = $2 RETURNING attempts', [new Date().toISOString(), id]);
    return Number(result.rows[0]?.attempts ?? 0);
  }

  /** Heartbeat: a live process refreshes its job's row so nobody mistakes the job for an abandoned one. */
  async touchJob(id: string) {
    await this.pool.query(`UPDATE video_jobs SET updated_at = $1 WHERE id = $2 AND status IN ('queued', 'processing')`, [new Date().toISOString(), id]);
  }

  /** Every job that has not reached a final state yet, oldest first. */
  async listUnfinishedJobs(): Promise<VideoJob[]> {
    const result = await this.pool.query(`SELECT * FROM video_jobs WHERE status IN ('queued', 'processing') ORDER BY created_at`);
    return result.rows.map((row) => this.mapJob(row)).filter((job): job is VideoJob => Boolean(job));
  }

  /** Jobs that are over but whose stored copy of the uploaded video was never deleted (the process died, or storage failed, right when the job ended). */
  async listFinishedJobsHoldingSource(limit = 50): Promise<VideoJob[]> {
    const result = await this.pool.query(`SELECT * FROM video_jobs WHERE status IN ('completed', 'failed') AND source_storage_key IS NOT NULL ORDER BY updated_at LIMIT $1`, [limit]);
    return result.rows.map((row) => this.mapJob(row)).filter((job): job is VideoJob => Boolean(job));
  }

  /**
   * Atomically takes over a job whose process died (nothing touched its row since `staleBefore`).
   * Returns false when the job is no longer stale or another process claimed it first, so two
   * servers sweeping at the same moment can never both resume the same job. `updated_at` holds
   * ISO-8601 UTC text, so comparing it as text is the same as comparing the instants.
   */
  async claimJobForRecovery(id: string, staleBefore: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE video_jobs SET status = 'queued', stage = 'queued', error_message = NULL, progress = 0, updated_at = $1 WHERE id = $2 AND status IN ('queued', 'processing') AND updated_at < $3`,
      [new Date().toISOString(), id, staleBefore]
    );
    return result.rowCount === 1;
  }

  /** Gives up on an abandoned job with an honest reason (same staleness guard as claimJobForRecovery). */
  async failStaleJob(id: string, staleBefore: string, message: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE video_jobs SET status = 'failed', stage = 'failed', error_message = $1, updated_at = $2 WHERE id = $3 AND status IN ('queued', 'processing') AND updated_at < $4`,
      [message, new Date().toISOString(), id, staleBefore]
    );
    return result.rowCount === 1;
  }

  /** Deletes every clip row of a job before it is re-run, and returns them so their stored files can be removed too. */
  async deleteClipsForJob(jobId: string): Promise<GeneratedClip[]> {
    const result = await this.pool.query('DELETE FROM generated_clips WHERE job_id = $1 RETURNING *', [jobId]);
    return result.rows.map((row) => this.mapClip(row)).filter((clip): clip is GeneratedClip => Boolean(clip));
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
    // The pool watches the connections that sit idle, not the ones it has handed out. When the server cuts a connection that is
    // in use (a serverless database restarting, a network drop) pg emits an 'error' event on the client, and an 'error' event
    // that nobody listens to ends the whole Node process, every job in flight with it (reproduced by terminating the session in
    // the middle of a long insert). So the event is listened to, and what it says is kept: when the cut lands between two
    // statements no query is running to carry the reason, and the next statement would only report "not queryable".
    let firstProblem: unknown;
    const noteConnectionError = (error: Error) => { firstProblem ??= error; };
    client.on('error', noteConnectionError);
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      firstProblem ??= error;
      // If the connection is gone this fails too (the server drops an unfinished transaction when its connection closes anyway),
      // and it must not hide the error that matters, which is the first one. The pool discards a connection that has failed,
      // so the next caller never receives a dead one.
      await client.query('ROLLBACK').catch(() => undefined);
      throw firstProblem;
    } finally {
      client.removeListener('error', noteConnectionError);
      client.release();
    }
  }

  private mapJob(row: any): VideoJob | undefined { if (!row) return undefined; return { id: row.id, originalFilename: row.original_filename, storedFilename: row.stored_filename, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), status: row.status as JobStatus, stage: row.stage, errorMessage: row.error_message, durationSeconds: row.duration_seconds, width: row.width, height: row.height, createdAt: row.created_at, updatedAt: row.updated_at, sourceStorageKey: row.source_storage_key ?? null, attempts: Number(row.attempts ?? 0), options: readStoredOptions(row.options_json), stageTimings: parseTimings(row.stage_timings_json), progress: Number(row.progress ?? 0) }; }
  private mapClip(row: any): GeneratedClip | undefined { if (!row) return undefined; return { id: row.id, jobId: row.job_id, candidateId: row.candidate_id, startSeconds: row.start_seconds, endSeconds: row.end_seconds, durationSeconds: row.duration_seconds, outputPath: row.output_path, outputFilename: row.output_filename, status: row.status, errorMessage: row.error_message, captionPath: row.caption_path, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private mapTranscript(row: any): TranscriptSegment {
    const words = parseStoredWords(row.words_json);
    return { id: row.id, jobId: row.job_id, segmentIndex: row.segment_index, startSeconds: row.start_seconds, endSeconds: row.end_seconds, text: row.text, createdAt: row.created_at, ...(words ? { words } : {}) };
  }
  private mapHighlight(row: any): HighlightCandidate { return { id: row.id, jobId: row.job_id, candidateIndex: row.candidate_index, startSeconds: row.start_seconds, endSeconds: row.end_seconds, score: row.score, quality: row.quality, reasons: JSON.parse(row.reasons_json), signals: JSON.parse(row.signals_json), sourceSegmentIndexes: JSON.parse(row.source_segment_indexes_json), createdAt: row.created_at }; }
}
