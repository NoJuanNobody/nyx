/**
 * Backwards-compatible re-export layer.
 *
 * All new code should import from './lifecycles' directly.
 * This file keeps existing imports working by delegating to the
 * software_development lifecycle in the lifecycle registry.
 */
import {
  getLifecycle,
  getNextStage as lifecycleGetNextStage,
  type StageInfo,
} from './lifecycles';

export type { StageInfo } from './lifecycles';

// Widened from a 5-value union to string to support all lifecycle pipelines
export type DocumentStage = string;

const sw = getLifecycle('software_development');

export const STAGES: StageInfo[] = sw.stages;

export const STAGE_MAP: Record<string, StageInfo> = Object.fromEntries(
  STAGES.map((s) => [s.id, s]),
);

export const STAGE_ORDER: string[] = STAGES.map((s) => s.id);

export function getNextStage(current: string): string | null {
  return lifecycleGetNextStage(current, 'software_development');
}

export const CONNECTORS: string[] = sw.connectors;

export const STAGE_SUGGESTIONS: Record<string, string[]> = sw.suggestions;
