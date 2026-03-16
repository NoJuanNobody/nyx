import type { FastifyPluginAsync } from 'fastify';
import { metricsService } from '../services/observability/metrics.service.js';
import { alertEngine } from '../services/observability/alerts.js';
import type { DashboardData } from '../services/observability/types.js';

export const observabilityRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/observability/metrics — Return all current metrics
  app.get('/metrics', async () => {
    return metricsService.getAllMetrics();
  });

  // GET /api/observability/dashboard — Return aggregated dashboard data
  app.get('/dashboard', async () => {
    const metrics = metricsService.getAllMetrics();
    const alerts = alertEngine.evaluateAlerts();
    const pipelineHealth = metricsService.getPipelineHealth();

    const dashboard: DashboardData = {
      metrics,
      alerts,
      pipelineHealth,
    };

    return dashboard;
  });

  // GET /api/observability/alerts — Return active alerts
  app.get('/alerts', async () => {
    return alertEngine.evaluateAlerts();
  });

  // GET /api/observability/pipeline-health — Return per-stage health summary
  app.get('/pipeline-health', async () => {
    return metricsService.getPipelineHealth();
  });
};
