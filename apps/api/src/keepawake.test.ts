import assert from 'node:assert/strict';
import test from 'node:test';
import { KeepAwake } from './keepawake.js';
import { eventually, sleep } from './test-support.js';

const PUBLIC_URL = 'https://studio.example.test';

interface Harness { keepAwake: KeepAwake; requests: string[]; infos: string[]; warns: string[]; busy: { value: boolean }; fetchBehaviour: { run: (url: string) => Promise<Response> } }

/** A KeepAwake wired to a fake network and a recording logger, running on a very short interval. */
function harness(options: { intervalMs?: number; publicUrl?: string; timeoutMs?: number } = {}): Harness {
  const requests: string[] = []; const infos: string[] = []; const warns: string[] = [];
  const busy = { value: false };
  const fetchBehaviour = { run: async (_url: string) => new Response('{"status":"ok"}', { status: 200 }) };
  const fetchImpl = (async (input: string | URL | Request) => { const url = String(input); requests.push(url); return fetchBehaviour.run(url); }) as typeof fetch;
  const logger = { info: (...args: unknown[]) => { infos.push(String(args.find((arg) => typeof arg === 'string'))); }, warn: (...args: unknown[]) => { warns.push(String(args.find((arg) => typeof arg === 'string'))); } };
  const keepAwake = new KeepAwake({ publicUrl: options.publicUrl ?? PUBLIC_URL, intervalMs: options.intervalMs ?? 15, timeoutMs: options.timeoutMs, isBusy: () => busy.value, logger: logger as never, fetchImpl });
  return { keepAwake, requests, infos, warns, busy, fetchBehaviour };
}

test('it requests the service\'s own health endpoint while there is work, and says so once', async () => {
  const { keepAwake, requests, infos, busy } = harness();
  keepAwake.start();
  try {
    busy.value = true;
    await eventually('several requests while busy', () => requests.length, (count) => count >= 3);
    assert.ok(requests.every((url) => url === `${PUBLIC_URL}/api/health`), `unexpected targets: ${requests.join(', ')}`);
    assert.equal(infos.filter((line) => /being kept awake/.test(line)).length, 1, 'the log must not repeat itself on every request');
  } finally { keepAwake.stop(); }
});

test('it stays completely quiet while the service has nothing to do', async () => {
  const { keepAwake, requests, infos, warns } = harness();
  keepAwake.start();
  try {
    await sleep(150); // ten rounds
    assert.deepEqual({ requests: requests.length, infos: infos.length, warns: warns.length }, { requests: 0, infos: 0, warns: 0 });
  } finally { keepAwake.stop(); }
});

test('once the work is over it stops, and notes that in the log', async () => {
  const { keepAwake, requests, infos, busy } = harness();
  keepAwake.start();
  try {
    busy.value = true;
    await eventually('the first request', () => requests.length, (count) => count >= 1);
    busy.value = false;
    await eventually('the log line about being done', () => infos, (lines) => lines.some((line) => /no longer being kept awake/.test(line)));
    const before = requests.length;
    await sleep(150);
    assert.equal(requests.length, before, 'no request may be sent once the work is over');
  } finally { keepAwake.stop(); }
});

test('a failing request is reported once per outage, never throws, and requests carry on until they work again', async () => {
  const { keepAwake, requests, infos, warns, busy, fetchBehaviour } = harness();
  fetchBehaviour.run = async () => { throw new Error('connect ECONNREFUSED'); };
  keepAwake.start();
  try {
    busy.value = true;
    await eventually('repeated failed attempts', () => requests.length, (count) => count >= 4);
    assert.equal(warns.length, 1, 'one warning for the whole outage, not one per attempt');
    assert.match(warns[0], /may be spun down/);

    fetchBehaviour.run = async () => new Response('{}', { status: 200 });
    await eventually('the recovery to be noticed', () => infos, (lines) => lines.some((line) => /work again/.test(line)));
    assert.equal(warns.length, 1);

    fetchBehaviour.run = async () => { throw new Error('a second outage'); };
    await eventually('a second warning for a second outage', () => warns.length, (count) => count === 2);
  } finally { keepAwake.stop(); }
});

test('an error answer from the service itself counts as a failure', async () => {
  const { keepAwake, requests, warns, busy, fetchBehaviour } = harness();
  fetchBehaviour.run = async () => new Response('Bad gateway', { status: 502 });
  keepAwake.start();
  try {
    busy.value = true;
    await eventually('a warning', () => warns.length, (count) => count === 1);
    assert.ok(requests.length >= 1);
  } finally { keepAwake.stop(); }
});

test('a slow request is never joined by a second one', async () => {
  const { keepAwake, busy, fetchBehaviour } = harness({ intervalMs: 10 });
  let running = 0; let mostAtOnce = 0; let finished = 0;
  fetchBehaviour.run = async () => {
    running += 1; mostAtOnce = Math.max(mostAtOnce, running);
    await sleep(60);
    running -= 1; finished += 1;
    return new Response('{}', { status: 200 });
  };
  keepAwake.start();
  try {
    busy.value = true;
    await eventually('a few slow requests to complete', () => finished, (count) => count >= 3, 5_000);
    assert.equal(mostAtOnce, 1);
  } finally { keepAwake.stop(); }
});

test('a request that hangs is abandoned after its timeout, reported, and retried on the next round', async () => {
  const requests: string[] = []; const signals: AbortSignal[] = []; const warns: string[] = [];
  // Like the real fetch, this never answers on its own and fails as soon as its abort signal fires.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input)); signals.push(init!.signal!);
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout'))));
  }) as typeof fetch;
  const logger = { info: () => undefined, warn: (...args: unknown[]) => { warns.push(String(args.find((arg) => typeof arg === 'string'))); } };
  const keepAwake = new KeepAwake({ publicUrl: PUBLIC_URL, intervalMs: 10, timeoutMs: 30, isBusy: () => true, logger: logger as never, fetchImpl });
  keepAwake.start();
  try {
    await eventually('a timed-out request to be reported and a new one started', () => ({ warns: warns.length, requests: requests.length }), (seen) => seen.warns === 1 && seen.requests >= 2, 5_000);
    assert.ok(signals.every((signal) => signal instanceof AbortSignal), 'every request must carry a timeout');
  } finally { keepAwake.stop(); }
});

test('stop() ends it for good, and start() twice does not double it up', async () => {
  const { keepAwake, requests, busy } = harness({ intervalMs: 20 });
  keepAwake.start(); keepAwake.start();
  busy.value = true;
  await eventually('some requests', () => requests.length, (count) => count >= 2);
  keepAwake.stop();
  await sleep(40); // let a request that was already on its way land
  const before = requests.length;
  await sleep(150);
  assert.equal(requests.length, before);
});

test('the health address is built correctly whatever the form of the public address', () => {
  const targets = ['https://studio.example.test', 'https://studio.example.test/', 'http://127.0.0.1:3001'].map(async (publicUrl) => {
    const seen: string[] = [];
    const keepAwake = new KeepAwake({ publicUrl, intervalMs: 1_000, isBusy: () => true, logger: { info: () => undefined, warn: () => undefined } as never, fetchImpl: (async (input: string | URL | Request) => { seen.push(String(input)); return new Response('{}'); }) as typeof fetch });
    await keepAwake.tick();
    return seen[0];
  });
  return Promise.all(targets).then((urls) => assert.deepEqual(urls, ['https://studio.example.test/api/health', 'https://studio.example.test/api/health', 'http://127.0.0.1:3001/api/health']));
});
