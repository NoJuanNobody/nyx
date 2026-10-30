import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  TOOL_DEFINITIONS,
  executeTool as harnessExecuteTool,
  type ToolDefinition,
} from '@nyx/harness-core';
import { NyxClient } from '@nyx/harness-core';
import { getConfig } from './auth.js';
import { performWebSearch } from './search/search.service.js';
import { CREDIT_TOOL_DEFINITIONS, executeCreditTool, isCreditTool } from './credits.js';

const MAX_FILE_SIZE = 100 * 1024; // 100 KB

export type { ToolDefinition };
const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [...TOOL_DEFINITIONS, ...CREDIT_TOOL_DEFINITIONS];
export { ALL_TOOL_DEFINITIONS as TOOL_DEFINITIONS };

/**
 * Build a NyxClient from the current auth configuration.
 */
function buildClient(): NyxClient {
  const config = getConfig();
  return new NyxClient({ apiKey: config.apiKey, apiUrl: config.baseUrl });
}

/**
 * Execute a tool call. API-backed tools are handled by @nyx/harness-core.
 * Environment-specific tools (web search, local filesystem) are handled here.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (isCreditTool(name)) return executeCreditTool(name, args);

  // Handle environment-specific tools before delegating to harness-core
  switch (name) {
    case 'nyx_web_search': {
      const query = args.query as string;
      const searchType = (args.search_type as string) ?? 'general';
      const maxResults = Math.min(Math.max((args.max_results as number) ?? 5, 1), 10);
      return performWebSearch(query, searchType, maxResults);
    }
    case 'nyx_read_file': {
      const filePath = nodePath.resolve(args.path as string);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        throw new Error(
          `Path is a directory, not a file: ${filePath}. Use nyx_list_files instead.`,
        );
      }
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${Math.round(stats.size / 1024)} KB (max 100 KB)`);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = nodePath.extname(filePath).slice(1) || 'txt';
      return { path: filePath, extension: ext, content };
    }
    case 'nyx_list_files': {
      const dirPath = nodePath.resolve((args.path as string) ?? '.');
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      }));
    }
    default: {
      // All API-backed tools are handled by harness-core
      const client = buildClient();
      return harnessExecuteTool(name, args, client);
    }
  }
}
