import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

type CobaltResponse =
  | { status: 'tunnel' | 'redirect'; url: string; filename?: string }
  | { status: 'local-processing'; tunnel: string[]; output?: { type?: string; filename?: string } }
  | { status: 'picker'; picker?: Array<{ type: string; url: string }> }
  | { status: 'error'; error?: { code?: string; context?: unknown } };

function assertYouTubeUrl(value: string): URL {
  const url = new URL(value);
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(url.hostname.toLowerCase())) {
    throw new Error('Only YouTube URLs are accepted.');
  }
  return url;
}

export async function downloadYouTubeVideo(options: {
  youtubeUrl: string;
  cobaltUrl: string;
  cobaltApiKey?: string;
  outputDir: string;
  jobId: string;
  timeoutMs?: number;
}): Promise<{ storedFilename: string; originalFilename: string; sizeBytes: number; mimeType: string }> {
  const youtubeUrl = assertYouTubeUrl(options.youtubeUrl);
  const base = options.cobaltUrl.replace(/\/+$/, '');
  await mkdir(options.outputDir, { recursive: true });

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (options.cobaltApiKey) headers.Authorization = `Api-Key ${options.cobaltApiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20 * 60 * 1000);
  try {
    const cobaltRes = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: youtubeUrl.toString(),
        downloadMode: 'auto',
        videoQuality: '1080',
        youtubeVideoCodec: 'h264',
        youtubeVideoContainer: 'mp4',
        filenameStyle: 'basic',
        disableMetadata: false,
      }),
      signal: controller.signal,
    });

    const raw = await cobaltRes.text();
    if (!cobaltRes.ok) throw new Error(`Cobalt HTTP ${cobaltRes.status}: ${raw.slice(0, 500)}`);
    let data: CobaltResponse;
    try { data = JSON.parse(raw) as CobaltResponse; }
    catch { throw new Error(`Cobalt returned non-JSON data: ${raw.slice(0, 500)}`); }

    let sourceUrl: string | undefined;
    let filename = 'youtube-video.mp4';
    if (data.status === 'tunnel' || data.status === 'redirect') {
      sourceUrl = data.url;
      filename = data.filename || filename;
    } else if (data.status === 'local-processing' && data.tunnel?.length === 1) {
      sourceUrl = data.tunnel[0];
      filename = data.output?.filename || filename;
    } else if (data.status === 'picker') {
      const video = data.picker?.find((item) => item.type === 'video');
      if (video) sourceUrl = video.url;
    } else if (data.status === 'error') {
      const code = data.error?.code ?? 'unknown';
      throw new Error(`Cobalt error: ${code}`);
    }

    if (!sourceUrl) throw new Error(`Cobalt did not return a downloadable video (status: ${data.status}).`);

    const mediaController = new AbortController();
    const mediaTimeout = setTimeout(() => mediaController.abort(), options.timeoutMs ?? 20 * 60 * 1000);
    try {
      const mediaRes = await fetch(sourceUrl, { signal: mediaController.signal });
      if (!mediaRes.ok || !mediaRes.body) throw new Error(`Video download HTTP ${mediaRes.status}`);
      const safeBase = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]+$/, '') || 'youtube-video';
      const storedFilename = `${options.jobId}-source.mp4`;
      const target = join(options.outputDir, storedFilename);
      const partial = `${target}.part`;
      await rm(partial, { force: true });
      await streamPipeline(Readable.fromWeb(mediaRes.body as globalThis.ReadableStream), createWriteStream(partial));
      await rename(partial, target);
      const stat = await import('node:fs/promises').then((fs) => fs.stat(target));
      if (!stat.size) throw new Error('Downloaded YouTube video is empty.');
      const mimeType = mediaRes.headers.get('content-type')?.split(';')[0] || 'video/mp4';
      return { storedFilename, originalFilename: `${safeBase}.mp4`, sizeBytes: stat.size, mimeType };
    } finally {
      clearTimeout(mediaTimeout);
    }
  } finally {
    clearTimeout(timeout);
  }
}
