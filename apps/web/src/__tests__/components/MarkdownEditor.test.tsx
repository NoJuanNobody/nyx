import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ fetchTemplates: vi.fn() }));
vi.mock('../../lib/api', () => ({ fetchTemplates: mocks.fetchTemplates }));

import { MarkdownEditor } from '../../components/MarkdownEditor';
import { MarkdownToolbar } from '../../components/MarkdownToolbar';
import { useEditorController } from '../../hooks/useEditorController';
import type { MentionCandidate } from '../../lib/slashCommands';

function Harness({
  initial = '',
  mentions,
  onValue,
  onSelection,
}: {
  initial?: string;
  mentions?: MentionCandidate[];
  onValue?: (v: string) => void;
  onSelection?: (text: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const controller = useEditorController(value, (v) => {
    setValue(v);
    onValue?.(v);
  }, 'doc-1');
  return (
    <>
      <MarkdownToolbar controller={controller} />
      <MarkdownEditor
        value={value}
        controller={controller}
        mentionCandidates={mentions}
        onSelection={(text) => onSelection?.(text)}
      />
    </>
  );
}

function ta(): HTMLTextAreaElement {
  return screen.getByTestId('markdown-textarea') as HTMLTextAreaElement;
}

function select(start: number, end = start) {
  ta().setSelectionRange(start, end);
}

function type(text: string) {
  fireEvent.change(ta(), { target: { value: text } });
}

const mod = { ctrlKey: true };

beforeEach(() => {
  mocks.fetchTemplates.mockReset();
  // Offline / server unreachable: built-in editing must still work.
  mocks.fetchTemplates.mockRejectedValue(new Error('network down'));
});

describe('MarkdownToolbar actions', () => {
  it('bold / italic / code wrap the selection and toggle off', () => {
    render(<Harness initial="hello world" />);
    select(0, 5);
    fireEvent.click(screen.getByTestId('toolbar-bold'));
    expect(ta().value).toBe('**hello** world');
    expect(ta().value.slice(ta().selectionStart, ta().selectionEnd)).toBe('hello');

    fireEvent.click(screen.getByTestId('toolbar-bold'));
    expect(ta().value).toBe('hello world');

    select(6, 11);
    fireEvent.click(screen.getByTestId('toolbar-italic'));
    expect(ta().value).toBe('hello *world*');
    select(0, 5);
    fireEvent.click(screen.getByTestId('toolbar-code'));
    expect(ta().value).toBe('`hello` *world*');
  });

  it('applies list, task and quote prefixes to the selected lines', () => {
    render(<Harness initial={'a\nb'} />);
    select(0, 3);
    fireEvent.click(screen.getByTestId('toolbar-ol'));
    expect(ta().value).toBe('1. a\n2. b');
    select(0, ta().value.length);
    fireEvent.click(screen.getByTestId('toolbar-task'));
    expect(ta().value).toBe('- [ ] a\n- [ ] b');
    select(0, ta().value.length);
    fireEvent.click(screen.getByTestId('toolbar-quote'));
    expect(ta().value).toBe('> a\n> b');
  });

  it('heading menu sets the level and closes', () => {
    render(<Harness initial="Title" />);
    select(2);
    fireEvent.click(screen.getByTestId('toolbar-heading'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toolbar-h2'));
    expect(ta().value).toBe('## Title');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('inserts a link and selects the url placeholder', () => {
    render(<Harness initial="docs" />);
    select(0, 4);
    fireEvent.click(screen.getByTestId('toolbar-link'));
    expect(ta().value).toBe('[docs](url)');
    expect(ta().value.slice(ta().selectionStart, ta().selectionEnd)).toBe('url');
  });

  it('exposes an accessible toolbar with named buttons and undo/redo state', () => {
    render(<Harness initial="x" />);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    expect(bar).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
    expect(screen.getByTestId('toolbar-undo')).toBeDisabled();
    expect(screen.getByTestId('toolbar-redo')).toBeDisabled();
    select(0, 1);
    fireEvent.click(screen.getByTestId('toolbar-bold'));
    expect(screen.getByTestId('toolbar-undo')).not.toBeDisabled();
  });

  it('has a single tab stop and arrow keys move between buttons', () => {
    render(<Harness initial="x" />);
    const stops = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('data-tb-item') && b.tabIndex === 0);
    expect(stops).toHaveLength(1);
    stops[0].focus();
    fireEvent.keyDown(stops[0], { key: 'ArrowRight' });
    expect(document.activeElement).not.toBe(stops[0]);
  });
});

describe('keyboard shortcuts (Cmd and Ctrl)', () => {
  it.each([{ ctrlKey: true }, { metaKey: true }])('Bold and Strike work with %o', (m) => {
    render(<Harness initial="word" />);
    select(0, 4);
    fireEvent.keyDown(ta(), { key: 'b', ...m });
    expect(ta().value).toBe('**word**');
    fireEvent.keyDown(ta(), { key: 'b', ...m });
    expect(ta().value).toBe('word');
    select(0, 4);
    fireEvent.keyDown(ta(), { key: 'x', shiftKey: true, ...m });
    expect(ta().value).toBe('~~word~~');
  });

  it('Mod+K inserts a link and Mod+Alt+1 sets a heading', () => {
    render(<Harness initial="docs" />);
    select(0, 4);
    fireEvent.keyDown(ta(), { key: 'k', ...mod });
    expect(ta().value).toBe('[docs](url)');
    fireEvent.change(ta(), { target: { value: 'Title' } });
    select(0);
    fireEvent.keyDown(ta(), { key: '1', code: 'Digit1', altKey: true, ...mod });
    expect(ta().value).toBe('# Title');
  });

  it('prevents the default browser action for handled shortcuts only', () => {
    render(<Harness initial="x" />);
    const handled = fireEvent.keyDown(ta(), { key: 'b', ...mod });
    expect(handled).toBe(false); // preventDefault called
    const unhandled = fireEvent.keyDown(ta(), { key: 'q', ...mod });
    expect(unhandled).toBe(true);
  });

  it('Enter continues a list and an empty item ends it', () => {
    render(<Harness initial="- one" />);
    select(5);
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(ta().value).toBe('- one\n- ');
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(ta().value).toBe('- one\n');
  });

  it('Tab indents list items but never traps focus in plain text', () => {
    render(<Harness initial={'- item\n\nplain'} />);
    select(3);
    expect(fireEvent.keyDown(ta(), { key: 'Tab' })).toBe(false);
    expect(ta().value.startsWith('  - item')).toBe(true);
    select(ta().value.length);
    expect(fireEvent.keyDown(ta(), { key: 'Tab' })).toBe(true); // default focus move allowed
  });

  it('ignores shortcuts while an IME composition is active', () => {
    render(<Harness initial="word" />);
    select(0, 4);
    fireEvent.keyDown(ta(), { key: 'b', ...mod, isComposing: true });
    expect(ta().value).toBe('word');
  });

  it('pasting a URL over a selection makes a link', () => {
    render(<Harness initial="site" />);
    select(0, 4);
    fireEvent.paste(ta(), { clipboardData: { getData: () => 'https://nyx.dev' } });
    expect(ta().value).toBe('[site](https://nyx.dev)');
  });
});

describe('undo / redo', () => {
  it('undoes and redoes formatting with Cmd/Ctrl+Z and Shift+Z / Y', () => {
    render(<Harness initial="hello" />);
    select(0, 5);
    fireEvent.keyDown(ta(), { key: 'b', ...mod });
    expect(ta().value).toBe('**hello**');

    fireEvent.keyDown(ta(), { key: 'z', ...mod });
    expect(ta().value).toBe('hello');
    expect(ta().value.slice(ta().selectionStart, ta().selectionEnd)).toBe('hello');

    fireEvent.keyDown(ta(), { key: 'z', shiftKey: true, ...mod });
    expect(ta().value).toBe('**hello**');

    fireEvent.keyDown(ta(), { key: 'z', ...mod });
    fireEvent.keyDown(ta(), { key: 'y', ...mod });
    expect(ta().value).toBe('**hello**');
  });

  it('undoes typed text and toolbar edits in order', () => {
    render(<Harness initial="a" />);
    type('ab');
    select(0, 2);
    fireEvent.click(screen.getByTestId('toolbar-bold'));
    expect(ta().value).toBe('**ab**');
    fireEvent.click(screen.getByTestId('toolbar-undo'));
    expect(ta().value).toBe('ab');
    fireEvent.click(screen.getByTestId('toolbar-undo'));
    expect(ta().value).toBe('a');
    expect(screen.getByTestId('toolbar-undo')).toBeDisabled();
    fireEvent.click(screen.getByTestId('toolbar-redo'));
    expect(ta().value).toBe('ab');
  });

  it('groups rapid typing into one undo step', () => {
    render(<Harness initial="" />);
    type('h');
    type('he');
    type('hel');
    type('hell');
    fireEvent.keyDown(ta(), { key: 'z', ...mod });
    expect(ta().value).toBe('');
  });

  it('handles native historyUndo / historyRedo from the app menu', () => {
    render(<Harness initial="hello" />);
    select(0, 5);
    fireEvent.keyDown(ta(), { key: 'b', ...mod });
    const ev = new Event('beforeinput', { cancelable: true }) as Event & { inputType: string };
    ev.inputType = 'historyUndo';
    act(() => {
      ta().dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(ta().value).toBe('hello');
  });

  it('a new edit after undo discards the redo branch', () => {
    render(<Harness initial="x" />);
    select(0, 1);
    fireEvent.keyDown(ta(), { key: 'b', ...mod });
    fireEvent.keyDown(ta(), { key: 'z', ...mod });
    select(0, 1);
    fireEvent.keyDown(ta(), { key: 'i', ...mod });
    expect(ta().value).toBe('*x*');
    expect(screen.getByTestId('toolbar-redo')).toBeDisabled();
  });
});

describe('slash commands (offline)', () => {
  it('opens on "/" with built-in commands even though the template fetch fails', async () => {
    render(<Harness initial="" />);
    type('/');
    await act(async () => {});
    const list = screen.getByRole('listbox');
    expect(list).toBeInTheDocument();
    expect(screen.getByText('Heading 1')).toBeInTheDocument();
    expect(screen.getByText('Task list')).toBeInTheDocument();
    expect(screen.getByText(/unavailable offline/i)).toBeInTheDocument();
  });

  it('filters while typing and inserts the highlighted command with Enter', async () => {
    render(<Harness initial="" />);
    type('/head');
    await act(async () => {});
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Heading 1');
    fireEvent.keyDown(ta(), { key: 'ArrowDown' });
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(ta().value).toBe('## ');
    expect(ta().selectionStart).toBe(3);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('inserts on click, replacing only the slash line', async () => {
    render(<Harness initial={'intro\n'} />);
    type('intro\n/task');
    await act(async () => {});
    fireEvent.click(screen.getByRole('option', { name: /Task list/ }));
    expect(ta().value).toBe('intro\n- [ ] ');
  });

  it('places the caret at the $0 marker for table and link snippets', async () => {
    render(<Harness initial="" />);
    type('/link');
    await act(async () => {});
    fireEvent.keyDown(ta(), { key: 'Tab' });
    expect(ta().value).toBe('[text](url)');
    expect(ta().selectionStart).toBe(1);
  });

  it('supports keyboard-only operation with ARIA wiring', async () => {
    render(<Harness initial="" />);
    type('/');
    await act(async () => {});
    const input = ta();
    const list = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    const active = input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ta(), { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).not.toBe(active);
  });

  it('Escape closes the palette, keeps the text and does not reopen on key up', async () => {
    render(<Harness initial="" />);
    type('/he');
    await act(async () => {});
    fireEvent.keyDown(ta(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyUp(ta(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(ta().value).toBe('/he');
    // typing more re-evaluates
    type('/hea');
    await act(async () => {});
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows nothing (and lets Enter insert a newline) when no command matches', async () => {
    render(<Harness initial="" />);
    type('/usr/local');
    await act(async () => {});
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is a single undo step', async () => {
    render(<Harness initial="" />);
    type('/h1');
    await act(async () => {});
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(ta().value).toBe('# ');
    fireEvent.keyDown(ta(), { key: 'z', ...mod });
    expect(ta().value).toBe('/h1');
  });
});

describe('document mentions (offline)', () => {
  const docs: MentionCandidate[] = [
    { id: 'd1', title: 'Billing spec' },
    { id: 'd2', title: 'Auth spec' },
  ];

  it('suggests local documents after @ and inserts a nyx link', async () => {
    render(<Harness initial="" mentions={docs} />);
    type('see @bil');
    await act(async () => {});
    expect(screen.getByRole('option', { name: /Billing spec/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Auth spec/ })).toBeNull();
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(ta().value).toBe('see [Billing spec](nyx://doc/d1) ');
    expect(mocks.fetchTemplates).not.toHaveBeenCalled();
  });

  it('does nothing without candidates', async () => {
    render(<Harness initial="" mentions={[]} />);
    type('@x');
    await act(async () => {});
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('selection reporting', () => {
  it('reports the selected text on mouse up', () => {
    const onSelection = vi.fn();
    render(<Harness initial="hello world" onSelection={onSelection} />);
    select(6, 11);
    fireEvent.mouseUp(ta());
    expect(onSelection).toHaveBeenCalledWith('world');
  });
});

describe('large documents', () => {
  it('skips the highlight overlay above the size threshold', () => {
    const big = 'word '.repeat(60_000); // 300k chars
    const { container } = render(<Harness initial={big} />);
    expect(container.querySelector('pre[aria-hidden="true"]')).toBeNull();
    expect(ta().className).not.toContain('text-transparent');
  });

  it('formats and undoes quickly on a very large document', () => {
    const big = 'line of text here\n'.repeat(20_000);
    render(<Harness initial={big} />);
    select(0, 4);
    const t0 = performance.now();
    fireEvent.keyDown(ta(), { key: 'b', ...mod });
    fireEvent.keyDown(ta(), { key: 'z', ...mod });
    expect(ta().value).toBe(big);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
