import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Config (CLERK_PUBLISHABLE_KEY unset → metadata uses the minimal fallback,
//    and the base URL is derived from the request host) ────────────────────
vi.doMock('../../lib/config.js', () => ({
  config: {
    PORT: 3001,
    NODE_ENV: 'test',
    MCP_SELF_URL: 'http://localhost:3001',
    WEBHOOK_BASE_URL: undefined,
    APP_URL: 'http://localhost:5173',
    CLERK_PUBLISHABLE_KEY: undefined,
  },
}));

// ── Clerk OAuth verification + local user resolution ──────────────────────
const mockVerifyOAuth = vi.fn();
vi.doMock('../../lib/clerk.js', () => ({
  verifyClerkOAuthToken: mockVerifyOAuth,
}));

const mockResolveClerkUser = vi.fn();
vi.doMock('../../middleware/auth.js', () => ({
  resolveClerkUser: mockResolveClerkUser,
}));

// ── Credits ───────────────────────────────────────────────────────────────
const mockCheckCredits = vi.fn();
const mockDeductCredits = vi.fn();
vi.doMock('../../services/credits.service.js', () => ({
  checkCredits: mockCheckCredits,
  deductCredits: mockDeductCredits,
  CREDIT_COSTS: {
    document_generation: 3,
    spec_analysis: 1,
    drift_detection: 2,
    ticket_generation: 2,
  },
}));

vi.doMock('@clerk/mcp-tools/server', () => ({
  generateClerkProtectedResourceMetadata: vi.fn(() => ({
    resource: 'clerk-metadata',
    authorization_servers: ['https://clerk.example.com'],
  })),
}));

// ── MCP SDK ─────────────────────────────────────────────────────────────
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
const mockHandleRequest = vi.fn();
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

// ── harness-core ──────────────────────────────────────────────────────────
const mockExecuteTool = vi.fn().mockResolvedValue({ teams: [] });
vi.doMock('@nyx/harness-core', () => ({
  TOOL_DEFINITIONS: [
    { name: 'nyx_list_teams', description: 'List teams', inputSchema: { type: 'object', properties: {} } },
    { name: 'nyx_create_doc', description: 'Create doc', inputSchema: { type: 'object', properties: {} } },
    { name: 'nyx_read_file', description: 'Read file', inputSchema: { type: 'object', properties: {} } },
    { name: 'nyx_web_search', description: 'Web search', inputSchema: { type: 'object', properties: {} } },
  ],
  executeTool: mockExecuteTool,
  NyxClient: vi.fn().mockImplementation(() => ({})),
}));

// ── Build the Fastify app with just the MCP route ─────────────────────────

async function buildTestApp() {
  const Fastify = (await import('fastify')).default;
  const { mcpRoutes } = await import('../mcp.js');

  const app = Fastify({ logger: false });
  app.register(mcpRoutes);
  await app.ready();
  return app;
}

const AUTH_USER = { id: 'user-id', clerkId: 'clerk_1', email: 't@e.com', name: 'T', avatarUrl: null, role: 'owner' };

/** Make the OAuth path succeed and capture the MCP request handlers. */
async function connectAuthenticated(): Promise<Record<string, (req: unknown) => unknown>> {
  const handlers: Record<string, (req: unknown) => unknown> = {};
  mockServerSetRequestHandler.mockImplementation((schema, handler) => {
    handlers[String(schema)] = handler;
  });
  mockVerifyOAuth.mockResolvedValue({ clerkUserId: 'clerk_1', scopes: ['email'] });
  mockResolveClerkUser.mockResolvedValue(AUTH_USER);

  const app = await buildTestApp();
  await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization: 'Bearer oauth_token_abc' },
    payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
  });
  return handlers;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('mcpRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleRequest.mockImplementation(
      (_req: unknown, res: { writeHead?: (...a: unknown[]) => void; end?: (d?: string) => void }) => {
        res.writeHead?.(200, { 'Content-Type': 'application/json' });
        res.end?.(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
        return Promise.resolve();
      },
    );
    mockServerConnect.mockResolvedValue(undefined);
    mockServerClose.mockResolvedValue(undefined);
    mockExecuteTool.mockResolvedValue({ teams: [] });
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

  describe('POST /api/mcp — auth', () => {
    it('returns 401 with WWW-Authenticate when Authorization header is missing', async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer');
    });

    it('returns 401 invalid_token when the OAuth token is not valid', async () => {
      mockVerifyOAuth.mockResolvedValue(null);
      const app = await buildTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: 'Bearer bogus' },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('invalid_token');
      expect(mockServerConnect).not.toHaveBeenCalled();
    });

    it('connects the transport when the OAuth token resolves to a user', async () => {
      mockVerifyOAuth.mockResolvedValue({ clerkUserId: 'clerk_1', scopes: [] });
      mockResolveClerkUser.mockResolvedValue(AUTH_USER);
      const app = await buildTestApp();
      await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: 'Bearer oauth_token_abc' },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(mockServerConnect).toHaveBeenCalledOnce();
      expect(mockHandleRequest).toHaveBeenCalledOnce();
    });
  });

  describe('tool list', () => {
    it('filters local-only tools from the tool list', async () => {
      const handlers = await connectAuthenticated();
      const result = (await handlers['list_tools']({})) as { tools: Array<{ name: string }> };
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('nyx_list_teams');
      expect(names).toContain('nyx_create_doc');
      expect(names).not.toContain('nyx_read_file');
      expect(names).not.toContain('nyx_web_search');
    });
  });

  describe('credit gating', () => {
    it('blocks a credit-costing tool when the balance is insufficient (no execute, no deduct)', async () => {
      mockCheckCredits.mockResolvedValue({ allowed: false, balance: 0, required: 3 });
      const handlers = await connectAuthenticated();

      const result = (await handlers['call_tool']({
        params: { name: 'nyx_create_doc', arguments: { title: 'x' } },
      })) as { isError?: boolean; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Insufficient credits');
      expect(mockCheckCredits).toHaveBeenCalledWith('user-id', 3);
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(mockDeductCredits).not.toHaveBeenCalled();
    });

    it('executes then deducts for a credit-costing tool when the balance is sufficient', async () => {
      mockCheckCredits.mockResolvedValue({ allowed: true, balance: 100, required: 3 });
      mockDeductCredits.mockResolvedValue({ balance: 97 });
      const handlers = await connectAuthenticated();

      const result = (await handlers['call_tool']({
        params: { name: 'nyx_create_doc', arguments: { title: 'x' } },
      })) as { isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(mockExecuteTool).toHaveBeenCalledOnce();
      expect(mockDeductCredits).toHaveBeenCalledWith('user-id', 3, 'document_generation', expect.any(String));
    });

    it('does not touch the credit system for a free (read) tool', async () => {
      const handlers = await connectAuthenticated();

      await handlers['call_tool']({ params: { name: 'nyx_list_teams', arguments: {} } });

      expect(mockExecuteTool).toHaveBeenCalledOnce();
      expect(mockCheckCredits).not.toHaveBeenCalled();
      expect(mockDeductCredits).not.toHaveBeenCalled();
    });
  });
});
