export type MetricType = 'counter' | 'histogram' | 'gauge';

export type PipelineStage =
  | 'transcription'
  | 'parsing'
  | 'doc_creation'
  | 'quality_scoring'
  | 'review'
  | 'auto_apply';

export interface Metric {
  name: string;
  type: MetricType;
  value: number;
  labels?: Record<string, string>;
  timestamp: number;
}

export interface HistogramBucket {
  le: number;
  count: number;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq';
  threshold: number;
  windowMs: number;
  severity: 'warning' | 'critical';
  enabled: boolean;
}

export interface AlertEvent {
  ruleId: string;
  metric: string;
  value: number;
  threshold: number;
  triggeredAt: number;
  severity: 'warning' | 'critical';
}

export interface PipelineHealthSummary {
  stage: PipelineStage;
  avgLatencyMs: number;
  errorRate: number;
  throughput: number;
  lastUpdated: number;
}

export interface DashboardData {
  metrics: Record<string, Metric[]>;
  alerts: AlertEvent[];
  pipelineHealth: PipelineHealthSummary[];
}
