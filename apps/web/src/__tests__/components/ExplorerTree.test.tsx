import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExplorerTree, DRAG_MIME_DOC, DRAG_MIME_FOLDER, type ExplorerTreeProps } from '../../components/ExplorerTree';
import { buildFolderTree, folderId, type ExplorerDoc } from '../../lib/explorerTree';

const docs: ExplorerDoc[] = [
  { id: 'd1', title: 'Readme', path: '/' },
  { id: 'd2', title: 'Spec', path: '/A' },
  { id: 'd3', title: 'Deep', path: '/A/Child' },
];
const folders = ['/A', '/A/Child', '/B'];

function Harness(
  props: Partial<ExplorerTreeProps<unknown>> & { initial?: string[]; docList?: ExplorerDoc[] },
) {
  const { initial = [], docList = docs, ...rest } = props;
  const [expanded, setExpanded] = useState(new Set(initial));
  return (
    <ExplorerTree
      nodes={buildFolderTree(docList, folders)}
      expanded={expanded}
      onToggle={(id) =>
        setExpanded((p) => {
          const n = new Set(p);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        })
      }
      ariaLabel="Files"
      {...rest}
    />
  );
}

const items = () => screen.getAllByRole('treeitem');
const labels = () => items().map((i) => i.textContent);

function dt() {
  const data: Record<string, string> = {};
  const t = {
    types: [] as string[],
    effectAllowed: 'move',
    dropEffect: 'move',
    setData: (m: string, v: string) => {
      data[m] = v;
      if (!t.types.includes(m)) t.types.push(m);
    },
    getData: (m: string) => data[m] ?? '',
  };
  return t;
}

describe('ExplorerTree a11y semantics', () => {
  it('exposes tree/treeitem roles with level, set metadata and aria-expanded', () => {
    render(<Harness initial={[folderId('/A')]} />);
    expect(screen.getByRole('tree', { name: 'Files' })).toBeInTheDocument();
    const [a, child, spec, b, readme] = items();
    expect(a).toHaveAttribute('aria-expanded', 'true');
    expect(a).toHaveAttribute('aria-level', '1');
    expect(a).toHaveAttribute('aria-setsize', '3');
    expect(a).toHaveAttribute('aria-posinset', '1');
    expect(child).toHaveAttribute('aria-expanded', 'false');
    expect(child).toHaveAttribute('aria-level', '2');
    expect(spec).not.toHaveAttribute('aria-expanded');
    expect(b).toHaveAttribute('aria-expanded', 'false');
    expect(readme).toHaveAttribute('aria-level', '1');
  });

  it('uses a roving tabindex: exactly one item is tabbable', () => {
    render(<Harness />);
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
    expect(items()[0].tabIndex).toBe(0);
  });

  it('marks the selected item', () => {
    render(<Harness initial={[folderId('/A')]} selectedId="doc:d2" />);
    expect(items().filter((i) => i.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });
});

describe('ExplorerTree keyboard navigation', () => {
  it('moves with arrows, Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    items()[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(items()[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items()[items().length - 1]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items()[items().length - 2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items()[0]).toHaveFocus();
  });

  it('ArrowRight expands, then enters; ArrowLeft collapses, then goes to the parent', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    items()[0].focus(); // A
    await user.keyboard('{ArrowRight}');
    expect(items()[0]).toHaveAttribute('aria-expanded', 'true');
    expect(labels()).toContain('Spec');
    await user.keyboard('{ArrowRight}');
    expect(items()[1]).toHaveFocus(); // Child
    await user.keyboard('{ArrowLeft}');
    expect(items()[0]).toHaveFocus(); // parent A
    await user.keyboard('{ArrowLeft}');
    expect(items()[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('Enter toggles folders and activates documents', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    items()[0].focus();
    await user.keyboard('{Enter}');
    expect(items()[0]).toHaveAttribute('aria-expanded', 'true');
    const readme = screen.getByText('Readme').closest('[role=treeitem]') as HTMLElement;
    readme.focus();
    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc:d1' }));
  });

  it('F2 requests rename and Delete requests removal of the focused node', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(<Harness onRename={onRename} onDelete={onDelete} />);
    items()[0].focus();
    await user.keyboard('{F2}');
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: folderId('/A') }));
    await user.keyboard('{Delete}');
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: folderId('/A') }));
  });

  it('typing jumps to a matching item', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    items()[0].focus();
    await user.keyboard('r');
    expect(screen.getByText('Readme').closest('[role=treeitem]')).toHaveFocus();
  });

  it('Shift+F10 and the ContextMenu key open the context menu for the item', async () => {
    const user = userEvent.setup();
    const onContextMenu = vi.fn();
    render(<Harness onContextMenu={onContextMenu} />);
    items()[1].focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number) }),
      expect.objectContaining({ id: folderId('/B') }),
    );
    await user.keyboard('{ContextMenu}');
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+X then Ctrl+V on a folder moves (keyboard alternative to drag and drop)', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const readme = screen.getByText('Readme').closest('[role=treeitem]') as HTMLElement;
    readme.focus();
    await user.keyboard('{Control>}x{/Control}');
    items()[1].focus(); // B
    await user.keyboard('{Control>}v{/Control}');
    expect(onMove).toHaveBeenCalledWith(
      { kind: 'doc', id: 'd1' },
      expect.objectContaining({ id: folderId('/B') }),
    );
  });

  it('does not hijack keys typed in the rename input', async () => {
    const user = userEvent.setup();
    const onRenameSubmit = vi.fn();
    const onDelete = vi.fn();
    render(
      <Harness
        renamingId={folderId('/B')}
        onRenameSubmit={onRenameSubmit}
        onDelete={onDelete}
        onRenameCancel={() => {}}
      />,
    );
    const input = screen.getByLabelText('Rename B');
    expect(input).toHaveFocus();
    await user.keyboard('{Delete}x{Enter}');
    expect(onDelete).not.toHaveBeenCalled();
    expect(onRenameSubmit).toHaveBeenCalledTimes(1);
    // the input pre-selects its text, so typing replaces it
    expect(onRenameSubmit.mock.calls[0][1]).toBe('x');
  });

  it('Escape cancels a rename without submitting', async () => {
    const user = userEvent.setup();
    const onRenameSubmit = vi.fn();
    const onRenameCancel = vi.fn();
    render(
      <Harness renamingId={folderId('/B')} onRenameSubmit={onRenameSubmit} onRenameCancel={onRenameCancel} />,
    );
    await user.keyboard('{Escape}');
    expect(onRenameCancel).toHaveBeenCalled();
    expect(onRenameSubmit).not.toHaveBeenCalled();
  });
});

describe('ExplorerTree mouse', () => {
  it('click toggles folders and activates documents; double click renames documents', () => {
    const onActivate = vi.fn();
    const onRename = vi.fn();
    render(<Harness onActivate={onActivate} onRename={onRename} />);
    fireEvent.click(screen.getByText('A'));
    expect(screen.getByText('A').closest('[role=treeitem]')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByText('Readme'));
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(screen.getByText('Readme'));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('right click reports the node; right click on empty space reports the root', () => {
    const onContextMenu = vi.fn();
    const { container } = render(<Harness onContextMenu={onContextMenu} />);
    fireEvent.contextMenu(screen.getByText('B'), { clientX: 5, clientY: 6 });
    expect(onContextMenu).toHaveBeenLastCalledWith({ x: 5, y: 6 }, expect.objectContaining({ id: folderId('/B') }));
    fireEvent.contextMenu(container.firstChild as HTMLElement);
    expect(onContextMenu).toHaveBeenLastCalledWith(expect.anything(), null);
  });
});

describe('ExplorerTree drag and drop', () => {
  const row = (text: string) => screen.getByText(text).closest('[role=treeitem]') as HTMLElement;

  it('moves a document onto a folder', () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const t = dt();
    fireEvent.dragStart(row('Readme'), { dataTransfer: t });
    fireEvent.dragOver(row('B'), { dataTransfer: t });
    fireEvent.drop(row('B'), { dataTransfer: t });
    expect(onMove).toHaveBeenCalledWith({ kind: 'doc', id: 'd1' }, expect.objectContaining({ id: folderId('/B') }));
    expect(t.getData(DRAG_MIME_DOC)).toBe('d1');
  });

  it('moves a folder to another folder and to the root area', () => {
    const onMove = vi.fn();
    const { container } = render(<Harness onMove={onMove} initial={[folderId('/A')]} />);
    const t = dt();
    fireEvent.dragStart(row('Child'), { dataTransfer: t });
    fireEvent.drop(row('B'), { dataTransfer: t });
    expect(onMove).toHaveBeenLastCalledWith(
      { kind: 'folder', path: '/A/Child' },
      expect.objectContaining({ id: folderId('/B') }),
    );
    expect(t.getData(DRAG_MIME_FOLDER)).toBe('/A/Child');
    fireEvent.drop(container.firstChild as HTMLElement, { dataTransfer: t });
    expect(onMove).toHaveBeenLastCalledWith({ kind: 'folder', path: '/A/Child' }, null);
  });

  it('refuses to drop a folder on itself or a descendant (cycle guard)', () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} initial={[folderId('/A')]} />);
    const t = dt();
    fireEvent.dragStart(row('A'), { dataTransfer: t });
    fireEvent.dragOver(row('Child'), { dataTransfer: t });
    fireEvent.drop(row('Child'), { dataTransfer: t });
    fireEvent.drop(row('A'), { dataTransfer: t });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('does not accept drops on documents', () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const t = dt();
    fireEvent.dragStart(row('Readme'), { dataTransfer: t });
    fireEvent.drop(row('Readme'), { dataTransfer: t });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('honours canDrop vetoes', () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} canDrop={() => false} />);
    const t = dt();
    fireEvent.dragStart(row('Readme'), { dataTransfer: t });
    fireEvent.drop(row('B'), { dataTransfer: t });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('is not draggable while renaming', () => {
    const { container } = render(<Harness renamingId={folderId('/B')} onRenameCancel={() => {}} />);
    const byId = (id: string) => container.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
    expect(byId(folderId('/B')).draggable).toBe(false);
    expect(byId(folderId('/A')).draggable).toBe(true);
  });
});

describe('ExplorerTree virtualization', () => {
  const many: ExplorerDoc[] = Array.from({ length: 5000 }, (_, i) => ({
    id: `m${i}`,
    title: `Doc ${String(i).padStart(4, '0')}`,
    path: '/',
  }));

  it('renders only a window of a very large tree but keeps aria set sizes truthful', () => {
    const { container } = render(<Harness docList={many} />);
    const rendered = items();
    expect(rendered.length).toBeLessThan(80);
    expect(rendered.length).toBeGreaterThan(10);
    const first = screen.getByText('Doc 0000').closest('[role=treeitem]')!;
    expect(first).toHaveAttribute('aria-setsize', String(5000 + 2)); // + folders A and B
    const spacer = container.querySelector('[data-explorer-spacer="bottom"]') as HTMLElement;
    expect(parseInt(spacer.style.height, 10)).toBeGreaterThan(5000 * 20);
  });

  it('renders further rows after scrolling and End focuses the last item', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness docList={many} />);
    const scroller = container.firstChild as HTMLElement;
    scroller.scrollTop = 28 * 3000;
    fireEvent.scroll(scroller);
    expect(screen.queryByText('Doc 0000')).not.toBeInTheDocument();
    expect(screen.getByText('Doc 2998')).toBeInTheDocument();

    items()[0].focus();
    await user.keyboard('{End}');
    expect(screen.getByText('Doc 4999').closest('[role=treeitem]')).toHaveFocus();
    expect(items().length).toBeLessThan(80);
  });

  it('keeps the tree reachable by Tab when the active row is scrolled out of the window', () => {
    const { container } = render(<Harness docList={many} />);
    const scroller = container.firstChild as HTMLElement;
    scroller.scrollTop = 28 * 3000;
    fireEvent.scroll(scroller);
    expect(items().every((i) => i.tabIndex === -1)).toBe(true);
    expect(screen.getByRole('tree').tabIndex).toBe(0);
  });
});

describe('ExplorerTree states', () => {
  it('shows the empty state instead of an empty tree', () => {
    render(
      <ExplorerTree nodes={[]} expanded={new Set()} onToggle={() => {}} ariaLabel="Files" emptyState={<p>Nothing here</p>} />,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('renders the inline new-folder row under its parent and submits the name', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Harness
        initial={[folderId('/A')]}
        creating={{ parentId: folderId('/A'), onSubmit, onCancel: () => {} }}
      />,
    );
    const input = screen.getByLabelText('New folder name');
    const all = items();
    const idx = all.findIndex((i) => within(i).queryByLabelText('New folder name'));
    expect(all[idx].getAttribute('aria-level')).toBe('2');
    // appended after the last child of A, before the next top-level item
    expect(all[idx - 1].textContent).toContain('Spec');
    expect(all[idx + 1].textContent).toContain('B');
    await user.type(input, 'Notes{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('Notes');
  });

  it('renders badges and per-row actions', () => {
    render(
      <Harness
        renderBadge={(n) => (n.kind === 'doc' ? <span>badge-{n.label}</span> : null)}
        renderActions={(n) => (n.kind === 'folder' ? <button type="button">act-{n.label}</button> : null)}
      />,
    );
    expect(screen.getByText('badge-Readme')).toBeInTheDocument();
    expect(screen.getByText('act-A')).toBeInTheDocument();
  });
});
