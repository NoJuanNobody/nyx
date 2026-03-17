import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FileTree } from '../../components/FileTree';
import { useUIStore } from '../../stores/ui.store';

vi.mock('../../lib/api', () => ({
  fetchTeams: vi.fn().mockResolvedValue([{ id: 'team-1', name: 'Test Team', slug: 'test' }]),
  fetchDocuments: vi.fn().mockResolvedValue([
    {
      id: 'doc-1',
      title: 'Test Document',
      status: 'draft',
      path: '/',
      teamId: 'team-1',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ]),
  fetchArchivedDocuments: vi.fn().mockResolvedValue([]),
  fetchTemplates: vi.fn().mockResolvedValue([]),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  restoreDocument: vi.fn(),
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

describe('FileTree seeding overlay', () => {
  beforeEach(() => {
    useUIStore.setState({ seeding: false });
  });

  it('does not show seeding overlay when not seeding', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Explorer')).toBeInTheDocument());
    expect(screen.queryByTestId('seed-loading-overlay')).not.toBeInTheDocument();
  });

  it('shows seeding overlay with spinner when seeding is true', async () => {
    useUIStore.setState({ seeding: true });
    renderComponent();
    await waitFor(() => expect(screen.getByTestId('seed-loading-overlay')).toBeInTheDocument());
    expect(screen.getByText('Seeding next stage...')).toBeInTheDocument();
  });

  it('hides seeding overlay when seeding changes from true to false', async () => {
    useUIStore.setState({ seeding: true });
    const { rerender } = renderComponent();
    await waitFor(() => expect(screen.getByTestId('seed-loading-overlay')).toBeInTheDocument());

    useUIStore.setState({ seeding: false });
    // Force re-render to pick up store change
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FileTree />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('seed-loading-overlay')).not.toBeInTheDocument(),
    );
  });
});
