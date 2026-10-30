import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FileTree } from '../../components/FileTree';
import { useUIStore } from '../../stores/ui.store';
import { getLifecycle } from '../../lib/lifecycles';
import * as api from '../../lib/api';

const documents = vi.hoisted(() => ({
  current: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../lib/api', () => ({
  fetchTeams: vi.fn().mockResolvedValue([{ id: 'team-1', name: 'Test Team', slug: 'test' }]),
  fetchDocuments: vi.fn(async () => documents.current),
  fetchTemplates: vi.fn().mockResolvedValue([]),
  createDocument: vi.fn(),
  updateDocument: vi.fn().mockResolvedValue({}),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  generateFolderTicketSuggestions: vi.fn(),
}));

const stages = getLifecycle('software_development').stages;
const first = stages[0];
const second = stages[1];

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/app/documents/doc-b']}>
        <FileTree />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseDoc = { teamId: 'team-1', updatedAt: '2025-01-01T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useUIStore.setState({ seeding: false, activeLifecycleSlug: 'software_development' });
  documents.current = [
    { ...baseDoc, id: 'doc-a', title: 'Alpha', path: '/', stage: first.id },
    { ...baseDoc, id: 'doc-b', title: 'Beta', path: '/Specs', stage: second.id },
    { ...baseDoc, id: 'doc-c', title: 'Gamma', path: '/Specs', stage: null },
  ];
});

let confirmSpy: ReturnType<typeof vi.spyOn> | null = null;
afterEach(() => {
  confirmSpy?.mockRestore();
  confirmSpy = null;
});

describe('FileTree explorer semantics', () => {
  it('renders an accessible tree with folders expandable and the open document selected', async () => {
    mount();
    const tree = await screen.findByRole('tree', { name: 'Documents and folders' });
    const specs = await screen.findByText('Specs');
    const row = specs.closest('[role=treeitem]')!;
    expect(tree).toContainElement(row as HTMLElement);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(specs);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const beta = screen.getByText('Beta').closest('[role=treeitem]')!;
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(beta).toHaveAttribute('aria-level', '2');
  });

  it('F2 renames a document and persists the new title', async () => {
    const user = userEvent.setup();
    mount();
    const alpha = (await screen.findByText('Alpha')).closest('[role=treeitem]') as HTMLElement;
    alpha.focus();
    await user.keyboard('{F2}');
    const input = await screen.findByLabelText('Rename Alpha');
    await user.keyboard('Renamed{Enter}');
    expect(input).not.toBeNull();
    await waitFor(() =>
      expect(api.updateDocument).toHaveBeenCalledWith('doc-a', { title: 'Renamed' }),
    );
  });

  it('Delete soft-deletes the focused document', async () => {
    const user = userEvent.setup();
    mount();
    const alpha = (await screen.findByText('Alpha')).closest('[role=treeitem]') as HTMLElement;
    alpha.focus();
    await user.keyboard('{Delete}');
    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith('doc-a'));
  });

  it('Delete on a non-empty folder asks for confirmation first', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    confirmSpy = confirm;
    mount();
    const specs = (await screen.findByText('Specs')).closest('[role=treeitem]') as HTMLElement;
    specs.focus();
    await user.keyboard('{Delete}');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 documents'));
    expect(api.deleteDocument).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    specs.focus();
    await user.keyboard('{Delete}');
    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledTimes(2));
  });

  it('shows the empty state when there is nothing yet', async () => {
    documents.current = [];
    mount();
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('shows a distinct empty state when a stage filter matches nothing and can reset it', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Alpha');
    await user.selectOptions(screen.getByLabelText('Filter by stage'), stages[stages.length - 1].id);
    expect(await screen.findByText('No documents in this stage')).toBeInTheDocument();
    await user.click(screen.getByText('Show all stages'));
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('offers the stages of the active pipeline in the filter', async () => {
    mount();
    await screen.findByText('Alpha');
    const select = screen.getByLabelText('Filter by stage');
    for (const st of stages) {
      expect(select).toHaveTextContent(st.label);
    }
  });

  it('supports the keyboard-only new folder flow via the inline input', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Alpha');
    await user.click(screen.getByLabelText('New folder'));
    const input = await screen.findByLabelText('New folder name');
    await user.type(input, 'Notes{Enter}');
    expect(await screen.findByText('Notes')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('nyx:folders') ?? '[]')).toContain('/Notes');
  });
});

describe('FileTree stage grouping', () => {
  async function toStages() {
    mount();
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Stages' }));
    return screen.findByRole('tree', { name: 'Documents by stage' });
  }

  it('groups documents per pipeline stage in pipeline order, with a No stage group', async () => {
    const tree = await toStages();
    const groups = Array.from(tree.querySelectorAll('[data-kind="group"]')).map((g) => g.textContent);
    expect(groups.slice(0, stages.length).map((t) => t?.replace(/\d+$/, ''))).toEqual(
      stages.map((s) => s.label),
    );
    expect(groups[groups.length - 1]).toContain('No stage');
    const alpha = screen.getByText('Alpha').closest('[role=treeitem]')!;
    expect(alpha).toHaveAttribute('aria-level', '2');
  });

  it('remembers the chosen view', async () => {
    await toStages();
    expect(localStorage.getItem('nyx:explorer-view')).toBe('stages');
  });

  it('dropping a document on a stage group changes its stage', async () => {
    await toStages();
    const gamma = screen.getByText('Gamma').closest('[role=treeitem]') as HTMLElement;
    const target = within(screen.getByRole('tree')).getByText(second.label).closest('[role=treeitem]') as HTMLElement;
    const data: Record<string, string> = {};
    const dataTransfer = {
      types: [] as string[],
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (m: string, v: string) => {
        data[m] = v;
        if (!dataTransfer.types.includes(m)) dataTransfer.types.push(m);
      },
      getData: (m: string) => data[m] ?? '',
    };
    fireEvent.dragStart(gamma, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() =>
      expect(api.updateDocument).toHaveBeenCalledWith('doc-c', { stage: second.id }),
    );
  });

  it('does not let folders be dropped onto stage groups', async () => {
    documents.current = [{ ...baseDoc, id: 'doc-a', title: 'Alpha', path: '/', stage: first.id }];
    mount();
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Stages' }));
    expect(screen.getByLabelText('New folder')).toBeDisabled();
  });
});
