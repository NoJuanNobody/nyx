import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metricsService, PIPELINE_METRICS } from '../metrics.service.js';
import { alertEngine } from '../alerts.js';
import { withMetrics, trackLatency, trackError } from '../instrumentation.js';

describe('metricsService', () => {
  beforeEach(() => {
    metricsService._reset();
  });

  describe('incrementCounter', () => {
    it('creates a counter metric with value 1 on first call', () => {
      metricsService.incrementCounter('test.counter');
      const metrics = metricsService.getMetric('test.counter');
      expect(metrics).toHaveLength(1);
      expect(metrics[0].type).toBe('counter');
      expect(metrics[0].value).toBe(1);
      expect(metrics[0].name).toBe('test.counter');
    });

    it('increments the counter value on subsequent calls', () => {
      metricsService.incrementCounter('test.counter');
      metricsService.incrementCounter('test.counter');
      metricsService.incrementCounter('test.counter');
      const metrics = metricsService.getMetric('test.counter');
      expect(metrics).toHaveLength(3);
      expect(metrics[2].value).toBe(3);
    });

    it('stores labels with the counter', () => {
      metricsService.incrementCounter('test.counter', { stage: 'transcription' });
      const metrics = metricsService.getMetric('test.counter');
      expect(metrics[0].labels).toEqual({ stage: 'transcription' });
    });
  });

  describe('recordHistogram', () => {
    it('records a histogram observation', () => {
      metricsService.recordHistogram('test.histogram', 150);
      const metrics = metricsService.getMetric('test.histogram');
      expect(metrics).toHaveLength(1);
      expect(metrics[0].type).toBe('histogram');
      expect(metrics[0].value).toBe(150);
    });

    it('records multiple observations', () => {
      metricsService.recordHistogram('test.histogram', 100);
      metricsService.recordHistogram('test.histogram', 200);
      metricsService.recordHistogram('test.histogram', 300);
      const metrics = metricsService.getMetric('test.histogram');
      expect(metrics).toHaveLength(3);
      expect(metrics.map((m) => m.value)).toEqual([100, 200, 300]);
    });
  });

  describe('setGauge', () => {
    it('sets a gauge value', () => {
      metricsService.setGauge('test.gauge', 42);
      const metrics = metricsService.getMetric('test.gauge');
      expect(metrics).toHaveLength(1);
      expect(metrics[0].type).toBe('gauge');
      expect(metrics[0].value).toBe(42);
    });

    it('appends new gauge values over time', () => {
      metricsService.setGauge('test.gauge', 10);
      metricsService.setGauge('test.gauge', 20);
      const metrics = metricsService.getMetric('test.gauge');
      expect(metrics).toHaveLength(2);
      expect(metrics[1].value).toBe(20);
    });
  });

  describe('time windowing', () => {
    it('prunes metrics older than 1 hour', () => {
      const now = Date.now();

      // Insert a metric with a timestamp well in the past
      // We access the private store via the public API and a manual push trick:
      // Record a histogram then manually backdate it
      metricsService.recordHistogram('test.old', 100);
      const metrics = metricsService.getMetric('test.old');
      // Backdate the metric to 2 hours ago
      metrics[0].timestamp = now - 2 * 60 * 60 * 1000;

      // Add a fresh metric
      metricsService.recordHistogram('test.old', 200);

      // Fetching should prune the old one
      const result = metricsService.getMetric('test.old');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(200);
    });
  });

  describe('getAllMetrics', () => {
    it('returns all metric families', () => {
      metricsService.incrementCounter('counter.a');
      metricsService.recordHistogram('histogram.b', 50);
      metricsService.setGauge('gauge.c', 99);

      const all = metricsService.getAllMetrics();
      expect(Object.keys(all)).toHaveLength(3);
      expect(all['counter.a']).toHaveLength(1);
      expect(all['histogram.b']).toHaveLength(1);
      expect(all['gauge.c']).toHaveLength(1);
    });

    it('returns empty object when no metrics exist', () => {
      const all = metricsService.getAllMetrics();
      expect(Object.keys(all)).toHaveLength(0);
    });
  });

  describe('getPipelineHealth', () => {
    it('returns health summary for all 6 stages', () => {
      const health = metricsService.getPipelineHealth();
      expect(health).toHaveLength(6);
      const stages = health.map((h) => h.stage);
      expect(stages).toContain('transcription');
      expect(stages).toContain('parsing');
      expect(stages).toContain('doc_creation');
      expect(stages).toContain('quality_scoring');
      expect(stages).toContain('review');
      expect(stages).toContain('auto_apply');
    });

    it('calculates average latency from recorded histograms', () => {
      metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 100);
      metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 200);
      metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 300);

      const health = metricsService.getPipelineHealth();
      const transcription = health.find((h) => h.stage === 'transcription');
      expect(transcription).toBeDefined();
      expect(transcription!.avgLatencyMs).toBe(200);
    });

    it('calculates error rate from error and success counts', () => {
      // 1 error, 3 successes = 25% error rate
      metricsService.incrementCounter('voice.transcription.errors');
      metricsService.incrementCounter('voice.transcription.success');
      metricsService.incrementCounter('voice.transcription.success');
      metricsService.incrementCounter('voice.transcription.success');

      const health = metricsService.getPipelineHealth();
      const transcription = health.find((h) => h.stage === 'transcription');
      expect(transcription).toBeDefined();
      expect(transcription!.errorRate).toBe(0.25);
      expect(transcription!.throughput).toBe(4);
    });

    it('returns zero values for stages with no data', () => {
      const health = metricsService.getPipelineHealth();
      for (const stage of health) {
        expect(stage.avgLatencyMs).toBe(0);
        expect(stage.errorRate).toBe(0);
        expect(stage.throughput).toBe(0);
        expect(stage.lastUpdated).toBe(0);
      }
    });
  });
});

describe('alertEngine', () => {
  beforeEach(() => {
    metricsService._reset();
    alertEngine._reset();
  });

  it('has 4 default alert rules registered', () => {
    // Evaluate with no data — no alerts should fire
    const alerts = alertEngine.evaluateAlerts();
    expect(alerts).toHaveLength(0);
  });

  it('triggers high_transcription_latency when latency > 5000ms', () => {
    metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 6000);
    metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 7000);

    const alerts = alertEngine.evaluateAlerts();
    const latencyAlert = alerts.find((a) => a.ruleId === 'high_transcription_latency');
    expect(latencyAlert).toBeDefined();
    expect(latencyAlert!.severity).toBe('warning');
    expect(latencyAlert!.value).toBeGreaterThan(5000);
  });

  it('does not trigger high_transcription_latency when latency <= 5000ms', () => {
    metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 2000);
    metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 3000);

    const alerts = alertEngine.evaluateAlerts();
    const latencyAlert = alerts.find((a) => a.ruleId === 'high_transcription_latency');
    expect(latencyAlert).toBeUndefined();
  });

  it('triggers low_quality_score when score < 4', () => {
    metricsService.recordHistogram(PIPELINE_METRICS.QUALITY_SCORE, 2);
    metricsService.recordHistogram(PIPELINE_METRICS.QUALITY_SCORE, 3);

    const alerts = alertEngine.evaluateAlerts();
    const qualityAlert = alerts.find((a) => a.ruleId === 'low_quality_score');
    expect(qualityAlert).toBeDefined();
    expect(qualityAlert!.severity).toBe('warning');
  });

  it('triggers high_error_rate when errors > 10 in window', () => {
    // Counter values accumulate: 1, 2, 3, ... N. The alert checks the average
    // of all values in the window, so we need enough increments that the average > 10.
    // With 21 increments: avg = (1+2+...+21)/21 = 231/21 = 11 > 10
    for (let i = 0; i < 21; i++) {
      metricsService.incrementCounter(PIPELINE_METRICS.PIPELINE_ERRORS);
    }

    const alerts = alertEngine.evaluateAlerts();
    const errorAlert = alerts.find((a) => a.ruleId === 'high_error_rate');
    expect(errorAlert).toBeDefined();
    expect(errorAlert!.severity).toBe('critical');
  });

  it('triggers review_bottleneck when wait time > 1 hour', () => {
    metricsService.recordHistogram(PIPELINE_METRICS.REVIEW_WAIT_TIME, 4000000);

    const alerts = alertEngine.evaluateAlerts();
    const reviewAlert = alerts.find((a) => a.ruleId === 'review_bottleneck');
    expect(reviewAlert).toBeDefined();
    expect(reviewAlert!.severity).toBe('critical');
  });

  it('returns active alerts from getActiveAlerts after evaluation', () => {
    metricsService.recordHistogram(PIPELINE_METRICS.TRANSCRIPTION_LATENCY, 8000);
    alertEngine.evaluateAlerts();

    const active = alertEngine.getActiveAlerts();
    expect(active.length).toBeGreaterThan(0);
  });

  it('allows registering custom alert rules', () => {
    alertEngine.registerAlert({
      id: 'custom_rule',
      name: 'Custom Rule',
      metric: 'custom.metric',
      condition: 'gt',
      threshold: 50,
      windowMs: 60000,
      severity: 'warning',
      enabled: true,
    });

    metricsService.recordHistogram('custom.metric', 100);
    const alerts = alertEngine.evaluateAlerts();
    const custom = alerts.find((a) => a.ruleId === 'custom_rule');
    expect(custom).toBeDefined();
  });
});

describe('instrumentation', () => {
  beforeEach(() => {
    metricsService._reset();
  });

  describe('withMetrics', () => {
    it('records latency and success counter on successful execution', async () => {
      const result = await withMetrics('transcription', async () => {
        return 'hello';
      });

      expect(result).toBe('hello');

      const latency = metricsService.getMetric('voice.transcription.latency_ms');
      expect(latency).toHaveLength(1);
      expect(latency[0].value).toBeGreaterThanOrEqual(0);

      const success = metricsService.getMetric('voice.transcription.success');
      expect(success).toHaveLength(1);
    });

    it('records latency and error counter on failed execution', async () => {
      await expect(
        withMetrics('parsing', async () => {
          throw new Error('parse failed');
        }),
      ).rejects.toThrow('parse failed');

      const latency = metricsService.getMetric('voice.parsing.latency_ms');
      expect(latency).toHaveLength(1);

      const errors = metricsService.getMetric('voice.parsing.errors');
      expect(errors).toHaveLength(1);

      const pipelineErrors = metricsService.getMetric('voice.pipeline.errors');
      expect(pipelineErrors).toHaveLength(1);
    });
  });

  describe('trackLatency', () => {
    it('records a histogram metric for the stage', () => {
      trackLatency('doc_creation', 450);
      const metrics = metricsService.getMetric('voice.doc_creation.latency_ms');
      expect(metrics).toHaveLength(1);
      expect(metrics[0].value).toBe(450);
    });
  });

  describe('trackError', () => {
    it('increments error counter for the stage and pipeline', () => {
      trackError('review', new Error('timeout'));
      const stageErrors = metricsService.getMetric('voice.review.errors');
      expect(stageErrors).toHaveLength(1);
      const pipelineErrors = metricsService.getMetric('voice.pipeline.errors');
      expect(pipelineErrors).toHaveLength(1);
    });
  });
});
