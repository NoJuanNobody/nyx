import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock state ─────────────────────────────────────────────────

let selectResults: unknown[][] = [];
let selectCallIdx = 0;

function nextSelectResult() {
  const result = selectResults[selectCallIdx] ?? [];
  selectCallIdx++;
  return result;
}

const mockUpdateSet = vi.fn().mockReturnValue({
  where: vi.fn().mockResolvedValue([]),
});
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

vi.doMock('../../db/index.js', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => nextSelectResult()),
        })),
      })),
    })),
    update: vi.fn().mockImplementation(() => mockUpdate()),
  },
}));

vi.doMock('../../db/schema.js', () => ({
  apiKeys: { keyHash: 'keyHash', revoked: 'revoked', id: 'id', userId: 'userId', expiresAt: 'expiresAt' },
  users: { id: 'id' },
}));

vi.doMock('../../lib/config.js', () => ({
  config: {
    PORT: 3001,
    NODE_ENV: 'test',
    MCP_SELF_URL: 'http://localhost:3001',
    // Left unset so the RFC 9728 metadata base URL is derived from the request
    // host (the deployment-safe path) rather than falling back to localhost.
    WEBHOOK_BASE_URL: undefined,
    APP_URL: 'http://localhost:5173',
    CLERK_PUBLISHABLE_KEY: undefined,
  },
}));

// Mock MCP SDK
const mockServerSetRequestHandler = vi.fn();
const mockServerConnect = vi.fn().mockResolvedValue(undefined);
const mockServerClose = vi.fn().mockResolvedValue(undefined);
const MockServer = vi.fn().mockImplementation(() => ({
  setRequestHandler: mockServerSetRequestHandler,
  connect: mockServerConnect,
  close: mockServerClose,
}));

vi.doMock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: MockServer,
}));

// handleRequest must end the response so Fastify's inject() resolves.
// The real StreamableHTTPServerTransport always calls res.end() internally.
const mockHandleRequest = vi.fn().mockImplementation(
  (_req: unknown, res: { writeHead?: (...args: unknown[]) => void; end?: (data?: string) => void }) => {
    res.writeHead?.(200, { 'Content-Type': 'application/json' });
    res.end?.(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
    return Promise.resolve();
  },
);
const MockTransport = vi.fn().mockImplementation(() => ({
  handleRequest: mockHandleRequest,
}));

vi.doMock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: MockTransport,
}));

vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: 'list_tools',
  CallToolRequestSchema: 'call_tool',
}));

// Mock harness-core
const mockExecuteTool = vi.fn().mockResolvedValue({ teams: [] });
vi.doMock('@nyx/harness-core', () => ({
  TOOL_DEFINITIONS: [
    { name: 'nyx_list_teams', description: 'List teams', inputSchema: { type: 'object', properties: {} } },
    { name: 'nyx_read_file', description: 'Read file', inputSchema: { type: 'object', properties: {} } },
    { name: 'nyx_web_search', description: 'Web search', inputSchema: { type: 'object', properties: {} } },
  ],
  executeTool: mockExecuteTool,
  NyxClient: vi.fn().mockImplementation(() => ({})),
}));

// ── Build the Fastify app with just the MCP route ─────────────────────

async function buildTestApp() {
  const Fastify = (await import('fastify')).default;
  const { mcpRoutes } = await import('../mcp.js');

  const app = Fastify({ logger: false });
  app.register(mcpRoutes);
  await app.ready();
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-id',
    keyHash: 'hashed',
    revoked: false,
    expiresAt: null,
    userId: 'user-id',
    ...overrides,
  };
}

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-id',
    email: 'test@example.com',
    name: 'Test User',
    avatarUrl: null,
    clerkId: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('mcpRoutes', () => {
  beforeEach(() => {
    selectResults = [];
    selectCallIdx = 0;
    vi.clearAllMocks();
    // Must call res.end() so Fastify's inject() resolves (real transport always does).
    mockHandleRequest.mockImplementation(
      (_req: unknown, res: { writeHead?: (...args: unknown[]) => void; end?: (d?: string) => void }) => {
        res.writeHead?.(200, { 'Content-Type': 'application/json' });
        res.end?.(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
        return Promise.resolve();
      },
    );
    mockServerConnect.mockResolvedValue(undefined);
    mockServerClose.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
  });

  describe('GET /.well-known/oauth-protected-resource', () => {
    it('returns protected resource metadata', async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('resource');
      expect(body.resource).toContain('/api/mcp');
      expect(body).toHaveProperty('bearer_methods_supported');
      expect(body.bearer_methods_supported).toContain('header');
    });

    it('derives the resource URL from the request host (never localhost) when WEBHOOK_BASE_URL is unset', async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.nyx-creative.com' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.resource).toBe('https://api.nyx-creative.com/api/mcp');
    });
  });

  describe('POST /api/mcp', () => {
    it('returns 401 with WWW-Authenticate when Authorization header is missing', async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBeDefined();
      expect(res.headers['www-authenticate']).toContain('Bearer');
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });

    it('returns 401 with WWW-Authenticate when API key is invalid', async () => {
      // validateApiKey: key lookup returns empty
      selectResults = [[]];
      const app = await buildTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: 'Bearer sd_invalid' },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('invalid_token');
    });

    it('calls transport.handleRequest when sd_ key is valid', async () => {
      // Two DB queries: key lookup + user lookup
      selectResults = [[makeKeyRow()], [makeUserRow()]];
      const app = await buildTestApp();
      await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: 'Bearer sd_validkey' },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(mockServerConnect).toHaveBeenCalledOnce();
      expect(mockHandleRequest).toHaveBeenCalledOnce();
    });

    it('filters local-only tools from tool list', async () => {
      // Capture the ListTools handler registered on the server
      const handlers: Record<string, (req: unknown) => unknown> = {};
      mockServerSetRequestHandler.mockImplementation((schema, handler) => {
        handlers[String(schema)] = handler;
      });

      selectResults = [[makeKeyRow()], [makeUserRow()]];
      const app = await buildTestApp();
      await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: 'Bearer sd_validkey' },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });

      const listHandler = handlers['list_tools'];
      expect(listHandler).toBeDefined();
      const result = await listHandler({}) as { tools: Array<{ name: string }> };
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('nyx_list_teams');
      expect(names).not.toContain('nyx_read_file');
      expect(names).not.toContain('nyx_web_search');
    });
  });
});
