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

function statusColor(errorRate: number, avgLatencyMs: number): string {
  if (errorRate > 0.1 || avgLatencyMs > 5000) return 'bg-red-500';
  if (errorRate > 0.05 || avgLatencyMs > 2000) return 'bg-yellow-500';
  return 'bg-green-500';
}

function formatStage(stage: string): string {
  return stage
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function LatencyBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <svg className="w-full h-3" viewBox="0 0 200 12" aria-label={`Latency: ${value}ms`}>
      <rect x="0" y="0" width="200" height="12" rx="2" className="fill-slate-200" />
      <rect
        x="0"
        y="0"
        width={Math.round(pct * 2)}
        height="12"
        rx="2"
        className={pct > 80 ? 'fill-red-400' : pct > 50 ? 'fill-yellow-400' : 'fill-blue-400'}
      />
    </svg>
  );
}

function SeverityBadge({ severity }: { severity: 'warning' | 'critical' }) {
  const classes =
    severity === 'critical'
      ? 'bg-red-100 text-red-800 border-red-200'
      : 'bg-yellow-100 text-yellow-800 border-yellow-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${classes}`}>
      {severity}
    </span>
  );
}

export function MetricsDashboard({
  pipelineHealth,
  alerts,
}: {
  pipelineHealth: PipelineHealthSummary[];
  alerts: AlertEvent[];
}) {
  const maxLatency = Math.max(...pipelineHealth.map((s) => s.avgLatencyMs), 1);

  return (
    <div className="space-y-6">
      {/* Pipeline Stage Cards */}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Pipeline Health</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {pipelineHealth.map((stage) => (
            <div
              key={stage.stage}
              className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium text-slate-800">{formatStage(stage.stage)}</h4>
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor(stage.errorRate, stage.avgLatencyMs)}`} />
              </div>
              <div className="space-y-1.5 text-xs text-slate-500">
                <div className="flex justify-between">
                  <span>Avg Latency</span>
                  <span className="font-mono text-slate-700">{stage.avgLatencyMs.toFixed(1)}ms</span>
                </div>
                <LatencyBar value={stage.avgLatencyMs} max={maxLatency} />
                <div className="flex justify-between">
                  <span>Error Rate</span>
                  <span className="font-mono text-slate-700">{(stage.errorRate * 100).toFixed(2)}%</span>
                </div>
                <div className="flex justify-between">
                  <span>Throughput</span>
                  <span className="font-mono text-slate-700">{stage.throughput} ops</span>
                </div>
                {stage.lastUpdated > 0 && (
                  <div className="text-[10px] text-slate-400 pt-1">
                    Last updated: {new Date(stage.lastUpdated).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Active Alerts */}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-3">
          Active Alerts
          {alerts.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
              {alerts.length}
            </span>
          )}
        </h3>
        {alerts.length === 0 ? (
          <p className="text-sm text-slate-400">No active alerts</p>
        ) : (
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <li
                key={`${alert.ruleId}-${alert.triggeredAt}`}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-slate-800">{alert.ruleId.replace(/_/g, ' ')}</p>
                  <p className="text-xs text-slate-500">
                    {alert.metric}: {alert.value} (threshold: {alert.threshold})
                  </p>
                </div>
                <SeverityBadge severity={alert.severity} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
