import type { FastifyPluginAsync } from 'fastify';
import { config } from '../lib/config.js';

// Shared contract consumed by the web app. Keep these fields exactly.
export interface ModelInfo {
  id: string;                  // e.g. "anthropic/claude-sonnet-4"
  name: string;
  contextLength: number;       // tokens
  promptPricePerM: number;     // USD per 1,000,000 input tokens
  completionPricePerM: number; // USD per 1,000,000 output tokens
  paramsB: number | null;      // billions of params, best-effort (usually null)
  modality: string;            // e.g. "text->text"
}

// ── Curated fallback ─────────────────────────────────────────────────
// Returned whenever the OpenRouter catalog can't be fetched (network error,
// or no API key configured and the unauthenticated fetch fails). This keeps
// the model-picker UI populated with sensible defaults instead of empty.
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    contextLength: 200000,
    promptPricePerM: 3,
    completionPricePerM: 15,
    paramsB: null,
    modality: 'text->text',
  },
  {
    id: 'anthropic/claude-3.5-haiku',
    name: 'Claude 3.5 Haiku',
    contextLength: 200000,
    promptPricePerM: 0.8,
    completionPricePerM: 4,
    paramsB: null,
    modality: 'text->text',
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    contextLength: 128000,
    promptPricePerM: 2.5,
    completionPricePerM: 10,
    paramsB: null,
    modality: 'text->text',
  },
  {
    id: 'google/gemini-2.0-flash-001',
    name: 'Gemini 2.0 Flash',
    contextLength: 1000000,
    promptPricePerM: 0.1,
    completionPricePerM: 0.4,
    paramsB: null,
    modality: 'text->text',
  },
];

// ── Module-level cache (~1h TTL) ─────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000;
let cachedModels: ModelInfo[] | null = null;
let cachedAt = 0;

interface OpenRouterModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string };
  description?: string;
}

// Best-effort parse of a parameter count (in billions) from a model's name or
// description, e.g. "Llama 70B" -> 70. OpenRouter exposes no reliable
// param-count field, so this is heuristic only and returns null when absent.
function parseParamsB(name: string | undefined, description: string | undefined): number | null {
  const haystack = `${name ?? ''} ${description ?? ''}`;
  const match = haystack.match(/(\d+(?:\.\d+)?)\s*B\b/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function normalize(raw: OpenRouterModel[]): ModelInfo[] {
  return raw
    .filter((m): m is OpenRouterModel & { id: string } => typeof m.id === 'string')
    .map((m) => {
      // pricing.prompt / pricing.completion are USD-per-token STRINGS → ×1e6.
      const promptPerToken = Number.parseFloat(m.pricing?.prompt ?? '0');
      const completionPerToken = Number.parseFloat(m.pricing?.completion ?? '0');
      return {
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.context_length ?? 0,
        promptPricePerM: (Number.isFinite(promptPerToken) ? promptPerToken : 0) * 1e6,
        completionPricePerM: (Number.isFinite(completionPerToken) ? completionPerToken : 0) * 1e6,
        paramsB: parseParamsB(m.name, m.description),
        modality: m.architecture?.modality ?? 'text->text',
      };
    });
}

async function fetchModels(): Promise<ModelInfo[]> {
  const now = Date.now();
  if (cachedModels && now - cachedAt < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const headers: Record<string, string> = {};
    // Only send Authorization when a key is configured; the endpoint is also
    // reachable unauthenticated.
    if (config.OPENROUTER_API_KEY) {
      headers.Authorization = `Bearer ${config.OPENROUTER_API_KEY}`;
    }

    const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
    if (!res.ok) {
      throw new Error(`OpenRouter responded ${res.status}`);
    }

    const body = (await res.json()) as { data?: OpenRouterModel[] };
    const models = normalize(body.data ?? []);
    if (models.length === 0) {
      throw new Error('OpenRouter returned an empty model list');
    }

    cachedModels = models;
    cachedAt = now;
    return models;
  } catch {
    // Network/parse error or unset key + failed fetch → curated fallback so the
    // UI always renders. Cache it briefly to avoid hammering on repeated errors.
    cachedModels = FALLBACK_MODELS;
    cachedAt = now;
    return FALLBACK_MODELS;
  }
}

// Auth: this plugin is registered after the app-wide preHandler auth hook in
// app.ts (which rejects any non-public route lacking request.user), so no
// per-route preHandler is needed here.
export const modelsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/models — normalized OpenRouter model catalog (cached ~1h).
  app.get('/', async () => {
    const models = await fetchModels();
    return { models };
  });
};
