import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface NyxConfig {
  apiKey: string;
  apiUrl: string;
}

function loadConfigFile(): Partial<NyxConfig> {
  const configPath = join(homedir(), '.nyx', 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as Partial<NyxConfig>;
  } catch {
    return {};
  }
}

function resolveConfig(): NyxConfig {
  const file = loadConfigFile();
  const apiKey = process.env.NYX_API_KEY ?? file.apiKey;
  const apiUrl = process.env.NYX_API_URL ?? file.apiUrl;

  if (!apiKey) {
    throw new Error(
      'Missing API key. Set NYX_API_KEY or run: nyx config set apiKey <key>',
    );
  }
  if (!apiUrl) {
    throw new Error(
      'Missing API URL. Set NYX_API_URL or run: nyx config set apiUrl <url>',
    );
  }

  return { apiKey, apiUrl };
}

export class NyxClient {
  private config: NyxConfig;

  constructor(config?: NyxConfig) {
    this.config = config ?? resolveConfig();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.apiUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${text || res.statusText}`);
    }

    return res.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async getRaw(path: string): Promise<Response> {
    const url = `${this.config.apiUrl}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${text || res.statusText}`);
    }

    return res;
  }
}
