import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSrtTime, writeSrtCaptions } from './captions.js';

test('formats SRT timestamps', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(61.234), '00:01:01,234');
  assert.equal(formatSrtTime(3661.999), '01:01:01,999');
});

test('writes clip-relative captions for segments overlapping the candidate range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-captions-')); const path = join(root, 'clip.srt');
  try {
    const count = await writeSrtCaptions(path, [
      { startSeconds: 8, endSeconds: 12, text: 'Before the clip' },
      { startSeconds: 10, endSeconds: 15, text: 'First caption' },
      { startSeconds: 15, endSeconds: 22, text: 'Second caption' },
    ], 10, 20);
    const srt = await readFile(path, 'utf8');
    assert.equal(count, 3);
    assert.match(srt, /00:00:00,000 --> 00:00:02,000\nBefore the clip/);
    assert.match(srt, /00:00:00,000 --> 00:00:05,000\nFirst caption/);
    assert.match(srt, /00:00:05,000 --> 00:00:10,000\nSecond caption/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
