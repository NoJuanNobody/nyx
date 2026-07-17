import { useEffect, useState } from 'react';
import { MetricsDashboard } from '../components/MetricsDashboard';
import { fetchObservabilityDashboard, markOnboardingStep } from '../lib/api';

interface PipelineHealthSummary {
  stage: string;
  avgLatencyMs: number;
  errorRate: number;
  throughput: number;
  lastUpdated: number;
}

interface AlertEvent {
  ruleId: string;
  metric: string;
  value: number;
  threshold: number;
  triggeredAt: number;
  severity: 'warning' | 'critical';
}

interface DashboardData {
  metrics: Record<string, unknown[]>;
  alerts: AlertEvent[];
  pipelineHealth: PipelineHealthSummary[];
}

const REFRESH_INTERVAL_MS = 30_000;

export function ObservabilityPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    markOnboardingStep('observability-visited').catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetchObservabilityDashboard();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Observability</h1>
        <p className="text-sm text-slate-500 mt-1">
          Monitor pipeline health, decision throughput, and review bottlenecks.
        </p>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {data && (
        <MetricsDashboard pipelineHealth={data.pipelineHealth} alerts={data.alerts} />
      )}
    </div>
    </div>
  );
}
