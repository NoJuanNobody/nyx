import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Repositories } from '../../pages/Repositories';

// Default mock: GitHub + GitLab integrations both connected
const mockFetchIntegrations = vi.fn().mockResolvedValue([
  { id: 'int-1', type: 'github', provider: 'github' },
  { id: 'int-2', type: 'gitlab', provider: 'gitlab' },
]);

const mockFetchSyncedRepos = vi.fn((integrationId: string) => {
  if (integrationId === 'int-1') {
    return Promise.resolve({
      repos: [
        {
          owner: 'nyx',
          name: 'app',
          fullName: 'nyx/app',
          syncStatus: 'active',
          webhookId: 12345,
          lastPushAt: '2025-01-15T10:30:00Z',
          linkedDocCount: 2,
          provider: 'github',
        },
      ],
      webhookRegistrationEnabled: true,
      provider: 'github',
    });
  }
  if (integrationId === 'int-2') {
    return Promise.resolve({
      repos: [
        {
          owner: 'nyx-gl',
          name: 'backend',
          fullName: 'nyx-gl/backend',
          syncStatus: 'active',
          webhookId: null,
          lastPushAt: null,
          linkedDocCount: 0,
          provider: 'gitlab',
        },
      ],
      webhookRegistrationEnabled: false,
      provider: 'gitlab',
    });
  }
  return Promise.resolve({ repos: [], webhookRegistrationEnabled: false });
});

vi.mock('../../lib/api', () => ({
  fetchIntegrations: (...args: Parameters<typeof mockFetchIntegrations>) => mockFetchIntegrations(...args),
  fetchSyncedRepos: (...args: Parameters<typeof mockFetchSyncedRepos>) => mockFetchSyncedRepos(...args),
  reconnectRepo: vi.fn().mockResolvedValue({ ok: true, fullName: 'nyx/app', webhookId: 1, syncStatus: 'active' }),
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
    // Reset to default: GitHub + GitLab
    mockFetchIntegrations.mockResolvedValue([
      { id: 'int-1', type: 'github', provider: 'github' },
      { id: 'int-2', type: 'gitlab', provider: 'gitlab' },
    ]);
    mockFetchSyncedRepos.mockImplementation((integrationId: string) => {
      if (integrationId === 'int-1') {
        return Promise.resolve({
          repos: [
            {
              owner: 'nyx',
              name: 'app',
              fullName: 'nyx/app',
              syncStatus: 'active',
              webhookId: 12345,
              lastPushAt: '2025-01-15T10:30:00Z',
              linkedDocCount: 2,
              provider: 'github',
            },
          ],
          webhookRegistrationEnabled: true,
          provider: 'github',
        });
      }
      if (integrationId === 'int-2') {
        return Promise.resolve({
          repos: [
            {
              owner: 'nyx-gl',
              name: 'backend',
              fullName: 'nyx-gl/backend',
              syncStatus: 'active',
              webhookId: null,
              lastPushAt: null,
              linkedDocCount: 0,
              provider: 'gitlab',
            },
          ],
          webhookRegistrationEnabled: false,
          provider: 'gitlab',
        });
      }
      return Promise.resolve({ repos: [], webhookRegistrationEnabled: false });
    });
  });

  it('renders the Manage Repos button when repos are loaded', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('manage-repos-button').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByTestId('manage-repos-button')[0]).toHaveTextContent('Manage');
  });

  it('has the correct styling (blue background, white text, rounded)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('manage-repos-button').length).toBeGreaterThan(0);
    });
    const button = screen.getAllByTestId('manage-repos-button')[0];
    expect(button.className).toContain('bg-blue-600');
    expect(button.className).toContain('text-white');
    expect(button.className).toContain('rounded-lg');
  });

  it('opens RepoPickerModal when Manage Repos is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('manage-repos-button').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTestId('manage-repos-button')[0]);
    await waitFor(() => {
      expect(screen.getByText('Select Repositories')).toBeInTheDocument();
    });
  });

  it('closes RepoPickerModal when Cancel is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('manage-repos-button').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTestId('manage-repos-button')[0]);
    await waitFor(() => {
      expect(screen.getByText('Select Repositories')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByText('Select Repositories')).not.toBeInTheDocument();
    });
  });

  it('shows repos from both GitHub and GitLab integrations', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('nyx/app')).toBeInTheDocument();
      expect(screen.getByText('nyx-gl/backend')).toBeInTheDocument();
    });
  });

  it('shows provider badges for repos', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
      expect(screen.getByText('GitLab')).toBeInTheDocument();
    });
  });

  it('shows "no providers connected" empty state when no git integrations are connected', async () => {
    mockFetchIntegrations.mockResolvedValue([
      { id: 'jira-1', type: 'jira', provider: 'jira' },
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('no-providers-empty-state')).toBeInTheDocument();
    });
    expect(screen.getByText('No providers connected')).toBeInTheDocument();
    expect(screen.getByText(/Connect GitHub, GitLab, or Bitbucket/)).toBeInTheDocument();
  });

  it('GitHub repo link points to github.com', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('nyx/app')).toBeInTheDocument();
    });
    const link = screen.getByText('nyx/app').closest('a');
    expect(link?.href).toContain('github.com/nyx/app');
  });

  it('GitLab repo link points to gitlab.com', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('nyx-gl/backend')).toBeInTheDocument();
    });
    const link = screen.getByText('nyx-gl/backend').closest('a');
    expect(link?.href).toContain('gitlab.com/nyx-gl/backend');
  });
});
