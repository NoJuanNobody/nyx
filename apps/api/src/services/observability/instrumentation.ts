import type { PipelineStage } from './types.js';
import { metricsService } from './metrics.service.js';

/**
 * Wraps an async function with automatic duration histogram + success/error counter recording.
 * Designed to be imported by other services and wrapped around their core operations.
 */
export async function withMetrics<T>(
  stageName: PipelineStage,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    trackLatency(stageName, duration);
    metricsService.incrementCounter(`voice.${stageName}.success`, { stage: stageName });
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    trackLatency(stageName, duration);
    trackError(stageName, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/** Manual latency recording for a pipeline stage */
export function trackLatency(stage: PipelineStage, durationMs: number): void {
  const metricName = `voice.${stage}.latency_ms`;
  metricsService.recordHistogram(metricName, durationMs, { stage });
}

/** Manual error recording for a pipeline stage */
export function trackError(stage: PipelineStage, error: Error): void {
  metricsService.incrementCounter(`voice.${stage}.errors`, {
    stage,
    error: error.message.slice(0, 100),
  });
  metricsService.incrementCounter('voice.pipeline.errors', { stage });
}
