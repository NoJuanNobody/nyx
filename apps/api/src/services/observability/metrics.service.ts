import type { Metric, MetricType, PipelineHealthSummary, PipelineStage } from './types.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Pre-defined pipeline metric names */
export const PIPELINE_METRICS = {
  TRANSCRIPTION_LATENCY: 'voice.transcription.latency_ms',
  PARSING_LATENCY: 'voice.parsing.latency_ms',
  DOC_CREATION_LATENCY: 'voice.doc_creation.latency_ms',
  QUALITY_SCORE: 'voice.quality.score',
  REVIEW_QUEUE_DEPTH: 'voice.review.queue_depth',
  REVIEW_WAIT_TIME: 'voice.review.wait_time_ms',
  AUTO_APPLY_RATE: 'voice.auto_apply.rate',
  REJECTION_RATE: 'voice.rejection.rate',
  PIPELINE_ERRORS: 'voice.pipeline.errors',
} as const;

const STAGE_LATENCY_MAP: Record<PipelineStage, string> = {
  transcription: PIPELINE_METRICS.TRANSCRIPTION_LATENCY,
  parsing: PIPELINE_METRICS.PARSING_LATENCY,
  doc_creation: PIPELINE_METRICS.DOC_CREATION_LATENCY,
  quality_scoring: PIPELINE_METRICS.QUALITY_SCORE,
  review: PIPELINE_METRICS.REVIEW_WAIT_TIME,
  auto_apply: PIPELINE_METRICS.AUTO_APPLY_RATE,
};

const STAGE_ERROR_METRIC = (stage: PipelineStage) => `voice.${stage}.errors`;
const STAGE_SUCCESS_METRIC = (stage: PipelineStage) => `voice.${stage}.success`;

class MetricsService {
  private store = new Map<string, Metric[]>();

  /** Prune entries older than the retention window */
  private prune(name: string): void {
    const entries = this.store.get(name);
    if (!entries) return;
    const cutoff = Date.now() - ONE_HOUR_MS;
    const pruned = entries.filter((m) => m.timestamp >= cutoff);
    if (pruned.length === 0) {
      this.store.delete(name);
    } else {
      this.store.set(name, pruned);
    }
  }

  private push(metric: Metric): void {
    const existing = this.store.get(metric.name) ?? [];
    existing.push(metric);
    this.store.set(metric.name, existing);
    this.prune(metric.name);
  }

  incrementCounter(name: string, labels?: Record<string, string>): void {
    const existing = this.store.get(name) ?? [];
    const last = existing[existing.length - 1];
    const value = last && last.type === 'counter' ? last.value + 1 : 1;
    this.push({ name, type: 'counter', value, labels, timestamp: Date.now() });
  }

  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    this.push({ name, type: 'histogram', value, labels, timestamp: Date.now() });
  }

  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    this.push({ name, type: 'gauge', value, labels, timestamp: Date.now() });
  }

  getMetric(name: string): Metric[] {
    this.prune(name);
    return this.store.get(name) ?? [];
  }

  getAllMetrics(): Record<string, Metric[]> {
    const result: Record<string, Metric[]> = {};
    for (const name of this.store.keys()) {
      this.prune(name);
      const entries = this.store.get(name);
      if (entries && entries.length > 0) {
        result[name] = entries;
      }
    }
    return result;
  }

  getPipelineHealth(): PipelineHealthSummary[] {
    const stages: PipelineStage[] = [
      'transcription',
      'parsing',
      'doc_creation',
      'quality_scoring',
      'review',
      'auto_apply',
    ];

    return stages.map((stage) => {
      const latencyMetric = STAGE_LATENCY_MAP[stage];
      const latencyEntries = this.getMetric(latencyMetric);
      const errorEntries = this.getMetric(STAGE_ERROR_METRIC(stage));
      const successEntries = this.getMetric(STAGE_SUCCESS_METRIC(stage));

      const avgLatencyMs =
        latencyEntries.length > 0
          ? latencyEntries.reduce((sum, m) => sum + m.value, 0) / latencyEntries.length
          : 0;

      const totalOps = errorEntries.length + successEntries.length;
      const errorRate = totalOps > 0 ? errorEntries.length / totalOps : 0;

      const lastUpdated =
        latencyEntries.length > 0
          ? Math.max(...latencyEntries.map((m) => m.timestamp))
          : 0;

      return {
        stage,
        avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
        errorRate: Math.round(errorRate * 10000) / 10000,
        throughput: totalOps,
        lastUpdated,
      };
    });
  }

  /** Reset all metrics — useful for testing */
  _reset(): void {
    this.store.clear();
  }
}

export const metricsService = new MetricsService();
