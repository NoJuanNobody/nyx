#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configure } from './auth.js';
import { createMcpServer } from './server.js';

// Read configuration from environment
const apiKey = process.env.NYX_API_KEY;
const baseUrl = process.env.NYX_API_URL ?? 'http://localhost:3001';

if (!apiKey) {
  console.error('Error: NYX_API_KEY environment variable is required.');
  console.error('Create an API key in Nyx Settings > API Keys.');
  process.exit(1);
}

// Configure auth
configure({ apiKey, baseUrl });

// Create and start server
const server = createMcpServer();
const transport = new StdioServerTransport();

await server.connect(transport);
