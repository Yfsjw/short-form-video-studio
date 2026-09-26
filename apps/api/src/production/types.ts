export type ProductionStage =
  | 'planning'
  | 'researching'
  | 'scripting'
  | 'visual_planning'
  | 'asset_generation'
  | 'voice_generation'
  | 'editing'
  | 'captioning'
  | 'sound_design'
  | 'rendering'
  | 'quality_control'
  | 'completed'
  | 'failed';

export type AssetKind =
  | 'video'
  | 'image'
  | 'screenshot'
  | 'graphic'
  | 'typography'
  | 'audio';

export interface VideoRequest {
  prompt: string;
  targetDurationSeconds?: number;
  aspectRatio?: '9:16' | '16:9' | '1:1';
  language?: string;
  voiceStyle?: string;
}

export interface ContentBrief {
  title: string;
  premise: string;
  audience: string;
  angle: string;
  targetDurationSeconds: number;
  language: string;
}

export interface ResearchItem {
  id: string;
  claim: string;
  sourceUrl: string;
  sourceTitle?: string;
  publishedAt?: string;
  retrievedAt: string;
}

export interface ScriptScene {
  id: string;
  narration: string;
  estimatedDurationSeconds: number;
  purpose: 'hook' | 'context' | 'evidence' | 'explanation' | 'example' | 'transition' | 'payoff' | 'cta';
}

export interface AssetSpec {
  id: string;
  kind: AssetKind;
  sceneId: string;
  description: string;
  durationSeconds?: number;
  sourceUrl?: string;
  localPath?: string;
  required: boolean;
}

export interface VoiceSpec {
  id: string;
  sceneId: string;
  text: string;
  language: string;
  style?: string;
  localPath?: string;
}

export interface EditDecision {
  id: string;
  sceneId: string;
  assetId: string;
  startSeconds: number;
  endSeconds: number;
  crop?: { x: number; y: number; width: number; height: number };
  transition?: 'cut' | 'crossfade';
}

export interface ProductionManifest {
  schemaVersion: 1;
  jobId: string;
  request: VideoRequest;
  brief: ContentBrief;
  research: ResearchItem[];
  scenes: ScriptScene[];
  assets: AssetSpec[];
  voice: VoiceSpec[];
  edit: EditDecision[];
}

export interface ArtifactRef {
  type: 'json' | 'audio' | 'video' | 'image' | 'subtitle';
  path: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface QcReport {
  passed: boolean;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
  checks: Array<{ name: string; passed: boolean; details: string }>;
}

export interface ProductionJob {
  id: string;
  stage: ProductionStage;
  status: 'queued' | 'running' | 'completed' | 'failed';
  manifestPath?: string;
  artifacts: ArtifactRef[];
  qc?: QcReport;
  error?: string;
}
