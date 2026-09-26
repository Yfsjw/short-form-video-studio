import type { ProductionManifest, VideoRequest } from './types.js';
import type { ContentDirector, ResearchProvider, ScriptProvider, VisualPlanner } from './providers.js';

export class ProductionPlanner {
  constructor(
    private readonly director: ContentDirector,
    private readonly researcher: ResearchProvider,
    private readonly scriptWriter: ScriptProvider,
    private readonly visualPlanner: VisualPlanner
  ) {}

  async plan(request: VideoRequest): Promise<ProductionManifest> {
    const brief = await this.director.createBrief(request);
    const research = await this.researcher.research(brief);
    const scenes = await this.scriptWriter.createScript(brief, research);
    const plan = await this.visualPlanner.createManifest(request, brief, research, scenes);

    return {
      schemaVersion: 1,
      jobId: 'planner-generated',
      request,
      brief,
      research,
      scenes,
      assets: plan.assets,
      voice: plan.voice,
      edit: plan.edit
    };
  }
}
