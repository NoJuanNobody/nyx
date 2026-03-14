import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { IntakePage } from '../../pages/IntakePage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockUploadAudio = vi.fn();
const mockProcessTranscript = vi.fn();
const mockCreateDocument = vi.fn();
const mockFetchTeams = vi.fn();

vi.mock('../../lib/api', () => ({
  uploadAudioForIntake: (...args: unknown[]) => mockUploadAudio(...args),
  processTranscriptForIntake: (...args: unknown[]) => mockProcessTranscript(...args),
  createDocument: (...args: unknown[]) => mockCreateDocument(...args),
  fetchTeams: () => mockFetchTeams(),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IntakePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('IntakePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchTeams.mockResolvedValue([{ id: 'team-1', name: 'Team 1', slug: 'team-1' }]);
  });

  it('renders with upload tab active by default', () => {
    renderPage();
    expect(screen.getByText('Audio Intake')).toBeInTheDocument();
    expect(screen.getByTestId('intake-tab-upload')).toBeInTheDocument();
    expect(screen.getByTestId('intake-tab-paste')).toBeInTheDocument();
    expect(screen.getByTestId('intake-dropzone')).toBeInTheDocument();
  });

  it('switches to paste tab when clicked', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('intake-tab-paste'));
    expect(screen.getByTestId('intake-paste-input')).toBeInTheDocument();
    expect(screen.getByTestId('intake-process-btn')).toBeInTheDocument();
  });

  it('processes pasted transcript and shows results', async () => {
    mockProcessTranscript.mockResolvedValue({
      transcript: 'We need a dashboard.',
      structured: { title: 'Dashboard Spec', content: '# Dashboard\n\nSpec content' },
    });

    renderPage();
    fireEvent.click(screen.getByTestId('intake-tab-paste'));

    const textarea = screen.getByTestId('intake-paste-input');
    fireEvent.change(textarea, { target: { value: 'We need a dashboard.' } });

    fireEvent.click(screen.getByTestId('intake-process-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('intake-results')).toBeInTheDocument();
    });

    expect(screen.getByTestId('intake-structured-title')).toHaveTextContent('Dashboard Spec');
    expect(mockProcessTranscript).toHaveBeenCalledWith('We need a dashboard.');
  });

  it('disables process button when paste input is empty', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('intake-tab-paste'));

    const btn = screen.getByTestId('intake-process-btn');
    expect(btn).toBeDisabled();
  });

  it('shows error when paste processing fails', async () => {
    mockProcessTranscript.mockRejectedValue(new Error('API 500: Internal Server Error'));

    renderPage();
    fireEvent.click(screen.getByTestId('intake-tab-paste'));

    const textarea = screen.getByTestId('intake-paste-input');
    fireEvent.change(textarea, { target: { value: 'Some transcript text' } });

    fireEvent.click(screen.getByTestId('intake-process-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('intake-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('intake-error')).toHaveTextContent('API 500');
  });

  it('creates document from structured spec and navigates', async () => {
    mockProcessTranscript.mockResolvedValue({
      transcript: 'Build a login',
      structured: { title: 'Login Feature', content: '# Login\n\nLogin spec' },
    });
    mockCreateDocument.mockResolvedValue({ id: 'doc-123' });

    renderPage();
    fireEvent.click(screen.getByTestId('intake-tab-paste'));

    const textarea = screen.getByTestId('intake-paste-input');
    fireEvent.change(textarea, { target: { value: 'Build a login' } });
    fireEvent.click(screen.getByTestId('intake-process-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('intake-create-doc-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('intake-create-doc-btn'));

    await waitFor(() => {
      expect(mockCreateDocument).toHaveBeenCalledWith({
        title: 'Login Feature',
        content: '# Login\n\nLogin spec',
        teamId: 'team-1',
      });
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/documents/doc-123');
    });
  });

  it('shows transcript editor after processing and allows re-processing', async () => {
    mockProcessTranscript
      .mockResolvedValueOnce({
        transcript: 'Original text',
        structured: { title: 'First', content: 'First content' },
      })
      .mockResolvedValueOnce({
        transcript: 'Edited text',
        structured: { title: 'Updated', content: 'Updated content' },
      });

    renderPage();
    fireEvent.click(screen.getByTestId('intake-tab-paste'));

    fireEvent.change(screen.getByTestId('intake-paste-input'), {
      target: { value: 'Original text' },
    });
    fireEvent.click(screen.getByTestId('intake-process-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('intake-transcript-editor')).toBeInTheDocument();
    });

    // Edit the transcript
    fireEvent.change(screen.getByTestId('intake-transcript-editor'), {
      target: { value: 'Edited text' },
    });

    // Re-process
    fireEvent.click(screen.getByTestId('intake-reprocess-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('intake-structured-title')).toHaveTextContent('Updated');
    });
  });

  it('has a file input that accepts audio formats', () => {
    renderPage();
    const fileInput = screen.getByTestId('intake-file-input');
    expect(fileInput).toHaveAttribute('accept', '.mp3,.wav,.m4a,.webm');
  });
});
