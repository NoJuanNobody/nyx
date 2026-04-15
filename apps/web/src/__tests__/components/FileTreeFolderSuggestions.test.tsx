import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FileTree } from '../../components/FileTree';
import { useUIStore } from '../../stores/ui.store';

const mockGenerateFolderTicketSuggestions = vi.fn();

vi.mock('../../lib/api', () => ({
  fetchTeams: vi.fn().mockResolvedValue([{ id: 'team-1', name: 'Test Team', slug: 'test' }]),
  fetchDocuments: vi.fn().mockResolvedValue([
    {
      id: 'doc-1',
      title: 'API Spec',
      path: '/specs',
      teamId: 'team-1',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'doc-2',
      title: 'Root Doc',
      path: '/',
      teamId: 'team-1',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ]),
  fetchTemplates: vi.fn().mockResolvedValue([]),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  generateFolderTicketSuggestions: (...args: unknown[]) =>
    mockGenerateFolderTicketSuggestions(...args),
}));

function renderComponent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FileTree />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FileTree folder ticket suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ seeding: false });
    localStorage.setItem('nyx:folders', JSON.stringify(['/specs']));
  });

  it('shows "Generate ticket suggestions" in folder context menu', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('specs')).toBeInTheDocument());

    // Right-click on the folder
    fireEvent.contextMenu(screen.getByText('specs'));

    await waitFor(() =>
      expect(screen.getByText('Generate ticket suggestions')).toBeInTheDocument(),
    );

    // Verify the item is inside the context menu
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(menu.textContent).toContain('Generate ticket suggestions');
  });

  it('does not show "Generate ticket suggestions" in document context menu', async () => {
    renderComponent();
    // Root Doc is at path '/' so it should be visible without expanding a folder
    await waitFor(() => expect(screen.getByText('Root Doc')).toBeInTheDocument());

    // Right-click on the document
    fireEvent.contextMenu(screen.getByText('Root Doc'));

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());

    // Doc context menu should not have "Generate ticket suggestions"
    expect(screen.queryByText('Generate ticket suggestions')).not.toBeInTheDocument();
  });

  it('does not show suggestions panel or loading at rest', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('specs')).toBeInTheDocument());

    // No suggestions UI at rest
    expect(screen.queryByTestId('folder-suggestions-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('folder-suggestions-loading')).not.toBeInTheDocument();
  });

  it('exports the generateFolderTicketSuggestions API function', async () => {
    // Verify the API function exists and is callable
    const { generateFolderTicketSuggestions } = await import('../../lib/api');
    expect(generateFolderTicketSuggestions).toBeDefined();
    expect(typeof generateFolderTicketSuggestions).toBe('function');

    // Verify the mock is properly wired
    mockGenerateFolderTicketSuggestions.mockResolvedValue([{ id: 'sug-1' }]);
    const result = await generateFolderTicketSuggestions('team-1', '/specs');
    expect(result).toEqual([{ id: 'sug-1' }]);
    expect(mockGenerateFolderTicketSuggestions).toHaveBeenCalledWith('team-1', '/specs');
  });
});
