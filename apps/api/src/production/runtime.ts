import type { ProductionManifest, VideoRequest } from './types.js';
import { ProductionPlanner } from './planner.js';

export interface ProductionRuntime {
  planner: ProductionPlanner;
  request: (input: VideoRequest) => Promise<ProductionManifest>;
}

export function createProductionRuntime(planner: ProductionPlanner): ProductionRuntime {
  return {
    planner,
    request: (input) => planner.plan(input)
  };
}
