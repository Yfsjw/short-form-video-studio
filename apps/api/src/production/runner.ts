import { ProductionMediaWorker, type MediaRenderResult } from './media-worker.js';
import { inspectRenderedVideo } from './qc.js';
import type { ProductionManifest, QcReport } from './types.js';

export interface ProductionRunResult {
  render: MediaRenderResult;
  qc: QcReport;
}

export class ProductionRunner {
  constructor(
    private readonly mediaWorker: ProductionMediaWorker,
    private readonly workDir: string,
  ) {}

  async run(manifest: ProductionManifest): Promise<ProductionRunResult> {
    const render = await this.mediaWorker.render(manifest, this.workDir);
    const qc = await inspectRenderedVideo(render.video.path);
    if (!qc.passed) {
      throw new Error(`Rendered video failed quality control: ${qc.checks.filter((check) => !check.passed).map((check) => check.name).join(', ')}`);
    }
    return { render, qc };
  }
}
