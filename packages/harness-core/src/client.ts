/**
 * NyxClient — a protocol-free HTTP client for the Nyx API.
 * Accepts config via constructor or falls back to environment variables.
 * No dependency on MCP SDK, OpenAI SDK, or any AI protocol.
 */

export interface NyxClientConfig {
  apiKey: string;
  apiUrl?: string;
  teamId?: string;
}

export class NyxClient {
  private readonly _apiKey: string;
  private readonly _apiUrl: string;
  private readonly _teamId: string;

  constructor(config?: Partial<NyxClientConfig>) {
    this._apiKey = config?.apiKey ?? process.env.NYX_API_KEY ?? '';
    this._apiUrl =
      config?.apiUrl ?? process.env.NYX_API_URL ?? 'https://nyx-api.up.railway.app';
    this._teamId = config?.teamId ?? process.env.NYX_TEAM_ID ?? '';

    if (!this._apiKey) {
      throw new Error(
        'NyxClient: apiKey is required (set NYX_API_KEY or pass config.apiKey)',
      );
    }
  }

  get apiUrl(): string {
    return this._apiUrl;
  }

  get apiKey(): string {
    return this._apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this._apiUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._apiKey}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `NyxClient ${method} ${path} → ${response.status}: ${text || response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async getRaw(path: string): Promise<Response> {
    const url = `${this._apiUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `NyxClient GET ${path} → ${response.status}: ${text || response.statusText}`,
      );
    }

    return response;
  }

  async postRaw(path: string, body?: unknown): Promise<Response> {
    const url = `${this._apiUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._apiKey}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `NyxClient POST ${path} → ${response.status}: ${text || response.statusText}`,
      );
    }

    return response;
  }

  getTeamId(): string {
    return this._teamId;
  }
}
