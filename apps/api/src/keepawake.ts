import type { Logger } from 'pino';

export interface KeepAwakeOptions {
  /** The service's own public address (on Render: RENDER_EXTERNAL_URL). */
  publicUrl: string;
  /** How often to look for work and, when there is some, to knock on our own front door. */
  intervalMs: number;
  /** True while the service has work that must not be killed: a job being processed or an upload arriving. */
  isBusy: () => boolean;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** How long one request may take before it is given up on. */
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Free Render instances are spun down after 15 minutes without inbound traffic, and whatever they were doing dies
 * with them. A job on a phone-sized upload can easily take longer than that, and nobody is watching the page
 * (a locked phone stops its browser tab from refreshing), so the idle timer would run out in the middle of the work.
 *
 * While there is real work in progress, this requests the service's own public health endpoint every few minutes, so
 * the request travels through Render's front door like a visitor's would. When the work is done it stops, and the
 * instance may sleep as usual. It never touches the database, so it does not keep the database awake either.
 *
 * Best effort, and honestly so: Render does not document whether requests a service makes to itself count as traffic.
 * If they do not, nothing is lost beyond the requests; the job is resumed from durable storage after the restart.
 */
export class KeepAwake {
  private timer: NodeJS.Timeout | undefined;
  private requestRunning = false;
  private knocking = false;
  private failing = false;
  private readonly healthUrl: string;

  constructor(private readonly options: KeepAwakeOptions) {
    this.healthUrl = new URL('/api/health', options.publicUrl).toString();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One round: knock if there is work, otherwise note that the work is over. Never throws. */
  async tick(): Promise<void> {
    if (!this.options.isBusy()) {
      if (this.knocking) {
        this.knocking = false;
        this.options.logger.info('The work is done, so the instance is no longer being kept awake');
      }
      return;
    }
    if (this.requestRunning) return; // the previous request is still on its way
    this.requestRunning = true;
    try {
      const request = this.options.fetchImpl ?? fetch;
      const response = await request(this.healthUrl, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000), headers: { 'user-agent': 'short-form-video-studio-keep-awake' } });
      await response.arrayBuffer().catch(() => undefined); // read the tiny body so the connection is released
      if (!response.ok) throw new Error(`the service answered its own request with HTTP ${response.status}`);
      if (!this.knocking) {
        this.knocking = true;
        this.options.logger.info({ url: this.healthUrl }, 'Work is in progress, so the instance is being kept awake by requesting its own health endpoint');
      }
      if (this.failing) {
        this.failing = false;
        this.options.logger.info('Requests to the service\'s own address work again');
      }
    } catch (error) {
      // Said once per outage rather than on every attempt; the next round simply tries again.
      if (!this.failing) {
        this.failing = true;
        this.options.logger.warn({ err: error, url: this.healthUrl }, 'Could not request the service\'s own address, so a free instance may be spun down while work is in progress');
      }
    } finally {
      this.requestRunning = false;
    }
  }
}
