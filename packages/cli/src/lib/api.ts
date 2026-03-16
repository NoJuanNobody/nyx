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

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API request failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<T>;
}
