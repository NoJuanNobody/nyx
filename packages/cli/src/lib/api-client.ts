/**
 * Minimal HTTP client for the Nyx API.
 * Uses native fetch (Node 18+).
 */

const DEFAULT_BASE_URL = 'http://localhost:3001';

export function getBaseUrl(): string {
  return process.env.NYX_API_URL || DEFAULT_BASE_URL;
}

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, getBaseUrl());
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = process.env.NYX_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}
