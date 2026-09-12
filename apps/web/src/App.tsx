import { FormEvent, useEffect, useState } from 'react';

type Status = 'queued' | 'processing' | 'completed' | 'failed';
type Job = { id: string; originalFilename: string; sizeBytes: number; status: Status; stage: string; errorMessage: string | null; durationSeconds: number | null; width: number | null; height: number | null; createdAt: string };
type GeneratedClip = { id: string; startSeconds: number; endSeconds: number; durationSeconds: number; status: 'queued' | 'processing' | 'completed' | 'failed'; errorMessage: string | null };
type JobResponse = { job: Job; clips: GeneratedClip[] };
type TranscriptSegment = { id: string; segmentIndex: number; startSeconds: number; endSeconds: number; text: string };
type HighlightCandidate = { id: string; startSeconds: number; endSeconds: number; score: number; quality: string; reasons: string[]; sourceSegmentIndexes: number[] };
const prettyBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(14, 19);

export function App() {
  const [file, setFile] = useState<File>(); const [job, setJob] = useState<Job>(); const [clips, setClips] = useState<GeneratedClip[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [highlights, setHighlights] = useState<HighlightCandidate[]>([]);
  const [error, setError] = useState(''); const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (!job || !['queued', 'processing'].includes(job.status)) return;
    const id = window.setInterval(async () => {
      try { const res = await fetch(`/api/jobs/${job.id}`); if (!res.ok) return; const data: JobResponse = await res.json(); setJob(data.job); setClips(data.clips); } catch { /* Retain the last known server state; next poll retries. */ }
    }, 1200);
    return () => window.clearInterval(id);
  }, [job]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!file) return setError('Choose a video file before starting a job.');
    setError(''); setUploading(true); setJob(undefined); setClips([]); setSegments([]); setHighlights([]);
    const body = new FormData(); body.append('video', file);
    try { const res = await fetch('/api/jobs', { method: 'POST', body }); const data = await res.json(); if (!res.ok) throw new Error(data.error?.message ?? 'Upload failed.'); setJob(data.job); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Upload failed.'); }
    finally { setUploading(false); }
  }
  useEffect(() => {
    if (job?.status !== 'completed') return;
    void fetch(`/api/jobs/${job.id}/transcript`).then(async (res) => { if (!res.ok) throw new Error('Transcript retrieval failed.'); return res.json() as Promise<{ segments: TranscriptSegment[] }>; }).then((data) => setSegments(data.segments)).catch((reason) => setError(reason instanceof Error ? reason.message : 'Transcript retrieval failed.'));
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (job?.status !== 'completed') return;
    void fetch(`/api/jobs/${job.id}/highlights`).then(async (res) => { if (!res.ok) throw new Error('Highlight retrieval failed.'); return res.json() as Promise<{ candidates: HighlightCandidate[] }>; }).then((data) => setHighlights(data.candidates)).catch((reason) => setError(reason instanceof Error ? reason.message : 'Highlight retrieval failed.'));
  }, [job?.id, job?.status]);
  return <main><header><p className="eyebrow">SHORT-FORM VIDEO STUDIO</p><h1>Upload a source video.</h1><p className="intro">Create a processing job now. The foundation verifies usable video files and is ready for AI analysis and vertical clip stages.</p></header>
    <section className="card" aria-labelledby="upload-title"><h2 id="upload-title">New video job</h2><form onSubmit={submit}><label htmlFor="video">Video file <span>MP4, MOV, MKV, WebM, AVI, or M4V</span></label><input id="video" type="file" accept="video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo,video/x-m4v,.mp4,.mov,.mkv,.webm,.avi,.m4v" onChange={(e) => setFile(e.target.files?.[0])} /><p className="selected">{file ? `${file.name} · ${prettyBytes(file.size)}` : 'No file selected'}</p><button disabled={uploading}>{uploading ? 'Uploading…' : 'Start processing'}</button></form>{error && <p className="error" role="alert">{error}</p>}</section>
    {job && <section className="card status-card" aria-live="polite"><div className="status-heading"><div><p className="eyebrow">PROCESSING JOB</p><h2>{job.originalFilename}</h2></div><span className={`pill ${job.status}`}>{job.status}</span></div><dl><div><dt>Current stage</dt><dd>{job.stage.replaceAll('_', ' ')}</dd></div><div><dt>Source file</dt><dd>{prettyBytes(job.sizeBytes)}</dd></div>{job.durationSeconds !== null && <div><dt>Video metadata</dt><dd>{job.durationSeconds.toFixed(1)} sec · {job.width} × {job.height}</dd></div>}</dl>{job.status === 'failed' && <p className="error">{job.errorMessage}</p>}{job.status === 'completed' && <><div className="notice"><strong>Clip extraction complete.</strong> {clips.filter((clip) => clip.status === 'completed').length} real MP4 clip(s) are available below.</div><h3>Generated clips</h3>{clips.filter((clip) => clip.status === 'completed').map((clip, index) => <div className="clip" key={clip.id}><time>#{index + 1} · {timestamp(clip.startSeconds)} – {timestamp(clip.endSeconds)} · {clip.durationSeconds.toFixed(1)} sec</time><video controls preload="metadata" src={`/api/jobs/${job.id}/clips/${clip.id}`} /><a href={`/api/jobs/${job.id}/clips/${clip.id}?download=1`}>Download MP4</a></div>)}{clips.some((clip) => clip.status === 'failed') && <p className="error">{clips.filter((clip) => clip.status === 'failed').map((clip) => clip.errorMessage).join(' ')}</p>}<h3>Highlight candidates</h3>{highlights.length ? <ol className="transcript">{highlights.map((highlight, index) => <li key={highlight.id}><time>#{index + 1} · {timestamp(highlight.startSeconds)} – {timestamp(highlight.endSeconds)} · {(highlight.endSeconds - highlight.startSeconds).toFixed(1)} sec · score {highlight.score.toFixed(1)} ({highlight.quality})</time><span>{highlight.reasons.join(', ') || 'timing-based candidate'} · segments {highlight.sourceSegmentIndexes.join(', ')}</span></li>)}</ol> : <p className="selected">No candidate range met the configured timing and boundary rules.</p>}<h3>Transcript</h3>{segments.length ? <ol className="transcript">{segments.map((segment) => <li key={segment.id}><time>{timestamp(segment.startSeconds)} – {timestamp(segment.endSeconds)}</time><span>{segment.text}</span></li>)}</ol> : <p className="selected">No spoken segments were returned by the transcription engine.</p>}</>}{clips.length > 0 && <p>{clips.length} clip job record(s)</p>}</section>}
    <footer>Uploads remain on this server. YouTube URL ingestion is planned but is not enabled in this initial release.</footer></main>;
}
