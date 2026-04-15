import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  FileTree,
  rewriteDescendantPaths,
  wouldCreateCycle,
  computeMovedFolderPath,
} from '../../components/FileTree';
import { useUIStore } from '../../stores/ui.store';
import * as api from '../../lib/api';

vi.mock('../../lib/api', () => ({
  fetchTeams: vi.fn().mockResolvedValue([{ id: 'team-1', name: 'Test Team', slug: 'test' }]),
  fetchDocuments: vi.fn().mockResolvedValue([
    {
      id: 'doc-1',
      title: 'Child Doc',
      path: '/A/Child',
      teamId: 'team-1',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ]),
  fetchTemplates: vi.fn().mockResolvedValue([]),
  createDocument: vi.fn(),
  updateDocument: vi.fn().mockResolvedValue({}),
  deleteDocument: vi.fn(),
  generateFolderTicketSuggestions: vi.fn(),
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

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('rewriteDescendantPaths', () => {
  it('rewrites the matching prefix', () => {
    expect(rewriteDescendantPaths(['/A'], '/A', '/B/A')).toEqual(['/B/A']);
  });

  it('rewrites descendants that share the prefix', () => {
    const result = rewriteDescendantPaths(
      ['/A', '/A/Child', '/A/Child/Grandchild', '/Other'],
      '/A',
      '/B/A',
    );
    expect(result).toEqual(['/B/A', '/B/A/Child', '/B/A/Child/Grandchild', '/Other']);
  });

  it('does not rewrite unrelated paths that merely start with the same characters', () => {
    // `/Apple` should NOT be rewritten when prefix is `/A`
    const result = rewriteDescendantPaths(['/Apple', '/A/Child'], '/A', '/B/A');
    expect(result).toEqual(['/Apple', '/B/A/Child']);
  });

  it('handles moving to root', () => {
    const result = rewriteDescendantPaths(['/A/Child', '/A/Child/Sub'], '/A/Child', '/Child');
    expect(result).toEqual(['/Child', '/Child/Sub']);
  });

  it('returns the input unchanged when nothing matches', () => {
    const input = ['/X', '/Y/Z'];
    expect(rewriteDescendantPaths(input, '/A', '/B')).toEqual(input);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects dropping a folder onto itself', () => {
    expect(wouldCreateCycle('/A', '/A')).toBe(true);
  });

  it('rejects dropping a folder into one of its descendants', () => {
    expect(wouldCreateCycle('/A', '/A/Child')).toBe(true);
    expect(wouldCreateCycle('/A', '/A/Child/Grandchild')).toBe(true);
  });

  it('allows dropping into a sibling folder', () => {
    expect(wouldCreateCycle('/A', '/B')).toBe(false);
  });

  it('allows dropping into the root', () => {
    expect(wouldCreateCycle('/A/Child', '/')).toBe(false);
  });

  it('does not falsely reject paths that share a name prefix', () => {
    // `/Apple` is not a descendant of `/A`, despite the string-prefix match
    expect(wouldCreateCycle('/A', '/Apple')).toBe(false);
  });
});

describe('computeMovedFolderPath', () => {
  it('moves a folder under a sibling parent', () => {
    expect(computeMovedFolderPath('/A/Child', '/B')).toBe('/B/Child');
  });

  it('moves a folder back to the root', () => {
    expect(computeMovedFolderPath('/A/Child', '/')).toBe('/Child');
  });

  it('preserves the leaf segment when the source is at root', () => {
    expect(computeMovedFolderPath('/A', '/B')).toBe('/B/A');
  });
});

// ── Integration: FileTree drag-and-drop ─────────────────────────────────────

describe('FileTree folder drag-and-drop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ seeding: false });
    localStorage.setItem('nyx:folders', JSON.stringify(['/A', '/A/Child', '/B']));
  });

  it('moves a nested folder when dropped on a sibling folder', async () => {
    renderComponent();

    // Wait for the tree to render — top-level folders A and B should be visible
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('B')).toBeInTheDocument());

    // Expand A so Child becomes draggable
    fireEvent.click(screen.getByText('A'));
    await waitFor(() => expect(screen.getByText('Child')).toBeInTheDocument());

    const childRow = screen.getByText('Child').closest('div.cursor-pointer') as HTMLElement;
    const targetRow = screen.getByText('B').closest('div.cursor-pointer') as HTMLElement;
    expect(childRow).toBeTruthy();
    expect(targetRow).toBeTruthy();

    // Simulate drag-and-drop using a shared dataTransfer mock
    const data: Record<string, string> = {};
    const dataTransfer = {
      data,
      types: [] as string[],
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (mime: string, value: string) => {
        data[mime] = value;
        if (!dataTransfer.types.includes(mime)) dataTransfer.types.push(mime);
      },
      getData: (mime: string) => data[mime] ?? '',
    };

    fireEvent.dragStart(childRow, { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    // The Child doc's path should be persisted with the new prefix
    await waitFor(() => {
      expect(api.updateDocument).toHaveBeenCalledWith('doc-1', { path: '/B/Child' });
    });

    // localStorage folders should reflect the move
    const stored = JSON.parse(localStorage.getItem('nyx:folders') || '[]') as string[];
    expect(stored).toContain('/B/Child');
    expect(stored).not.toContain('/A/Child');
    expect(stored).toContain('/A');
    expect(stored).toContain('/B');
  });

  it('does not move when dropping a folder onto its own descendant (cycle guard)', async () => {
    renderComponent();

    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument());
    fireEvent.click(screen.getByText('A'));
    await waitFor(() => expect(screen.getByText('Child')).toBeInTheDocument());

    const aRow = screen.getByText('A').closest('div.cursor-pointer') as HTMLElement;
    const childRow = screen.getByText('Child').closest('div.cursor-pointer') as HTMLElement;

    const data: Record<string, string> = {};
    const dataTransfer = {
      data,
      types: [] as string[],
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (mime: string, value: string) => {
        data[mime] = value;
        if (!dataTransfer.types.includes(mime)) dataTransfer.types.push(mime);
      },
      getData: (mime: string) => data[mime] ?? '',
    };

    fireEvent.dragStart(aRow, { dataTransfer });
    fireEvent.dragOver(childRow, { dataTransfer });
    fireEvent.drop(childRow, { dataTransfer });

    // The drop handler should refuse a cycle — no doc updates occur
    expect(api.updateDocument).not.toHaveBeenCalled();

    // Folders list is unchanged
    const stored = JSON.parse(localStorage.getItem('nyx:folders') || '[]') as string[];
    expect(stored.sort()).toEqual(['/A', '/A/Child', '/B'].sort());
  });

  it('does nothing when a folder is dropped on itself', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument());

    const aRow = screen.getByText('A').closest('div.cursor-pointer') as HTMLElement;

    const data: Record<string, string> = {};
    const dataTransfer = {
      data,
      types: [] as string[],
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (mime: string, value: string) => {
        data[mime] = value;
        if (!dataTransfer.types.includes(mime)) dataTransfer.types.push(mime);
      },
      getData: (mime: string) => data[mime] ?? '',
    };

    fireEvent.dragStart(aRow, { dataTransfer });
    fireEvent.dragOver(aRow, { dataTransfer });
    fireEvent.drop(aRow, { dataTransfer });

    expect(api.updateDocument).not.toHaveBeenCalled();
  });

  it('exposes a "Move to…" entry in the folder context menu', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('A'));

    await waitFor(() =>
      expect(screen.getByText((t) => t.startsWith('Move to'))).toBeInTheDocument(),
    );
  });
});
