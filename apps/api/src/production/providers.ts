import type {
  ArtifactRef,
  ContentBrief,
  ProductionManifest,
  QcReport,
  ResearchItem,
  ScriptScene,
  VideoRequest
} from './types.js';

export interface ContentDirector {
  createBrief(request: VideoRequest): Promise<ContentBrief>;
}

export interface ResearchProvider {
  research(brief: ContentBrief): Promise<ResearchItem[]>;
}

export interface ScriptProvider {
  createScript(brief: ContentBrief, research: ResearchItem[]): Promise<ScriptScene[]>;
}

export interface VisualPlanner {
  createManifest(
    request: VideoRequest,
    brief: ContentBrief,
    research: ResearchItem[],
    scenes: ScriptScene[]
  ): Promise<Pick<ProductionManifest, 'assets' | 'voice' | 'edit'>>;
}

export interface AssetProvider {
  materialize(manifest: ProductionManifest): Promise<ArtifactRef[]>;
}

export interface VoiceProvider {
  materialize(manifest: ProductionManifest): Promise<ArtifactRef[]>;
}

export interface Renderer {
  render(manifest: ProductionManifest, artifacts: ArtifactRef[]): Promise<ArtifactRef>;
}

export interface QualityController {
  inspect(video: ArtifactRef): Promise<QcReport>;
}
