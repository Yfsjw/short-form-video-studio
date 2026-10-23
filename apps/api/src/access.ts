import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * An optional access code for the whole service (the ACCESS_CODE setting). It is not an account system: there is one code, shared by
 * the people who are allowed in. Without it anybody who can reach the address can upload videos and see every job, which is fine while
 * the service is a private test and not once it is public (every upload costs processing time, storage and, with a hosted speech
 * service, money).
 *
 * How it works: a person types the code once on /login and gets a cookie that proves it; a program sends the code itself in an
 * `Authorization: Bearer` (or `X-Access-Code`) header. The code is compared in constant time, never put in a URL, and never written to
 * a log. The cookie holds no copy of the code: it is a keyed fingerprint made with a deliberately slow function, so a leaked cookie
 * cannot be turned back into the code by trying guesses at speed. It survives restarts (a free instance sleeps often) and stops
 * working the moment the code is changed.
 */
export const ACCESS_COOKIE_NAME = 'studio_access';
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const MIN_ACCESS_CODE_LENGTH = 8;

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export interface AccessHeaders { cookie?: string; authorization?: string; 'x-access-code'?: string | string[]; }

export interface AccessGate {
  /** Whether a code is required at all. */
  readonly enabled: boolean;
  /** Whether what was typed (or sent) is the code. Always false when no code is required. */
  codeIsRight(candidate: unknown): boolean;
  /** What the cookie that proves the code was given holds. Empty when no code is required. */
  readonly cookieValue: string;
  /** Whether a request may go on: nothing is required, or it carries the cookie, or the code itself in a header. */
  allows(headers: AccessHeaders): boolean;
}

export function createAccessGate(code: string | undefined): AccessGate {
  if (code === undefined) return { enabled: false, codeIsRight: () => false, cookieValue: '', allows: () => true };
  if (code.length < MIN_ACCESS_CODE_LENGTH) throw new Error(`The access code must be at least ${MIN_ACCESS_CODE_LENGTH} characters long.`);
  const expected = digest(code);
  const key = scryptSync(code, 'short-form-video-studio/access-cookie/v1', 32);
  const cookieValue = `v1.${createHmac('sha256', key).update('session').digest('base64url')}`;
  const expectedCookie = Buffer.from(cookieValue, 'utf8');
  const codeIsRight = (candidate: unknown) => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1000 && sameBytes(digest(candidate), expected);
  return {
    enabled: true,
    codeIsRight,
    cookieValue,
    allows(headers) {
      const cookie = readCookie(headers.cookie, ACCESS_COOKIE_NAME);
      if (cookie !== undefined && sameBytes(Buffer.from(cookie, 'utf8'), expectedCookie)) return true;
      const bearer = /^Bearer\s+(\S.*)$/i.exec((headers.authorization ?? '').trim())?.[1];
      if (bearer !== undefined && codeIsRight(bearer.trim())) return true;
      const header = headers['x-access-code'];
      return codeIsRight(Array.isArray(header) ? header[0] : header);
    },
  };
}

/** One cookie out of a `Cookie` header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Where to send a person after they have given the code: only a place on this server. A full address, an address that starts with
 * two slashes or a backslash (browsers read those as another site), anything with a control character (browsers drop tabs and
 * line breaks inside an address) and the login page itself all fall back to the upload page.
 */
export function safeNextPath(value: unknown, fallback = '/test-upload'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return fallback;
  if (value[0] !== '/' || value[1] === '/' || value[1] === '\\') return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  if (/^\/(login|logout)(?:[/?#]|$)/.test(value)) return fallback;
  return value;
}

/**
 * Slows down guessing: after `maxFailures` wrong codes from one client within `windowMs`, that client must wait for the window to end.
 * Only failures count and one right code clears them, so the person who owns the code is never locked out by someone else's guesses
 * (clients are told apart by address; behind a shared address that is best effort, which is why the code must also be long enough).
 */
export class FailedAttemptLimiter {
  private readonly clients = new Map<string, { failures: number; since: number }>();
  constructor(private readonly options: { maxFailures: number; windowMs: number; maxClients?: number }, private readonly now: () => number = Date.now) {}

  /** How many seconds this client must wait before trying again; 0 when it may try now. */
  waitSeconds(client: string): number {
    const entry = this.clients.get(client);
    if (!entry) return 0;
    const remaining = entry.since + this.options.windowMs - this.now();
    if (remaining <= 0) { this.clients.delete(client); return 0; }
    return entry.failures >= this.options.maxFailures ? Math.ceil(remaining / 1000) : 0;
  }

  recordFailure(client: string): void {
    const now = this.now();
    const entry = this.clients.get(client);
    if (entry && entry.since + this.options.windowMs > now) { entry.failures += 1; return; }
    this.clients.delete(client);
    this.clients.set(client, { failures: 1, since: now });
    this.trim(now);
  }

  recordSuccess(client: string): void { this.clients.delete(client); }

  /** How many addresses are being remembered right now (never more than `maxClients`). */
  get trackedClients(): number { return this.clients.size; }

  /** Never keeps more than `maxClients` addresses in memory, whatever someone sends: the finished windows go first, then the oldest. */
  private trim(now: number): void {
    const limit = this.options.maxClients ?? 5000;
    if (this.clients.size <= limit) return;
    for (const [client, entry] of this.clients) if (entry.since + this.options.windowMs <= now) this.clients.delete(client);
    for (const client of this.clients.keys()) { if (this.clients.size <= limit) break; this.clients.delete(client); }
  }
}
