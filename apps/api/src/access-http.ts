import express, { type Express, type Request, type Response } from 'express';
import { ACCESS_COOKIE_MAX_AGE_SECONDS, ACCESS_COOKIE_NAME, safeNextPath, type AccessGate, type FailedAttemptLimiter } from './access.js';
import { renderLoginPage, renderMessagePage } from './pages.js';

/** What stays open when a code is required: the health check (Render's own and the keep-awake request use it) and the way in. */
const OPEN_PATHS = new Set(['/api/health', '/login', '/logout']);

export interface AccessHttpOptions {
  gate: AccessGate;
  limiter: FailedAttemptLimiter;
  /** Whether the site is served over https (the cookie is then marked so that it is never sent over plain http). */
  secureCookie: (req: Request) => boolean;
  /** How long a wrong code is made to wait before it is answered, which makes guessing slower for whoever is guessing. */
  failureDelayMs: number;
  logger: { warn: (fields: object, message: string) => void };
}

/** Puts the access code in front of everything except the health check, and adds the login and logout pages. Does nothing when no code is set. */
export function installAccessGate(app: Express, options: AccessHttpOptions): void {
  const { gate, limiter } = options;
  const client = (req: Request) => req.ip ?? 'unknown';

  app.get('/login', (req, res) => {
    if (!gate.enabled || gate.allows(req.headers)) return res.redirect(302, safeNextPath(req.query.next));
    res.type('html').send(renderLoginPage({ next: safeNextPath(req.query.next) }));
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    const next = safeNextPath(req.body?.next);
    if (!gate.enabled) return res.redirect(303, next);
    const wait = limiter.waitSeconds(client(req));
    if (wait > 0) return res.status(429).setHeader('Retry-After', String(wait)).type('html').send(renderLoginPage({ next, problem: { waitSeconds: wait } }));
    if (gate.codeIsRight(req.body?.code)) {
      limiter.recordSuccess(client(req));
      setCookie(res, gate.cookieValue, ACCESS_COOKIE_MAX_AGE_SECONDS, options.secureCookie(req));
      return res.redirect(303, next);
    }
    limiter.recordFailure(client(req));
    options.logger.warn({ client: client(req) }, 'A wrong access code was given');
    if (options.failureDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, options.failureDelayMs));
    res.status(401).type('html').send(renderLoginPage({ next, problem: 'wrong' }));
  });

  app.get('/logout', (req, res) => {
    setCookie(res, '', 0, options.secureCookie(req));
    res.redirect(302, gate.enabled ? '/login' : '/test-upload');
  });

  if (!gate.enabled) return;
  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path) || gate.allows(req.headers)) return next();
    if (req.path.startsWith('/api/')) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="short-form-video-studio"');
      return res.status(401).json({ error: { code: 'ACCESS_CODE_REQUIRED', message: 'This service needs an access code. Send it as "Authorization: Bearer <code>".' } });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.status(401).type('html').send(renderMessagePage('Access code needed', 'Type the access code first, then try again.', { href: '/login', text: 'Enter the access code' }));
  });
}

function setCookie(res: Response, value: string, maxAgeSeconds: number, secure: boolean): void {
  res.append('Set-Cookie', `${ACCESS_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}
