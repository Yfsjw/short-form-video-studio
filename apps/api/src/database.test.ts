import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { StudioDatabase } from './database.js';
import { defaultJobOptions, type GeneratedClip, type NewVideoJob } from './domain.js';
import { eventually, sleep } from './test-support.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:localtest@localhost:5432/studio_local_test';
const schemaName = (label: string) => `test_${label}_${randomUUID().replaceAll('-', '_')}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const makeJob = (id: string, status: NewVideoJob['status'], updatedAt = new Date().toISOString()): NewVideoJob => ({ id, originalFilename: 'v.mp4', storedFilename: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 1, status, stage: status, errorMessage: null, durationSeconds: null, width: null, height: null, createdAt: updatedAt, updatedAt });
const makeClip = (id: string, jobId: string): GeneratedClip => { const now = new Date().toISOString(); return { id, jobId, candidateId: 'c', startSeconds: 0, endSeconds: 5, durationSeconds: 5, outputPath: `${jobId}/${id}.mp4`, outputFilename: `${id}.mp4`, status: 'completed', errorMessage: null, captionPath: null, createdAt: now, updatedAt: now, title: null, score: null, reasons: [], framing: null }; };

async function withDatabase(label: string, work: (db: StudioDatabase) => Promise<void>) {
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, schemaName(label));
  try { await work(db); } finally { await db.close({ dropSchema: true }); }
}

test('a new job starts with no durable copy of its video and zero attempts; both can be recorded', () => withDatabase('job_fields', async (db) => {
  await db.createJob(makeJob('j1', 'queued'));
  const fresh = await db.getJob('j1');
  assert.equal(fresh?.sourceStorageKey, null);
  assert.equal(fresh?.attempts, 0);

  await db.updateJob('j1', { sourceStorageKey: 'sources/j1/source.mp4' });
  assert.equal((await db.getJob('j1'))?.sourceStorageKey, 'sources/j1/source.mp4');

  assert.equal(await db.beginAttempt('j1'), 1);
  assert.equal(await db.beginAttempt('j1'), 2);
  assert.equal((await db.getJob('j1'))?.attempts, 2);
}));

test('a job keeps the options it was created with, and its progress and stage timings can be recorded', () => withDatabase('job_options', async (db) => {
  await db.createJob({ ...makeJob('plain', 'queued') });
  assert.deepEqual((await db.getJob('plain'))?.options, defaultJobOptions, 'no options chosen means the defaults');

  const chosen = { clipCount: 2, clipLength: 'short', quality: 'standard', captionStyle: 'highlight', captionAccent: 'green', captionPosition: 'top', captionSize: 'large', framing: 'face', aspect: 'square' } as const;
  await db.createJob({ ...makeJob('chosen', 'queued'), options: chosen });
  assert.deepEqual((await db.getJob('chosen'))?.options, chosen);

  await db.updateJob('chosen', { stage: 'transcribing', progress: 42, stageTimings: { preparing_source: 1200, probing_video: 40 } });
  const job = await db.getJob('chosen');
  assert.equal(job?.progress, 42);
  assert.deepEqual(job?.stageTimings, { preparing_source: 1200, probing_video: 40 });
  assert.deepEqual(job?.options, chosen, 'updating a job must not disturb its options');

  await db.updateJob('chosen', { progress: 50 });
  assert.deepEqual((await db.getJob('chosen'))?.stageTimings, { preparing_source: 1200, probing_video: 40 }, 'an update that does not mention the timings leaves them alone');
}));

test('a job taken over after its process died starts again from zero progress', async () => {
  const schema = schemaName('progress_reset');
  const db = await StudioDatabase.connect(TEST_DATABASE_URL, schema);
  const raw = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path="${schema}"` });
  try {
    await db.createJob(makeJob('j', 'processing'));
    await raw.query(`UPDATE video_jobs SET progress = 63, updated_at = $1 WHERE id = 'j'`, [minutesAgo(10)]);
    assert.ok(await db.claimJobForRecovery('j', minutesAgo(1)));
    const job = await db.getJob('j');
    assert.equal(job?.status, 'queued');
    assert.equal(job?.progress, 0, 'a queued job must not show the progress of the attempt that died');
  } finally { await raw.end(); await db.close({ dropSchema: true }); }
});

test('upgrades a database created before durable sources existed, keeping its jobs', async () => {
  const schema = schemaName('migrate');
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    // The table exactly as the first production release created it: no source_storage_key, no attempts.
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".video_jobs (
      id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL, size_bytes BIGINT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
      error_message TEXT, duration_seconds DOUBLE PRECISION, width INTEGER, height INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const now = new Date().toISOString();
    await admin.query(`INSERT INTO "${schema}".video_jobs VALUES ('old','a.mp4','b.mp4','video/mp4',5,'completed','done',NULL,NULL,NULL,NULL,$1,$1)`, [now]);
    // A transcript stored by the release before words were kept (no words_json column).
    await admin.query(`CREATE TABLE "${schema}".transcript_segments (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES "${schema}".video_jobs(id), segment_index INTEGER NOT NULL,
      start_seconds DOUBLE PRECISION NOT NULL, end_seconds DOUBLE PRECISION NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(job_id, segment_index))`);
    await admin.query(`INSERT INTO "${schema}".transcript_segments VALUES ('s0','old',0,0,2,'An old transcript.',$1)`, [now]);
    // Candidates and clips as the release before titles, scores and reasons stored them.
    await admin.query(`CREATE TABLE "${schema}".highlight_candidates (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES "${schema}".video_jobs(id), candidate_index INTEGER NOT NULL,
      start_seconds DOUBLE PRECISION NOT NULL, end_seconds DOUBLE PRECISION NOT NULL, score DOUBLE PRECISION NOT NULL, quality TEXT NOT NULL,
      reasons_json TEXT NOT NULL, signals_json TEXT NOT NULL, source_segment_indexes_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(job_id, candidate_index))`);
    await admin.query(`INSERT INTO "${schema}".highlight_candidates VALUES ('hc0','old',0,0,2,55,'medium','["question phrasing"]','{}','[0]',$1)`, [now]);
    await admin.query(`CREATE TABLE "${schema}".generated_clips (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES "${schema}".video_jobs(id), candidate_id TEXT NOT NULL,
      start_seconds DOUBLE PRECISION NOT NULL, end_seconds DOUBLE PRECISION NOT NULL, duration_seconds DOUBLE PRECISION NOT NULL,
      output_path TEXT NOT NULL, output_filename TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT,
      caption_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '')`);
    await admin.query(`INSERT INTO "${schema}".generated_clips (id, job_id, candidate_id, start_seconds, end_seconds, duration_seconds, output_path, output_filename, status, created_at, updated_at) VALUES ('oldclip','old','hc0',0,2,2,'old/oldclip.mp4','oldclip.mp4','completed',$1,$1)`, [now]);

    for (let boot = 1; boot <= 2; boot += 1) { // booting twice proves the migration is idempotent
      const db = await StudioDatabase.connect(TEST_DATABASE_URL, schema);
      try {
        const job = await db.getJob('old');
        assert.equal(job?.status, 'completed');
        assert.equal(job?.sourceStorageKey, null);
        assert.equal(job?.attempts, 0);
        assert.deepEqual(job?.options, defaultJobOptions, 'a job from before options existed is processed with the defaults');
        assert.deepEqual(job?.stageTimings, {});
        assert.equal(job?.progress, 0);
        const [oldClip] = await db.listClips('old');
        assert.equal(oldClip.id, 'oldclip');
        assert.deepEqual([oldClip.title, oldClip.score, oldClip.reasons], [null, null, []], 'a clip from before titles and reasons existed has none, rather than made-up ones');
        assert.equal(oldClip.framing, null, 'a clip from before face framing existed says nothing about framing');
        const [oldCandidate] = await db.listHighlights('old');
        assert.deepEqual([oldCandidate.title, oldCandidate.score, oldCandidate.reasons], [null, 55, ['question phrasing']], 'a stored candidate keeps what it had');
        const transcript = await db.listTranscript('old');
        assert.equal(transcript.length, 1);
        if (boot === 1) {
          assert.equal(transcript[0].text, 'An old transcript.');
          assert.ok(!('words' in transcript[0]), 'an old transcript has no word timing, and says so by having none');
          await db.replaceTranscript('old', [{ segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'A new one.', words: [{ text: 'A', startSeconds: 0, endSeconds: 0.5 }, { text: 'new', startSeconds: 0.5, endSeconds: 1 }, { text: 'one.', startSeconds: 1, endSeconds: 2 }] }]);
        } else {
          assert.deepEqual(transcript[0].words?.map((word) => word.text), ['A', 'new', 'one.'], 'words written after the upgrade survive the next start');
        }
        await db.createJob(makeJob(`new-${boot}`, 'queued'));
        assert.equal((await db.getJob(`new-${boot}`))?.attempts, 0);
        // The column for the framing note was added by the upgrade, so a new clip can keep its note.
        await db.createClip({ ...makeClip(`after-${boot}`, 'old'), framing: 'Followed a face, seen in 80% of the moments checked.' });
        assert.equal((await db.listClips('old')).find((clip) => clip.id === `after-${boot}`)?.framing, 'Followed a face, seen in 80% of the moments checked.');
      } finally { await db.close(); }
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test('the words of a transcript are stored with their timing; segments without words read back without them', () => withDatabase('words', async (db) => {
  await db.createJob(makeJob('j-words', 'processing'));
  await db.replaceTranscript('j-words', [
    { segmentIndex: 0, startSeconds: 0, endSeconds: 2, text: 'Hello there.', words: [{ text: 'Hello', startSeconds: 0.1, endSeconds: 0.9 }, { text: 'there.', startSeconds: 1, endSeconds: 1.8 }] },
    { segmentIndex: 1, startSeconds: 2, endSeconds: 3, text: 'No words here' },
  ]);
  const [first, second] = await db.listTranscript('j-words');
  assert.deepEqual(first.words, [{ text: 'Hello', startSeconds: 0.1, endSeconds: 0.9 }, { text: 'there.', startSeconds: 1, endSeconds: 1.8 }]);
  assert.ok(!('words' in second));
}));

test('a clip is stored with the title, score and reasons of its passage, and a candidate with its title', () => withDatabase('clip_meta', async (db) => {
  await db.createJob(makeJob('j-meta', 'processing'));
  await db.replaceHighlights('j-meta', [{ startSeconds: 0, endSeconds: 20, score: 71.5, quality: 'high', reasons: ['question phrasing', 'a length that suits short video'], signals: {}, sourceSegmentIndexes: [0], title: 'Why do most channels stop growing?' }, { startSeconds: 30, endSeconds: 50, score: 40, quality: 'low', reasons: [], signals: {}, sourceSegmentIndexes: [1], title: null }]);
  assert.deepEqual((await db.listHighlights('j-meta')).map((candidate) => candidate.title), ['Why do most channels stop growing?', null]);
  await db.createClip({ ...makeClip('c-meta', 'j-meta'), title: 'Why do most channels stop growing?', score: 71.5, reasons: ['question phrasing', 'a length that suits short video'] });
  await db.createClip({ ...makeClip('c-plain', 'j-meta'), title: null, score: 0, reasons: [], framing: null });
  const clips = await db.listClips('j-meta');
  const byId = (id: string) => clips.find((clip) => clip.id === id);
  assert.deepEqual([byId('c-meta')?.title, byId('c-meta')?.score, byId('c-meta')?.reasons], ['Why do most channels stop growing?', 71.5, ['question phrasing', 'a length that suits short video']]);
  assert.deepEqual([byId('c-plain')?.title, byId('c-plain')?.score, byId('c-plain')?.reasons], [null, 0, []], 'a score of zero is a score, not a missing one');
}));

test('a clip keeps the note about how it was framed, and a clip with no note reads back as null', () => withDatabase('clip_framing', async (db) => {
  await db.createJob(makeJob('j-framing', 'processing'));
  await db.createClip({ ...makeClip('c-followed', 'j-framing'), framing: 'Followed a face, seen in 80% of the moments checked.' });
  await db.createClip({ ...makeClip('c-centred', 'j-framing'), framing: 'Centred: no face was found in the video.' });
  await db.createClip({ ...makeClip('c-plain', 'j-framing'), framing: null });
  const byId = new Map((await db.listClips('j-framing')).map((clip) => [clip.id, clip.framing]));
  assert.equal(byId.get('c-followed'), 'Followed a face, seen in 80% of the moments checked.');
  assert.equal(byId.get('c-centred'), 'Centred: no face was found in the video.');
  assert.equal(byId.get('c-plain'), null, 'no note is null, never an empty string or the word undefined');
  assert.equal((await db.getClip('j-framing', 'c-followed'))?.framing, 'Followed a face, seen in 80% of the moments checked.', 'a single clip is read back with its note too');
}));

test('lists only unfinished jobs, oldest first', () => withDatabase('unfinished', async (db) => {
  await db.createJob(makeJob('b-processing', 'processing', minutesAgo(1)));
  await db.createJob(makeJob('a-queued', 'queued', minutesAgo(5)));
  await db.createJob(makeJob('c-completed', 'completed'));
  await db.createJob(makeJob('d-failed', 'failed'));
  assert.deepEqual((await db.listUnfinishedJobs()).map((job) => job.id), ['a-queued', 'b-processing']);
}));

test('the heartbeat refreshes unfinished jobs and leaves finished ones alone', () => withDatabase('heartbeat', async (db) => {
  const tenMinutesAgo = minutesAgo(10);
  await db.createJob(makeJob('running', 'processing', tenMinutesAgo));
  await db.createJob(makeJob('done', 'completed', tenMinutesAgo));
  await db.touchJob('running');
  await db.touchJob('done');
  assert.ok((await db.getJob('running'))!.updatedAt > tenMinutesAgo, 'a running job must get a fresh timestamp');
  assert.equal((await db.getJob('done'))?.updatedAt, tenMinutesAgo, 'a finished job must keep the timestamp it had');
}));

test('only a job nobody has touched since the cut-off can be taken over, and only once', () => withDatabase('claim', async (db) => {
  const staleBefore = minutesAgo(1);
  await db.createJob(makeJob('abandoned', 'processing', minutesAgo(10)));
  await db.createJob(makeJob('abandoned-queued', 'queued', minutesAgo(10)));
  await db.createJob(makeJob('alive', 'processing', new Date().toISOString()));
  await db.createJob(makeJob('finished', 'completed', minutesAgo(10)));

  assert.equal(await db.claimJobForRecovery('abandoned', staleBefore), true);
  assert.equal(await db.claimJobForRecovery('abandoned', staleBefore), false, 'a second server must not take the same job again');
  assert.equal(await db.claimJobForRecovery('abandoned-queued', staleBefore), true);
  assert.equal(await db.claimJobForRecovery('alive', staleBefore), false);
  assert.equal(await db.claimJobForRecovery('finished', staleBefore), false);

  const claimed = await db.getJob('abandoned');
  assert.equal(claimed?.status, 'queued');
  assert.equal(claimed?.errorMessage, null);
  assert.equal((await db.getJob('alive'))?.status, 'processing');
  assert.equal((await db.getJob('finished'))?.status, 'completed');
}));

test('giving up on an abandoned job records the reason, but never touches a live or finished job', () => withDatabase('fail_stale', async (db) => {
  const staleBefore = minutesAgo(1);
  await db.createJob(makeJob('abandoned', 'processing', minutesAgo(10)));
  await db.createJob(makeJob('alive', 'processing', new Date().toISOString()));
  await db.createJob(makeJob('finished', 'completed', minutesAgo(10)));

  assert.equal(await db.failStaleJob('abandoned', staleBefore, 'because reasons'), true);
  assert.equal(await db.failStaleJob('alive', staleBefore, 'because reasons'), false);
  assert.equal(await db.failStaleJob('finished', staleBefore, 'because reasons'), false);

  const failed = await db.getJob('abandoned');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.stage, 'failed');
  assert.equal(failed?.errorMessage, 'because reasons');
  assert.equal((await db.getJob('alive'))?.status, 'processing');
  assert.equal((await db.getJob('finished'))?.status, 'completed');
}));

test('a connection the server cuts while it sits idle in the pool is noted, does not crash the process, and the next query simply works', async () => {
  // Without a listener for the pool's 'error' event, this very scenario ends the whole Node process (found while reviewing the code).
  const applicationName = `idle-probe-${randomUUID()}`;
  const url = `${TEST_DATABASE_URL}${TEST_DATABASE_URL.includes('?') ? '&' : '?'}application_name=${applicationName}`;
  const noted: string[] = [];
  const db = await StudioDatabase.connect(url, schemaName('idle_cut'), { warn: (_fields, message) => { noted.push(message); } });
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await db.createJob(makeJob('j1', 'queued')); // leaves a connection idle in the pool
    // Only this test's own connections are cut (picked out by their application name), never those of tests running alongside.
    const cut = await admin.query(`SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1) AS cut`, [applicationName]);
    assert.ok(cut.rows[0].n >= 1, 'the probe must have cut at least one idle connection');
    await eventually('the pool to learn that its idle connection was cut', () => noted.length, (count) => count >= 1);
    assert.equal((await db.getJob('j1'))?.id, 'j1', 'the next query must work on a fresh connection');
  } finally {
    await admin.end();
    await db.close({ dropSchema: true });
  }
});

test('a connection the server cuts in the middle of a transaction fails that transaction with the real reason, leaves nothing half-written, and does not crash the process', async () => {
  // Found by the independent review. Unlike an idle connection, one that is in use is not watched by the pool, and the 'error'
  // event that pg emits on it when the server cuts it ended the whole Node process (every job in flight with it).
  const applicationName = `tx-probe-${randomUUID()}`;
  const url = `${TEST_DATABASE_URL}${TEST_DATABASE_URL.includes('?') ? '&' : '?'}application_name=${applicationName}`;
  const db = await StudioDatabase.connect(url, schemaName('tx_cut'));
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await db.createJob(makeJob('j1', 'processing'));
    // Long enough (one statement per segment) that the transaction is still running when the connection is cut.
    const segments = Array.from({ length: 30_000 }, (_, index) => ({ segmentIndex: index, startSeconds: index, endSeconds: index + 1, text: `segment ${index}` }));
    const outcome = db.replaceTranscript('j1', segments).then(() => undefined, (error: unknown) => error);
    // Only this test's own connection is cut (picked out by its application name), never those of tests running alongside.
    await eventually('the transcript to be in the middle of being written', async () => (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND xact_start IS NOT NULL`, [applicationName])).rows[0].n, (open) => open >= 1);
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND xact_start IS NOT NULL`, [applicationName]);

    const error = await outcome;
    assert.ok(error instanceof Error, 'the cut must fail the transaction instead of pretending it worked');
    assert.match(error.message, /terminating connection due to administrator command/, 'the reason given must be the cut itself, not the failed attempt to roll back or "not queryable" afterwards');
    assert.equal((await db.listTranscript('j1')).length, 0, 'half a transcript must never be left behind');
    assert.equal((await db.getJob('j1'))?.id, 'j1', 'the next query must work on a fresh connection');
  } finally {
    await admin.end();
    await db.close({ dropSchema: true });
  }
});

test('when the cut lands between two statements of a transaction, the reason reported is the cut and not a vague "not queryable"', async () => {
  // No query is running at that moment to carry the reason: pg only emits it as an 'error' event on the connection, and the next
  // statement then fails with a message that says nothing about why.
  const applicationName = `tx-gap-${randomUUID()}`;
  const url = `${TEST_DATABASE_URL}${TEST_DATABASE_URL.includes('?') ? '&' : '?'}application_name=${applicationName}`;
  const db = await StudioDatabase.connect(url, schemaName('tx_gap'));
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    const withTransaction = (db as unknown as { withTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> }).withTransaction.bind(db);
    let transactionIsIdle!: () => void; const idle = new Promise<void>((resolve) => { transactionIsIdle = resolve; });
    let connectionWasCut!: () => void; const cut = new Promise<void>((resolve) => { connectionWasCut = resolve; });
    const outcome = withTransaction(async (client) => {
      await client.query('SELECT 1');
      transactionIsIdle();
      await cut; // the test cuts the connection now, while this transaction sits between two statements
      await sleep(100); // long enough for the 'error' event to arrive before the next statement is sent
      await client.query('SELECT 2');
    }).then(() => undefined, (error: unknown) => error);
    await idle;
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`, [applicationName]);
    connectionWasCut();

    const error = await outcome;
    assert.ok(error instanceof Error, 'the cut must fail the transaction');
    assert.match(error.message, /terminating connection due to administrator command/);
    assert.equal((await db.getJob('nothing'))?.id, undefined, 'the pool must still work afterwards');
  } finally {
    await admin.end();
    await db.close({ dropSchema: true });
  }
});

test('starting up against a database that is already up to date does not queue behind the transactions that are using it', async () => {
  // ADD COLUMN IF NOT EXISTS asks for an exclusive lock on the table before it checks anything, so every start waited for the
  // longest open transaction and held up every query that arrived after it. The server runs this at every start, including the
  // start of the new instance during a redeploy while the old one is still working.
  const schema = schemaName('boot_lock');
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  const holder = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  const transaction = await holder.connect();
  let booted: Promise<StudioDatabase> | undefined;
  try {
    await (await StudioDatabase.connect(TEST_DATABASE_URL, schema)).close(); // the tables now exist, as they do on every later start
    await transaction.query('BEGIN');
    // ROW EXCLUSIVE is what every INSERT, UPDATE and DELETE holds until its transaction ends (a job's heartbeat, a long transcript insert).
    for (const table of ['video_jobs', 'generated_clips', 'transcript_segments', 'highlight_candidates']) await transaction.query(`LOCK TABLE "${schema}".${table} IN ROW EXCLUSIVE MODE`);
    booted = StudioDatabase.connect(TEST_DATABASE_URL, schema);
    const outcome = await Promise.race([booted.then(() => 'started'), sleep(3000).then(() => 'still waiting for the open transaction')]);
    assert.equal(outcome, 'started');
  } finally {
    await transaction.query('ROLLBACK');
    transaction.release();
    await holder.end();
    await (await booted?.catch(() => undefined))?.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test('deleting a job\'s clips returns them (so their files can be removed) and spares other jobs', () => withDatabase('delete_clips', async (db) => {
  await db.createJob(makeJob('j1', 'processing'));
  await db.createJob(makeJob('j2', 'processing'));
  await db.createClip(makeClip('c1', 'j1'));
  await db.createClip(makeClip('c2', 'j1'));
  await db.createClip(makeClip('c3', 'j2'));

  const removed = await db.deleteClipsForJob('j1');
  assert.deepEqual(removed.map((clip) => clip.id).sort(), ['c1', 'c2']);
  assert.deepEqual(removed.map((clip) => clip.outputPath).sort(), ['j1/c1.mp4', 'j1/c2.mp4']);
  assert.equal((await db.listClips('j1')).length, 0);
  assert.deepEqual((await db.listClips('j2')).map((clip) => clip.id), ['c3']);
  assert.deepEqual(await db.deleteClipsForJob('j1'), []);
}));
