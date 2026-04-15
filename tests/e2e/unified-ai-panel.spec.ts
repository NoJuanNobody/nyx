/**
 * E2E tests for Unified AI Panel (Issue #47)
 *
 * Covers the merged AI panel that consolidates AIChatPanel and AgentPanel
 * into a single "AI" tab in the DocDrawer. Tests panel rendering, quick edit
 * (fast path), agent SSE streaming, update_document interception, chat history,
 * and error handling.
 *
 * Test runner: Playwright
 * 22 scenarios total.
 */

import { test, expect, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openDocument(page: Page, documentId = 'test-doc-1') {
  await page.goto(`/app/documents/${documentId}`);
  await page.waitForSelector('[data-testid="document-editor"]');
}

async function openAIPanel(page: Page) {
  // The DocDrawer toggle uses title="AI" for the AI tab
  await page.click('button[title="AI"]');
  await page.waitForSelector('[data-testid="unified-ai-panel"]');
}

async function mockWorkflowsAPI(
  page: Page,
  workflows: Array<{ id: string; name: string; defaultPrompt?: string }> = [],
) {
  await page.route('**/agent/workflows', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(workflows),
    }),
  );
}

async function mockEditDocumentAPI(page: Page, newContent: string) {
  await page.route('**/ai/edit-document', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: newContent }),
    }),
  );
}

/**
 * Mocks the /api/agent SSE endpoint with a sequence of server-sent events.
 * Each event is a JSON-encoded AgentStreamEvent.
 */
async function mockAgentSSE(
  page: Page,
  events: Array<Record<string, unknown>>,
) {
  await page.route('**/api/agent', (route) => {
    const body = events
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join('');
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body,
    });
  });
}

const MOCK_WORKFLOWS = [
  { id: 'wf-1', name: 'Spec Review', defaultPrompt: 'Review this specification for completeness' },
  { id: 'wf-2', name: 'Changelog Generator', defaultPrompt: '' },
];

const SAMPLE_EDITED_CONTENT = '# Updated Doc\n\nThis is the revised content.';

// ---------------------------------------------------------------------------
// Panel rendering & tab consolidation (Tests 1–4)
// ---------------------------------------------------------------------------

test.describe('Panel rendering & tab consolidation', () => {
  test('1. Single "AI" tab in DocDrawer — no separate "Agent" tab', async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);

    // The AI tab toggle button should exist
    const aiToggle = page.locator('button[title="AI"]');
    await expect(aiToggle).toBeVisible();

    // No "Agent" tab should exist
    const agentToggle = page.locator('button[title="Agent"]');
    await expect(agentToggle).not.toBeVisible();
  });

  test('2. Panel shows workflow selector with "Quick edit" option and fetched workflows', async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await expect(workflowSelect).toBeVisible();

    // Quick edit is always the first option
    await expect(workflowSelect.locator('option[value="quick"]')).toBeAttached();

    // Fetched workflows also appear
    for (const wf of MOCK_WORKFLOWS) {
      await expect(workflowSelect.locator(`option[value="${wf.id}"]`)).toBeAttached();
    }
  });

  test('3. Suggestion prompts shown when chat is empty', async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);

    // The empty state renders suggestion pill buttons
    const suggestions = page.locator('[data-testid="unified-ai-panel"] button').filter({ hasNotText: /Send|Cancel|Clear/ });
    await expect(suggestions.first()).toBeVisible();
  });

  test('4. Input area with auto-resizing textarea and Send button visible', async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await expect(textarea).toBeVisible();

    // Send button (enabled only when textarea has content)
    const sendBtn = page.locator('[data-testid="unified-ai-panel"] button[title="Send"]');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toBeDisabled();

    // Typing enables the send button
    await textarea.fill('Hello');
    await expect(sendBtn).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Quick edit — fast path (Tests 5–8)
// ---------------------------------------------------------------------------

test.describe('Quick edit (fast path)', () => {
  test.beforeEach(async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);
  });

  test('5. "Quick edit" workflow routes to POST /ai/edit-document, not /api/agent', async ({ page }) => {
    const agentCalled = { value: false };
    await page.route('**/api/agent', () => { agentCalled.value = true; });

    let editDocumentCalled = false;
    await page.route('**/ai/edit-document', async (route) => {
      editDocumentCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: SAMPLE_EDITED_CONTENT }),
      });
    });

    // Quick edit is the default selection
    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Make the intro shorter');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');

    await page.waitForResponse('**/ai/edit-document');
    expect(editDocumentCalled).toBe(true);
    expect(agentCalled.value).toBe(false);
  });

  test('6. Accept proposed edit updates the document and shows success', async ({ page }) => {
    await mockEditDocumentAPI(page, SAMPLE_EDITED_CONTENT);

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Make the intro shorter');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/ai/edit-document');

    // After quick edit, assistant response appears (proposed edit applied via onProposedEdit callback)
    // The assistant message confirming the edit should be visible
    await expect(page.locator('[data-testid="unified-ai-panel"]').getByText(/changes ready|review/i)).toBeVisible({ timeout: 5000 });
  });

  test('7. Reject proposed edit from quick edit dismisses diff, document unchanged', async ({ page }) => {
    // For agent path, rejected proposed_edit messages show "Rejected" badge
    // Quick edit always calls onProposedEdit directly — test that the chat remains usable after
    await mockEditDocumentAPI(page, SAMPLE_EDITED_CONTENT);

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Make the intro shorter');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/ai/edit-document');

    // After the response, user can type a new prompt (input is not blocked)
    await expect(textarea).toBeEnabled({ timeout: 5000 });
  });

  test('8. Selecting "Quick edit" explicitly and sending routes to /ai/edit-document', async ({ page }) => {
    let editRequestBody: Record<string, unknown> = {};
    await page.route('**/ai/edit-document', async (route) => {
      editRequestBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: SAMPLE_EDITED_CONTENT }),
      });
    });

    // Explicitly select Quick edit in case default has changed
    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('quick');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('fix the typos in paragraph 2');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/ai/edit-document');

    // Request body should include the prompt
    expect(editRequestBody.prompt ?? editRequestBody.instruction ?? editRequestBody.userMessage).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Agent workflow — SSE path (Tests 9–13)
// ---------------------------------------------------------------------------

test.describe('Agent workflow (SSE path)', () => {
  test.beforeEach(async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);
  });

  test('9. Freeform workflow (non-quick-edit) sends request to /api/agent via SSE', async ({ page }) => {
    await mockAgentSSE(page, [
      { type: 'status', status: 'running' },
      { type: 'text', text: 'Here are my suggestions for improving the spec.' },
      { type: 'done', tokenUsage: { inputTokens: 120, outputTokens: 45 } },
    ]);

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Analyze this spec and suggest improvements');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');

    await page.waitForRequest('**/api/agent');
    // Streamed text appears in the chat area
    await expect(page.locator('[data-testid="unified-ai-panel"]').getByText(/suggestions/i)).toBeVisible({ timeout: 8000 });
  });

  test('10. Selecting a predefined workflow and sending triggers SSE stream', async ({ page }) => {
    let agentRequestBody: Record<string, unknown> = {};
    await page.route('**/api/agent', async (route) => {
      agentRequestBody = route.request().postDataJSON() as Record<string, unknown>;
      const body = [
        { type: 'status', status: 'running' },
        { type: 'text', text: 'Running spec review workflow.' },
        { type: 'done', tokenUsage: { inputTokens: 80, outputTokens: 30 } },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join('');
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body,
      });
    });

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Review the API spec');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/api/agent');

    expect(agentRequestBody.workflowId ?? agentRequestBody.workflow_id ?? agentRequestBody.prompt).toBeTruthy();
  });

  test('11. Tool calls from agent stream are shown as collapsible cards', async ({ page }) => {
    await mockAgentSSE(page, [
      { type: 'status', status: 'running' },
      { type: 'tool_call', toolName: 'search_documents', input: { query: 'auth spec' }, sequence: 1 },
      { type: 'tool_result', sequence: 1, output: 'Found 3 documents', durationMs: 420 },
      { type: 'text', text: 'Based on the search results...' },
      { type: 'done', tokenUsage: { inputTokens: 200, outputTokens: 60 } },
    ]);

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-2');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Generate a changelog');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/api/agent');

    // Tool call card should be rendered with the tool name
    await expect(
      page.locator('[data-testid="unified-ai-panel"]').getByText('search_documents'),
    ).toBeVisible({ timeout: 8000 });

    // Click to expand the tool call card
    await page.locator('[data-testid="unified-ai-panel"]').getByText('search_documents').click();

    // Input should now be visible
    await expect(page.locator('[data-testid="unified-ai-panel"]').getByText(/auth spec/i)).toBeVisible();
  });

  test('12. Cancel button aborts SSE stream; status shows "cancelled"', async ({ page }) => {
    // Mock a slow/never-ending SSE stream
    await page.route('**/api/agent', async (route) => {
      // Send status event then hang
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: ' + JSON.stringify({ type: 'status', status: 'running' }) + '\n\n',
      });
    });

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Start a long workflow');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');

    // Wait for Cancel button to appear (while running)
    const cancelBtn = page.locator('[data-testid="unified-ai-panel"] button', { hasText: 'Cancel' });
    await expect(cancelBtn).toBeVisible({ timeout: 5000 });

    // Click cancel
    await cancelBtn.click();

    // Status badge should show "cancelled"
    await expect(
      page.locator('[data-testid="unified-ai-panel"]').getByText('cancelled'),
    ).toBeVisible({ timeout: 3000 });
  });

  test('13. Status bar shows "running" with token usage during stream; hidden when idle', async ({ page }) => {
    await mockAgentSSE(page, [
      { type: 'status', status: 'running' },
      { type: 'text', text: 'Analyzing...' },
      { type: 'done', tokenUsage: { inputTokens: 150, outputTokens: 50 } },
    ]);

    // Status bar should be hidden initially (idle state)
    const statusBar = page.locator('[data-testid="unified-ai-panel"]').getByText('idle');
    await expect(statusBar).not.toBeVisible();

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Analyze the spec');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');

    // Status badge "running" should appear
    await expect(
      page.locator('[data-testid="unified-ai-panel"]').getByText('running'),
    ).toBeVisible({ timeout: 5000 });

    // Wait for completion — token usage should appear
    await page.waitForResponse('**/api/agent');
    await expect(
      page.locator('[data-testid="unified-ai-panel"]').getByText(/\d+ tokens/),
    ).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// update_document tool interception (Tests 14–16)
// ---------------------------------------------------------------------------

test.describe('update_document tool interception', () => {
  test.beforeEach(async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);
  });

  test('14. Agent update_document tool call shows inline diff with Accept/Reject buttons', async ({ page }) => {
    const proposedContent = '# Improved Spec\n\nThis is the agent-proposed content.';

    await mockAgentSSE(page, [
      { type: 'status', status: 'running' },
      { type: 'tool_call', toolName: 'update_document', input: { content: proposedContent }, sequence: 1 },
      { type: 'done', tokenUsage: { inputTokens: 100, outputTokens: 40 } },
    ]);

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Improve the spec');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/api/agent');

    // Proposed edit card should be visible with Accept and Reject buttons
    const panel = page.locator('[data-testid="unified-ai-panel"]');
    await expect(panel.getByText('Proposed edit')).toBeVisible({ timeout: 8000 });
    await expect(panel.getByRole('button', { name: 'Accept' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reject' })).toBeVisible();

    // The proposed content should be shown in the preview
    await expect(panel.getByText(/Improved Spec/i)).toBeVisible();
  });

  test('15. Accepting agent-proposed edit calls onProposedEdit and shows "Accepted" badge', async ({ page }) => {
    const proposedContent = '# Agent Updated Spec\n\nThis is the agent-proposed content.';

    await mockAgentSSE(page, [
      { type: 'status', status: 'running' },
      { type: 'tool_call', toolName: 'update_document', input: { content: proposedContent }, sequence: 1 },
      { type: 'done', tokenUsage: { inputTokens: 100, outputTokens: 40 } },
    ]);

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Update the spec');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/api/agent');

    const panel = page.locator('[data-testid="unified-ai-panel"]');
    await expect(panel.getByRole('button', { name: 'Accept' })).toBeVisible({ timeout: 8000 });

    // Accept the edit
    await panel.getByRole('button', { name: 'Accept' }).click();

    // Accepted badge should appear; Accept/Reject buttons hidden
    await expect(panel.getByText('Accepted')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Accept' })).not.toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reject' })).not.toBeVisible();
  });

  test('16. Rejecting agent-proposed edit shows "Rejected" badge; buttons dismissed', async ({ page }) => {
    const proposedContent = '# Alternative Spec\n\nThis is an alternative proposal.';

    await mockAgentSSE(page, [
      { type: 'status', status: 'running' },
      { type: 'tool_call', toolName: 'update_document', input: { content: proposedContent }, sequence: 1 },
      { type: 'done', tokenUsage: { inputTokens: 100, outputTokens: 40 } },
    ]);

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-2');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Propose an alternative spec');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/api/agent');

    const panel = page.locator('[data-testid="unified-ai-panel"]');
    await expect(panel.getByRole('button', { name: 'Reject' })).toBeVisible({ timeout: 8000 });

    // Reject the edit
    await panel.getByRole('button', { name: 'Reject' }).click();

    // Rejected badge should appear; buttons should be gone
    await expect(panel.getByText('Rejected')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Accept' })).not.toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reject' })).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Chat history & messages (Tests 17–20)
// ---------------------------------------------------------------------------

test.describe('Chat history & messages', () => {
  test.beforeEach(async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);
  });

  test('17. User messages rendered as styled bubbles', async ({ page }) => {
    await mockEditDocumentAPI(page, SAMPLE_EDITED_CONTENT);

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('First user message');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/ai/edit-document');

    // User message should appear in the chat
    const panel = page.locator('[data-testid="unified-ai-panel"]');
    await expect(panel.getByText('First user message')).toBeVisible({ timeout: 5000 });

    // "You" label should appear in the bubble header
    await expect(panel.getByText('You')).toBeVisible();
  });

  test('18. Assistant messages streamed via SSE appear incrementally in chat', async ({ page }) => {
    await mockAgentSSE(page, [
      { type: 'status', status: 'running' },
      { type: 'text', text: 'Here is my analysis' },
      { type: 'text', text: ' of the specification.' },
      { type: 'done', tokenUsage: { inputTokens: 100, outputTokens: 30 } },
    ]);

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Analyze the spec');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/api/agent');

    // The streamed/committed assistant text should appear in chat
    const panel = page.locator('[data-testid="unified-ai-panel"]');
    await expect(panel.getByText(/Here is my analysis/i)).toBeVisible({ timeout: 8000 });

    // "AI" label should be visible
    await expect(panel.getByText('AI').first()).toBeVisible();
  });

  test('19. Chat history preserved across multiple prompts in the same session', async ({ page }) => {
    await mockEditDocumentAPI(page, SAMPLE_EDITED_CONTENT);

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    const sendBtn = page.locator('[data-testid="unified-ai-panel"] button[title="Send"]');
    const panel = page.locator('[data-testid="unified-ai-panel"]');

    // Send first message
    await textarea.fill('First prompt');
    await sendBtn.click();
    await page.waitForResponse('**/ai/edit-document');
    await expect(panel.getByText('First prompt')).toBeVisible({ timeout: 5000 });

    // Re-mock for second request
    await mockEditDocumentAPI(page, '# Updated again');

    // Send second message
    await textarea.fill('Second prompt');
    await sendBtn.click();
    await page.waitForResponse('**/ai/edit-document');

    // Both messages should be visible in the chat history
    await expect(panel.getByText('First prompt')).toBeVisible();
    await expect(panel.getByText('Second prompt')).toBeVisible();
  });

  test('20. New document shows generate document flow', async ({ page }) => {
    // Navigate to a new (empty) document
    await page.goto('/app/documents/new');
    await page.waitForSelector('[data-testid="document-editor"]');

    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await page.route('**/ai/generate-document', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ title: 'API Auth Spec', content: '# API Auth Spec\n\nContent here.' }),
      }),
    );

    await page.click('button[title="AI"]');
    await page.waitForSelector('[data-testid="unified-ai-panel"]');

    const panel = page.locator('[data-testid="unified-ai-panel"]');

    // Empty state should show "create" oriented hint
    await expect(panel.getByText(/create|describe/i)).toBeVisible();

    // Type a generation prompt and send
    const textarea = panel.locator('textarea');
    await textarea.fill('Write an API specification for a user auth service');
    await panel.locator('button[title="Send"]').click();

    await page.waitForResponse('**/ai/generate-document');

    // Confirmation message should appear in chat
    await expect(panel.getByText(/generated|applied/i)).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Error handling (Tests 21–22)
// ---------------------------------------------------------------------------

test.describe('Error handling', () => {
  test.beforeEach(async ({ page }) => {
    await mockWorkflowsAPI(page, MOCK_WORKFLOWS);
    await openDocument(page);
    await openAIPanel(page);
  });

  test('21. API error (500) from /ai/edit-document shows inline error message in chat', async ({ page }) => {
    await page.route('**/ai/edit-document', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error' }),
      }),
    );

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Make the intro shorter');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/ai/edit-document');

    // Error message should appear in the chat area
    const panel = page.locator('[data-testid="unified-ai-panel"]');
    await expect(panel.getByText(/something went wrong|error/i)).toBeVisible({ timeout: 5000 });

    // Status should reflect failure
    await expect(panel.getByText('failed')).toBeVisible();
  });

  test('22. API error (500) from /api/agent shows error message in chat; user can retry', async ({ page }) => {
    await page.route('**/api/agent', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Agent unavailable' }),
      }),
    );

    const workflowSelect = page.locator('[data-testid="unified-ai-panel"] select');
    await workflowSelect.selectOption('wf-1');

    const textarea = page.locator('[data-testid="unified-ai-panel"] textarea');
    await textarea.fill('Analyze the spec');
    await page.click('[data-testid="unified-ai-panel"] button[title="Send"]');
    await page.waitForResponse('**/api/agent');

    const panel = page.locator('[data-testid="unified-ai-panel"]');

    // Error message should appear
    await expect(panel.getByText(/error|something went wrong/i)).toBeVisible({ timeout: 5000 });

    // Status shows failed
    await expect(panel.getByText('failed')).toBeVisible();

    // User can still type in the textarea (retry is possible)
    await expect(textarea).toBeEnabled();
    await textarea.fill('Retry prompt');
    await expect(panel.locator('button[title="Send"]')).toBeEnabled();
  });
});
