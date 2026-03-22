import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClaudeInsightCard } from '../../components/ClaudeInsightCard';
import type { ClaudeInsight } from '../../lib/api';

// Mock the API module
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    refreshTicketInsight: vi.fn(),
  };
});

import { refreshTicketInsight } from '../../lib/api';

const mockRefresh = vi.mocked(refreshTicketInsight);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const sampleInsight: ClaudeInsight = {
  title: 'Implement auth endpoints',
  summary: [
    'Added JWT middleware to all protected routes',
    'Created /api/auth/login and /api/auth/logout endpoints',
  ],
  filesChanged: [
    'apps/api/src/middleware/auth.ts',
    'apps/api/src/routes/auth.ts',
    'apps/api/src/routes/users.ts',
    'apps/api/src/lib/jwt.ts',
    'apps/api/src/types.ts',
    'apps/api/src/extra.ts',
  ],
  commentId: 1234567890,
  commentUrl: 'https://github.com/org/repo/issues/42#issuecomment-1234567890',
  commentedAt: '2026-03-14T12:00:00Z',
  fetchedAt: '2026-03-14T12:05:00Z',
};

describe('ClaudeInsightCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "No Claude insight" with Fetch button when insight is null', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={null} />, { wrapper: createWrapper() });
    expect(screen.getByText('No Claude insight')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeInTheDocument();
  });

  it('renders "No Claude insight" with Fetch button when insight is undefined', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={undefined} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('No Claude insight')).toBeInTheDocument();
  });

  it('renders collapsed insight title when insight is provided', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={sampleInsight} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Implement auth endpoints')).toBeInTheDocument();
    // Summary bullets should not be visible until expanded
    expect(screen.queryByText('Added JWT middleware to all protected routes')).not.toBeInTheDocument();
  });

  it('expands to show summary and files on click', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={sampleInsight} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByText('Implement auth endpoints'));

    expect(
      screen.getByText('Added JWT middleware to all protected routes'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Created /api/auth/login and /api/auth/logout endpoints'),
    ).toBeInTheDocument();
    expect(screen.getByText('apps/api/src/middleware/auth.ts')).toBeInTheDocument();
  });

  it('shows only first 5 files and "+N more" for the rest', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={sampleInsight} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByText('Implement auth endpoints'));

    // 5 visible files
    expect(screen.getByText('apps/api/src/middleware/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('apps/api/src/types.ts')).toBeInTheDocument();
    // 6th file hidden
    expect(screen.queryByText('apps/api/src/extra.ts')).not.toBeInTheDocument();
    // "+1 more" indicator
    expect(screen.getByText('+1 more')).toBeInTheDocument();
  });

  it('shows "View comment" link pointing to GitHub', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={sampleInsight} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByText('Implement auth endpoints'));

    const link = screen.getByText(/View comment/);
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute(
      'href',
      'https://github.com/org/repo/issues/42#issuecomment-1234567890',
    );
  });

  it('shows Refresh button in expanded view', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={sampleInsight} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByText('Implement auth endpoints'));

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('calls refreshTicketInsight when Fetch button is clicked', async () => {
    mockRefresh.mockResolvedValueOnce(sampleInsight);

    render(<ClaudeInsightCard ticketId="t1" insight={null} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledWith('t1');
    });
  });

  it('collapses panel on second click', () => {
    render(<ClaudeInsightCard ticketId="t1" insight={sampleInsight} />, {
      wrapper: createWrapper(),
    });

    const titleButton = screen.getByText('Implement auth endpoints');

    // Expand
    fireEvent.click(titleButton);
    expect(
      screen.getByText('Added JWT middleware to all protected routes'),
    ).toBeInTheDocument();

    // Collapse
    fireEvent.click(titleButton);
    expect(
      screen.queryByText('Added JWT middleware to all protected routes'),
    ).not.toBeInTheDocument();
  });

  it('handles insight with empty summary and files gracefully', () => {
    const emptyInsight: ClaudeInsight = {
      ...sampleInsight,
      summary: [],
      filesChanged: [],
    };

    render(<ClaudeInsightCard ticketId="t1" insight={emptyInsight} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByText('Implement auth endpoints'));

    // Should still show View comment and Refresh
    expect(screen.getByText(/View comment/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});
