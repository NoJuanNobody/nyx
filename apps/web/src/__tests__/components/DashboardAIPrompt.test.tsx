import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DashboardAIPrompt } from '../../components/DashboardAIPrompt';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../lib/api', () => ({
  generateDocument: vi.fn().mockResolvedValue({ title: 'Test Doc', content: '# Test\n\nContent' }),
  createDocument: vi.fn().mockResolvedValue({ id: 'new-doc-1' }),
}));

// Mock MarkdownPreview to avoid complex rendering
vi.mock('../../components/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));

function renderComponent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DashboardAIPrompt teamId="team-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardAIPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders textarea and quick action chips', () => {
    renderComponent();
    expect(screen.getByPlaceholderText(/Ask AI/)).toBeInTheDocument();
    expect(screen.getByText('Write a spec for a new feature')).toBeInTheDocument();
    expect(screen.getByText('Explain a piece of code')).toBeInTheDocument();
    expect(screen.getByText('Draft an onboarding guide')).toBeInTheDocument();
  });

  it('quick action chip fills textarea', async () => {
    renderComponent();
    fireEvent.click(screen.getByText('Write a spec for a new feature'));
    expect(screen.getByPlaceholderText(/Ask AI/)).toHaveValue('Write a spec for a new feature');
  });

  it('generates document on submit', async () => {
    const { generateDocument } = await import('../../lib/api');
    renderComponent();
    fireEvent.change(screen.getByPlaceholderText(/Ask AI/), { target: { value: 'Test prompt' } });
    fireEvent.click(screen.getByText('Generate'));
    await waitFor(() => expect(generateDocument).toHaveBeenCalledWith('Test prompt'));
    await waitFor(() => expect(screen.getByText('Create doc from this')).toBeInTheDocument());
  });

  it('creates doc and navigates on "Create doc from this"', async () => {
    const { createDocument } = await import('../../lib/api');
    renderComponent();
    fireEvent.change(screen.getByPlaceholderText(/Ask AI/), { target: { value: 'Test prompt' } });
    fireEvent.click(screen.getByText('Generate'));
    await waitFor(() => expect(screen.getByText('Create doc from this')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Create doc from this'));
    await waitFor(() => expect(createDocument).toHaveBeenCalled());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/app/documents/new-doc-1'));
  });
});
