/**
 * Authentication helper for the MCP server.
 * Uses API keys (sd_...) to authenticate against the Nyx API.
 */

export interface AuthConfig {
  apiKey: string;
  baseUrl: string;
}

let authConfig: AuthConfig | null = null;

export function configure(config: AuthConfig) {
  authConfig = config;
}

export function getConfig(): AuthConfig {
  if (!authConfig) {
    throw new Error(
      'MCP server not configured. Set NYX_API_KEY and NYX_API_URL environment variables.',
    );
  }
  return authConfig;
}

/**
 * Make an authenticated request to the Nyx API.
 */
export async function apiRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const config = getConfig();
  const url = `${config.baseUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Nyx API error ${res.status}: ${body || res.statusText}`);
  }

  return res.json() as Promise<T>;
}
