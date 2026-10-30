import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

// ── Mocks ────────────────────────────────────────────────────────────

// Hoisted mock state — vi.mock factories run before module init, so we
// capture the references via vi.hoisted.
const mocks = vi.hoisted(() => {
  return {
    fetchDocument: vi.fn(),
    updateDocument: vi.fn(),
  };
});

vi.mock('../../lib/api', () => ({
  fetchDocument: mocks.fetchDocument,
  updateDocument: mocks.updateDocument,
  // Other api functions referenced by the editor — return safe stubs.
  createVersion: vi.fn(),
  createDocument: vi.fn(),
  seedNextStage: vi.fn(),
  exportJupyterNotebook: vi.fn(),
  exportPlainText: vi.fn(),
  exportDocx: vi.fn(),
  exportPdf: vi.fn(),
}));

// Stub out heavy child components — they pull in markdown rendering,
// AI panels, drawers, etc. that are irrelevant to the bug under test.
vi.mock('../../components/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}));

vi.mock('../../components/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    controller,
  }: {
    value: string;
    controller: {
      textareaRef: React.RefObject<HTMLTextAreaElement>;
      handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    };
  }) => (
    <textarea
      data-testid="markdown-editor"
      ref={controller.textareaRef}
      value={value}
      onChange={controller.handleChange}
    />
  ),
}));

vi.mock('../../components/MarkdownToolbar', () => ({
  MarkdownToolbar: () => <div data-testid="markdown-toolbar" />,
}));

vi.mock('../../components/Modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('../../components/AIEditReview', () => ({
  AIEditReview: () => <div data-testid="ai-edit-review" />,
}));

vi.mock('../../components/DocDrawer', () => ({
  DocDrawer: () => <div data-testid="doc-drawer" />,
  DocDrawerToggle: () => <div data-testid="doc-drawer-toggle" />,
}));

vi.mock('../../components/AIAdvisor', () => ({
  AIAdvisor: () => <div data-testid="ai-advisor" />,
}));

vi.mock('../../components/BulkTicketReview', () => ({
  BulkTicketReview: () => null,
}));

vi.mock('../../components/SaveAsTemplateButton', () => ({
  SaveAsTemplateButton: () => null,
}));

vi.mock('../../components/MeetingNoteQuality', () => ({
  MeetingNoteQuality: () => null,
}));

// Import the component AFTER all mocks are declared.
import { DocumentEditor } from '../../pages/DocumentEditor';

// ── Helpers ──────────────────────────────────────────────────────────

type DocFixture = { id: string; title: string; content: string; teamId: string };

const DOC_A: DocFixture = {
  id: 'doc-a',
  title: 'Doc A Title',
  content: 'Doc A content body',
  teamId: 'team-1',
};

const DOC_B: DocFixture = {
  id: 'doc-b',
  title: 'Doc B Title',
  content: 'Doc B content body',
  teamId: 'team-1',
};

function makeDocResponse(d: DocFixture) {
  return {
    ...d,
    path: '/',
    createdById: 'user-1',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    stage: null,
    deletedAt: null,
  };
}

/**
 * Tiny helper component that exposes router navigation to the test via a
 * ref — lets the test trigger a route change at a precise moment.
 */
function NavigationProbe({ onReady }: { onReady: (nav: (to: string) => void) => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    onReady((to) => navigate(to));
  }, [navigate, onReady]);
  return null;
}

function renderEditor(initialPath: string, onNavReady: (nav: (to: string) => void) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/app/documents/:id"
            element={
              <>
                <NavigationProbe onReady={onNavReady} />
                <DocumentEditor />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ────────────────────────────────────────────────────────────

import { loadDraft, saveDraft } from '../../lib/draftStore';

describe('DocumentEditor — autosave, offline drafts and shortcuts (AI-63)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.fetchDocument.mockImplementation(async (id: string) => makeDocResponse(id === DOC_B.id ? DOC_B : DOC_A));
    mocks.updateDocument.mockImplementation(async (id: string, data: { title?: string; content?: string }) =>
      makeDocResponse({ ...(id === DOC_B.id ? DOC_B : DOC_A), ...data }),
    );
  });

  it('flushes a pending edit to its own document when navigating away (no lost edits)', async () => {
    let nav: (to: string) => void = () => {};
    renderEditor('/app/documents/doc-a', (n) => {
      nav = n;
    });
    const titleInput = (await screen.findByDisplayValue(DOC_A.title)) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Edited A title' } });
    await act(async () => {
      nav('/app/documents/doc-b');
    });
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalled());
    const calls = mocks.updateDocument.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('doc-a');
    expect(calls[0][1].title).toBe('Edited A title');
    await waitFor(() => expect(screen.getByDisplayValue(DOC_B.title)).toBeInTheDocument());
  });

  it('Ctrl+S saves immediately instead of waiting for the debounce', async () => {
    renderEditor('/app/documents/doc-a', () => {});
    const titleInput = (await screen.findByDisplayValue(DOC_A.title)) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Quick save' } });
    expect(mocks.updateDocument).not.toHaveBeenCalled();
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledWith('doc-a', expect.objectContaining({ title: 'Quick save' })));
  });

  it('keeps a failed save as a local draft and retries when the connection returns', async () => {
    mocks.updateDocument.mockRejectedValueOnce(new Error('offline'));
    renderEditor('/app/documents/doc-a', () => {});
    const titleInput = (await screen.findByDisplayValue(DOC_A.title)) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Offline edit' } });
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Unsaved changes'));
    expect(loadDraft('doc-a')?.title).toBe('Offline edit');

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledTimes(2));
    expect(mocks.updateDocument.mock.calls[1][1].title).toBe('Offline edit');
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Saved'));
    expect(loadDraft('doc-a')).toBeNull();
  });

  it('restores an unsaved local draft made against the same server version and re-saves it', async () => {
    saveDraft('doc-a', { title: 'Draft title', content: 'Draft body', baseUpdatedAt: '2025-01-01T00:00:00Z' });
    renderEditor('/app/documents/doc-a', () => {});
    expect(await screen.findByDisplayValue('Draft title')).toBeInTheDocument();
    expect((screen.getByTestId('markdown-editor') as HTMLTextAreaElement).value).toBe('Draft body');
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledWith('doc-a', { title: 'Draft title', content: 'Draft body' }), {
      timeout: 2000,
    });
  });

  it('ignores a draft made against an older server version', async () => {
    saveDraft('doc-a', { title: 'Old draft', content: 'Old body', baseUpdatedAt: '2024-01-01T00:00:00Z' });
    renderEditor('/app/documents/doc-a', () => {});
    expect(await screen.findByDisplayValue(DOC_A.title)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Old draft')).toBeNull();
  });

  it('typing in the editor autosaves the content for the open document only', async () => {
    renderEditor('/app/documents/doc-a', () => {});
    await screen.findByDisplayValue(DOC_A.title);
    const editor = screen.getByTestId('markdown-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'New body' } });
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledWith('doc-a', { title: DOC_A.title, content: 'New body' }), {
      timeout: 2000,
    });
  });

  it('Ctrl+\\ cycles the layout and exposes pressed state on the mode buttons', async () => {
    renderEditor('/app/documents/doc-a', () => {});
    await screen.findByDisplayValue(DOC_A.title);
    expect(screen.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true }));
    });
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('DocumentEditor — stale debounced save across documents (issue #344)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mocks.fetchDocument.mockImplementation(async (id: string) => {
      if (id === DOC_A.id) return makeDocResponse(DOC_A);
      if (id === DOC_B.id) return makeDocResponse(DOC_B);
      throw new Error(`Unknown doc id: ${id}`);
    });

    mocks.updateDocument.mockImplementation(async (id: string, data: { title?: string; content?: string }) => {
      const base = id === DOC_A.id ? DOC_A : DOC_B;
      return makeDocResponse({ ...base, ...data });
    });
  });

  it('does not call updateDocument with the new id and the previous doc updates', async () => {
    let triggerNavigation: (to: string) => void = () => {};
    renderEditor('/app/documents/doc-a', (nav) => {
      triggerNavigation = nav;
    });

    // Wait for doc A to load and seed the title input.
    const titleInput = (await screen.findByDisplayValue(DOC_A.title)) as HTMLInputElement;

    // Type into the title — this arms the 500ms debounce timer. Use
    // fireEvent for a synchronous, immediate state update so we can
    // navigate before the debounce fires.
    fireEvent.change(titleInput, { target: { value: 'Edited A title' } });

    // Sanity: the timer is armed but not yet fired (no immediate save).
    expect(mocks.updateDocument).not.toHaveBeenCalled();

    // Within the debounce window (well under 500ms), navigate to doc B.
    await act(async () => {
      triggerNavigation('/app/documents/doc-b');
    });

    // Wait long enough for any uncancelled debounce timer to fire AND for
    // doc B's query to settle.
    await waitFor(
      () => {
        expect(mocks.fetchDocument).toHaveBeenCalledWith('doc-b');
      },
      { timeout: 2000 },
    );
    // Give any in-flight (incorrectly uncancelled) timer enough wall time.
    await new Promise((r) => setTimeout(r, 700));

    // Critical assertion: updateDocument must NEVER have been called with
    // doc-b as the id when the data was doc-a's edits. Either it was
    // called with doc-a (the cancellation didn't fire in time but the
    // capture-and-bail correctly used the captured id) or not called at all.
    for (const call of mocks.updateDocument.mock.calls) {
      const [calledId, calledData] = call;
      if (calledId === 'doc-b') {
        // If it was called for doc-b at all, the data must NOT contain the
        // edited A title — that would be the corruption bug.
        expect(calledData.title).not.toBe('Edited A title');
      }
    }
  });

  it('never simultaneously displays doc B URL and doc A content', async () => {
    // Make doc B's fetch slow so we can observe the in-between render
    // where the URL is doc-b but no doc data has loaded yet.
    let resolveB: ((v: ReturnType<typeof makeDocResponse>) => void) | null = null;
    mocks.fetchDocument.mockImplementation(async (id: string) => {
      if (id === DOC_A.id) return makeDocResponse(DOC_A);
      if (id === DOC_B.id) {
        return new Promise<ReturnType<typeof makeDocResponse>>((resolve) => {
          resolveB = resolve;
        });
      }
      throw new Error(`Unknown id: ${id}`);
    });

    let triggerNavigation: (to: string) => void = () => {};
    renderEditor('/app/documents/doc-a', (nav) => {
      triggerNavigation = nav;
    });

    // Wait for doc A's title to appear.
    await screen.findByDisplayValue(DOC_A.title);

    // Navigate to doc B (wrap in act so React flushes the state updates
    // synchronously before we inspect).
    await act(async () => {
      triggerNavigation('/app/documents/doc-b');
    });

    // At this point the route is /app/documents/doc-b but doc B has NOT been
    // delivered by the query yet. Doc A's content/title must NOT be
    // visible anywhere on the page — the editor should be in its
    // loading state instead.
    expect(screen.queryByDisplayValue(DOC_A.title)).toBeNull();
    expect(screen.queryByText(DOC_A.content)).toBeNull();
    // And the loading placeholder should be visible.
    expect(screen.getByText(/Loading document/i)).toBeInTheDocument();

    // Also: any input element that is rendered must NOT contain doc A's
    // title (defensive belt-and-suspenders check across all renders).
    const titleInputs = screen.queryAllByRole('textbox') as HTMLInputElement[];
    for (const inp of titleInputs) {
      expect(inp.value).not.toBe(DOC_A.title);
    }

    // Now resolve doc B's fetch and confirm the editor catches up.
    await act(async () => {
      resolveB?.(makeDocResponse(DOC_B));
    });
    await waitFor(() => {
      expect(screen.getByDisplayValue(DOC_B.title)).toBeInTheDocument();
    });
  });

  it('seeds title and content for a freshly-opened document and does not clobber subsequent user edits on refetch', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/app/documents/doc-a']}>
          <Routes>
            <Route path="/app/documents/:id" element={<DocumentEditor />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const titleInput = (await screen.findByDisplayValue(DOC_A.title)) as HTMLInputElement;

    // Type a new title.
    fireEvent.change(titleInput, { target: { value: 'My Edit' } });
    expect(titleInput.value).toBe('My Edit');

    // Force a refetch by invalidating the query.
    await qc.invalidateQueries({ queryKey: ['document', 'doc-a'] });

    // Wait a tick for refetch to resolve.
    await waitFor(() => {
      expect(mocks.fetchDocument).toHaveBeenCalledTimes(2);
    });

    // The user's edit MUST still be present — refetch must not clobber it.
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('My Edit');
  });
});
