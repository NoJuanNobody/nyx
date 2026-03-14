import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContextMatches } from '../../components/ContextMatches';
import type { ContextMatch, ContextSignal } from '../../lib/api';

const mockMatches: ContextMatch[] = [
  {
    documentId: 'doc-1',
    title: 'Auth Requirements',
    relevance: 'high',
    relationship: 'confirms',
    summary: 'Aligns with existing authentication spec',
  },
  {
    documentId: 'doc-2',
    title: 'API Design',
    relevance: 'medium',
    relationship: 'contradicts',
    summary: 'Conflicts with current API design decisions',
  },
];

const mockSignals: ContextSignal[] = [
  {
    type: 'recurring_pattern',
    description: 'Authentication has been mentioned in 3 prior inputs',
    relatedDocIds: ['doc-1'],
  },
  {
    type: 'contradiction',
    description: 'REST vs GraphQL conflict detected',
    relatedDocIds: ['doc-2'],
  },
  {
    type: 'scope_creep',
    description: 'This adds a new mobile app target not in original scope',
    relatedDocIds: ['doc-1', 'doc-2'],
  },
];

function renderComponent(
  props: { matches: ContextMatch[]; signals: ContextSignal[]; isLoading?: boolean },
) {
  return render(
    <MemoryRouter>
      <ContextMatches {...props} />
    </MemoryRouter>,
  );
}

describe('ContextMatches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when no matches and no signals', () => {
    const { container } = renderComponent({ matches: [], signals: [] });
    expect(container.firstChild).toBeNull();
  });

  it('renders loading state', () => {
    renderComponent({ matches: [], signals: [], isLoading: true });
    expect(screen.getByTestId('context-matches-loading')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
  });

  it('renders matches with correct links and badges', () => {
    renderComponent({ matches: mockMatches, signals: [] });

    expect(screen.getByText('Auth Requirements')).toBeInTheDocument();
    expect(screen.getByText('API Design')).toBeInTheDocument();

    // Check relevance badges
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();

    // Check relationship badges
    expect(screen.getByText('Confirms')).toBeInTheDocument();
    expect(screen.getByText('Contradicts')).toBeInTheDocument();

    // Check summaries
    expect(screen.getByText('Aligns with existing authentication spec')).toBeInTheDocument();

    // Check links point to the correct documents
    const authLink = screen.getByText('Auth Requirements').closest('a');
    expect(authLink).toHaveAttribute('href', '/documents/doc-1');
  });

  it('renders signal badges with appropriate labels', () => {
    renderComponent({ matches: [], signals: mockSignals });

    expect(screen.getByText('Recurring Pattern')).toBeInTheDocument();
    expect(screen.getByText('Contradiction')).toBeInTheDocument();
    expect(screen.getByText('Scope Creep')).toBeInTheDocument();
  });

  it('renders signal descriptions', () => {
    renderComponent({ matches: [], signals: mockSignals });

    expect(
      screen.getByText('Authentication has been mentioned in 3 prior inputs'),
    ).toBeInTheDocument();
    expect(screen.getByText('REST vs GraphQL conflict detected')).toBeInTheDocument();
  });

  it('can collapse and expand the section', () => {
    renderComponent({ matches: mockMatches, signals: mockSignals });

    // Initially expanded
    expect(screen.getByTestId('context-match-list')).toBeInTheDocument();
    expect(screen.getByTestId('context-signals')).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByTestId('context-matches-toggle'));
    expect(screen.queryByTestId('context-match-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-signals')).not.toBeInTheDocument();

    // Expand again
    fireEvent.click(screen.getByTestId('context-matches-toggle'));
    expect(screen.getByTestId('context-match-list')).toBeInTheDocument();
  });

  it('shows correct count in header', () => {
    renderComponent({ matches: mockMatches, signals: mockSignals });
    expect(screen.getByText('Context (2 matches, 3 signals)')).toBeInTheDocument();
  });
});
