import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PhaseSuggestions } from '../../components/PhaseSuggestions';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../lib/api', () => ({
  createDocument: vi.fn().mockResolvedValue({ id: 'new-doc-1' }),
}));

function renderComponent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PhaseSuggestions teamId="team-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PhaseSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all 5 phase cards', () => {
    renderComponent();
    expect(screen.getByText('Conception')).toBeInTheDocument();
    expect(screen.getByText('Definition')).toBeInTheDocument();
    expect(screen.getByText('Architecture')).toBeInTheDocument();
    expect(screen.getByText('Implementation')).toBeInTheDocument();
    expect(screen.getByText('Execution')).toBeInTheDocument();
  });

  it('shows Create button for each phase', () => {
    renderComponent();
    const createButtons = screen.getAllByText('Create');
    expect(createButtons).toHaveLength(5);
  });

  it('creates document with correct stage on click', async () => {
    const { createDocument } = await import('../../lib/api');
    renderComponent();
    const createButtons = screen.getAllByText('Create');
    fireEvent.click(createButtons[0]); // Conception
    await waitFor(() => expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'conception', teamId: 'team-1' }),
    ));
  });
});
