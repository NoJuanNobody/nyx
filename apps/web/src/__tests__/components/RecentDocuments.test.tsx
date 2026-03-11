import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RecentDocuments } from '../../components/RecentDocuments';

vi.mock('../../lib/api', () => ({
  fetchTeams: vi.fn().mockResolvedValue([{ id: 'team-1', name: 'Test Team', slug: 'test' }]),
  fetchRecentDocuments: vi.fn().mockResolvedValue([
    { id: 'doc-1', title: 'First Doc', status: 'draft', updatedAt: '2025-01-01T00:00:00Z' },
    { id: 'doc-2', title: 'Second Doc', status: 'published', updatedAt: '2025-01-02T00:00:00Z' },
  ]),
}));

function renderComponent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RecentDocuments />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RecentDocuments', () => {
  it('renders recent documents with title', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Recent Documents')).toBeInTheDocument());
    expect(screen.getByText('First Doc')).toBeInTheDocument();
    expect(screen.getByText('Second Doc')).toBeInTheDocument();
  });

  it('shows View all link', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('View all')).toBeInTheDocument());
  });

  it('renders at most 5 items', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Recent Documents')).toBeInTheDocument());
    const links = screen.getAllByRole('link').filter((el) => el.getAttribute('href')?.includes('/documents/'));
    expect(links.length).toBeLessThanOrEqual(5);
  });
});
