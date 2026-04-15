import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DocumentList } from '../../components/DocumentList';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.hoisted(() => ({
  fetchTeams: vi.fn().mockResolvedValue([{ id: 'team-1', name: 'Test Team' }]),
  fetchDocuments: vi.fn().mockResolvedValue([
    { id: 'doc-1', title: 'Feature Spec', content: '# Feature', updatedAt: '2026-01-15T00:00:00Z' },
    { id: 'doc-2', title: 'API Design', content: '# API', updatedAt: '2026-01-14T00:00:00Z' },
  ]),
  createDocument: vi.fn().mockResolvedValue({ id: 'new-doc-1' }),
  generateAllDocuments: vi.fn().mockResolvedValue({
    results: [
      { documentId: 'doc-1', title: 'Feature Spec', status: 'success' },
      { documentId: 'doc-2', title: 'API Design', status: 'success' },
    ],
    total: 2,
    succeeded: 2,
    failed: 0,
  }),
}));

vi.mock('../../lib/api', () => mockApi);

function renderComponent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DocumentList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.fetchTeams.mockResolvedValue([{ id: 'team-1', name: 'Test Team' }]);
    mockApi.fetchDocuments.mockResolvedValue([
      { id: 'doc-1', title: 'Feature Spec', content: '# Feature', updatedAt: '2026-01-15T00:00:00Z' },
      { id: 'doc-2', title: 'API Design', content: '# API', updatedAt: '2026-01-14T00:00:00Z' },
    ]);
    mockApi.generateAllDocuments.mockResolvedValue({
      results: [
        { documentId: 'doc-1', title: 'Feature Spec', status: 'success' },
        { documentId: 'doc-2', title: 'API Design', status: 'success' },
      ],
      total: 2,
      succeeded: 2,
      failed: 0,
    });
  });

  it('renders the document list with Generate All button', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Feature Spec')).toBeInTheDocument());
    expect(screen.getByText('API Design')).toBeInTheDocument();
    expect(screen.getByTestId('generate-all-btn')).toBeInTheDocument();
    expect(screen.getByText('Generate All')).toBeInTheDocument();
  });

  it('calls generateAllDocuments when Generate All is clicked', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByTestId('generate-all-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('generate-all-btn'));
    await waitFor(() => expect(mockApi.generateAllDocuments).toHaveBeenCalledWith('team-1'));
  });

  it('shows success result after generation completes', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByTestId('generate-all-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('generate-all-btn'));
    await waitFor(() => expect(screen.getByTestId('generate-all-result')).toBeInTheDocument());
    expect(screen.getByText(/2 of 2 documents generated successfully/)).toBeInTheDocument();
  });

  it('shows partial failure count in results', async () => {
    mockApi.generateAllDocuments.mockResolvedValueOnce({
      results: [
        { documentId: 'doc-1', title: 'Feature Spec', status: 'success' },
        { documentId: 'doc-2', title: 'API Design', status: 'error', error: 'AI provider error' },
      ],
      total: 2,
      succeeded: 1,
      failed: 1,
    });
    renderComponent();
    await waitFor(() => expect(screen.getByTestId('generate-all-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('generate-all-btn'));
    await waitFor(() => expect(screen.getByTestId('generate-all-result')).toBeInTheDocument());
    expect(screen.getByText(/1 of 2 documents generated successfully/)).toBeInTheDocument();
    expect(screen.getByText(/1 document\(s\) failed to generate/)).toBeInTheDocument();
  });

  it('shows error banner when generation fails entirely', async () => {
    mockApi.generateAllDocuments.mockRejectedValueOnce(new Error('Network error'));
    renderComponent();
    await waitFor(() => expect(screen.getByTestId('generate-all-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('generate-all-btn'));
    await waitFor(() => expect(screen.getByTestId('generate-all-error')).toBeInTheDocument());
    expect(screen.getByText(/Failed to generate documentation/)).toBeInTheDocument();
  });

  it('does not show Generate All button when there are no documents', async () => {
    mockApi.fetchDocuments.mockResolvedValueOnce([]);
    renderComponent();
    await waitFor(() => expect(screen.getByText('No documents yet')).toBeInTheDocument());
    expect(screen.queryByTestId('generate-all-btn')).not.toBeInTheDocument();
  });
});
