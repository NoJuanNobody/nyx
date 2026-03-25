import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Repositories } from '../../pages/Repositories';

vi.mock('../../lib/api', () => ({
  fetchIntegrations: vi.fn().mockResolvedValue([
    { id: 'int-1', type: 'github', provider: 'github' },
  ]),
  fetchSyncedRepos: vi.fn().mockResolvedValue({
    repos: [
      {
        owner: 'nyx',
        name: 'app',
        fullName: 'nyx/app',
        syncStatus: 'active',
        webhookId: 12345,
        lastPushAt: '2025-01-15T10:30:00Z',
        linkedDocCount: 2,
      },
    ],
  }),
  fetchGitHubRepos: vi.fn().mockResolvedValue({
    repos: [
      { id: 1, full_name: 'nyx/app', private: false, default_branch: 'main' },
      { id: 2, full_name: 'nyx/docs', private: true, default_branch: 'main' },
    ],
  }),
  disconnectRepo: vi.fn().mockResolvedValue({}),
  createGitHubRepo: vi.fn().mockResolvedValue({}),
  saveSelectedRepos: vi.fn().mockResolvedValue({}),
  GitHubTokenExpiredError: class extends Error {},
}));

vi.mock('../../stores/auth.store', () => ({
  useAuthStore: vi.fn((selector: (s: { currentTeamId: string }) => string) =>
    selector({ currentTeamId: 'team-1' }),
  ),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Repositories />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Repositories — Manage Repos button', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Manage Repos button when repos are loaded', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-repos-button')).toBeInTheDocument();
    });
    expect(screen.getByTestId('manage-repos-button')).toHaveTextContent('Manage Repos');
  });

  it('has the correct styling (blue background, white text, rounded)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-repos-button')).toBeInTheDocument();
    });
    const button = screen.getByTestId('manage-repos-button');
    expect(button.className).toContain('bg-blue-600');
    expect(button.className).toContain('text-white');
    expect(button.className).toContain('rounded-lg');
  });

  it('opens RepoPickerModal when Manage Repos is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-repos-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-repos-button'));
    await waitFor(() => {
      expect(screen.getByText('Select Repositories')).toBeInTheDocument();
    });
  });

  it('closes RepoPickerModal when Cancel is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-repos-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-repos-button'));
    await waitFor(() => {
      expect(screen.getByText('Select Repositories')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByText('Select Repositories')).not.toBeInTheDocument();
    });
  });
});
