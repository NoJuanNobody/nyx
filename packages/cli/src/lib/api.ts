const DEFAULT_BASE_URL = 'http://localhost:3001';

export function getBaseUrl(): string {
  return process.env.NYX_API_URL || DEFAULT_BASE_URL;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = process.env.NYX_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API request failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<T>;
}
