import type { AlertEvent, AlertRule } from './types.js';
import { metricsService, PIPELINE_METRICS } from './metrics.service.js';

class AlertEngine {
  private rules = new Map<string, AlertRule>();
  private activeAlerts: AlertEvent[] = [];

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.registerAlert({
      id: 'high_transcription_latency',
      name: 'High Transcription Latency',
      metric: PIPELINE_METRICS.TRANSCRIPTION_LATENCY,
      condition: 'gt',
      threshold: 5000,
      windowMs: 5 * 60 * 1000,
      severity: 'warning',
      enabled: true,
    });

    this.registerAlert({
      id: 'low_quality_score',
      name: 'Low Quality Score',
      metric: PIPELINE_METRICS.QUALITY_SCORE,
      condition: 'lt',
      threshold: 4,
      windowMs: 5 * 60 * 1000,
      severity: 'warning',
      enabled: true,
    });

    this.registerAlert({
      id: 'high_error_rate',
      name: 'High Error Rate',
      metric: PIPELINE_METRICS.PIPELINE_ERRORS,
      condition: 'gt',
      threshold: 10,
      windowMs: 5 * 60 * 1000,
      severity: 'critical',
      enabled: true,
    });

    this.registerAlert({
      id: 'review_bottleneck',
      name: 'Review Bottleneck',
      metric: PIPELINE_METRICS.REVIEW_WAIT_TIME,
      condition: 'gt',
      threshold: 3600000,
      windowMs: 60 * 60 * 1000,
      severity: 'critical',
      enabled: true,
    });
  }

  registerAlert(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
  }

  evaluateAlerts(): AlertEvent[] {
    const triggered: AlertEvent[] = [];
    const now = Date.now();

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      const metrics = metricsService.getMetric(rule.metric);
      const windowCutoff = now - rule.windowMs;
      const windowMetrics = metrics.filter((m) => m.timestamp >= windowCutoff);

      if (windowMetrics.length === 0) continue;

      const avgValue =
        windowMetrics.reduce((sum, m) => sum + m.value, 0) / windowMetrics.length;

      let isTriggered = false;
      switch (rule.condition) {
        case 'gt':
          isTriggered = avgValue > rule.threshold;
          break;
        case 'lt':
          isTriggered = avgValue < rule.threshold;
          break;
        case 'eq':
          isTriggered = avgValue === rule.threshold;
          break;
      }

      if (isTriggered) {
        triggered.push({
          ruleId: rule.id,
          metric: rule.metric,
          value: Math.round(avgValue * 100) / 100,
          threshold: rule.threshold,
          triggeredAt: now,
          severity: rule.severity,
        });
      }
    }

    this.activeAlerts = triggered;
    return triggered;
  }

  getActiveAlerts(): AlertEvent[] {
    return this.activeAlerts;
  }

  /** Reset all rules and alerts — useful for testing */
  _reset(): void {
    this.rules.clear();
    this.activeAlerts = [];
    this.registerDefaults();
  }

  /** Full reset including defaults — useful for testing */
  _resetAll(): void {
    this.rules.clear();
    this.activeAlerts = [];
  }
}

export const alertEngine = new AlertEngine();
