import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SelectionToolbar } from '../../components/SelectionToolbar';

const ANCHOR = new DOMRect(100, 200, 400, 24);

describe('SelectionToolbar', () => {
  it('renders via Portal into document.body', async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();

    await act(async () => {
      render(
        <div data-testid="wrapper">
          <SelectionToolbar
            anchorRect={ANCHOR}
            selectedText="hello world"
            onAction={onAction}
            onDismiss={onDismiss}
          />
        </div>,
      );
    });

    const toolbar = screen.getByRole('toolbar');
    expect(toolbar).toBeTruthy();
    // Rendered via Portal — parent should be document.body, not the wrapper div
    expect(toolbar.parentElement).toBe(document.body);
  });

  it('renders all action buttons', async () => {
    await act(async () => {
      render(
        <SelectionToolbar
          anchorRect={ANCHOR}
          selectedText="selected"
          onAction={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
    });

    expect(screen.getByTestId('selection-action-improve')).toBeTruthy();
    expect(screen.getByTestId('selection-action-fix-grammar')).toBeTruthy();
    expect(screen.getByTestId('selection-action-make-shorter')).toBeTruthy();
    expect(screen.getByTestId('selection-action-make-longer')).toBeTruthy();
    expect(screen.getByTestId('selection-action-summarize')).toBeTruthy();
  });

  it('calls onAction with instruction + selected text when a button is clicked', async () => {
    const onAction = vi.fn();

    await act(async () => {
      render(
        <SelectionToolbar
          anchorRect={ANCHOR}
          selectedText="some text"
          onAction={onAction}
          onDismiss={vi.fn()}
        />,
      );
    });

    fireEvent.click(screen.getByTestId('selection-action-improve'));
    expect(onAction).toHaveBeenCalledOnce();
    const arg = onAction.mock.calls[0][0] as string;
    expect(arg).toContain('some text');
    expect(arg.toLowerCase()).toContain('improve');
  });

  it('disables all buttons when isPending=true', async () => {
    await act(async () => {
      render(
        <SelectionToolbar
          anchorRect={ANCHOR}
          selectedText="text"
          onAction={vi.fn()}
          onDismiss={vi.fn()}
          isPending
        />,
      );
    });

    const buttons = screen.getAllByRole('button');
    for (const btn of buttons) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('calls onDismiss when clicking outside the toolbar', async () => {
    const onDismiss = vi.fn();

    await act(async () => {
      render(
        <SelectionToolbar
          anchorRect={ANCHOR}
          selectedText="text"
          onAction={vi.fn()}
          onDismiss={onDismiss}
        />,
      );
    });

    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('hides the AI group when no AI handler is given and shows local formatting', async () => {
    const onFormat = vi.fn();
    await act(async () => {
      render(
        <SelectionToolbar anchorRect={ANCHOR} selectedText="hi" onFormat={onFormat} onDismiss={vi.fn()} />,
      );
    });
    expect(screen.queryByTestId('selection-action-improve')).toBeNull();
    fireEvent.click(screen.getByTestId('selection-format-bold'));
    fireEvent.click(screen.getByTestId('selection-format-link'));
    expect(onFormat.mock.calls.map((c) => c[0])).toEqual(['bold', 'link']);
  });

  it('formatting stays enabled while an AI edit is pending or the AI is unavailable offline', async () => {
    await act(async () => {
      render(
        <SelectionToolbar
          anchorRect={ANCHOR}
          selectedText="hi"
          onFormat={vi.fn()}
          onAction={vi.fn()}
          onDismiss={vi.fn()}
          aiDisabledReason="AI quick-edit needs a network connection"
        />,
      );
    });
    const improve = screen.getByTestId('selection-action-improve') as HTMLButtonElement;
    expect(improve.disabled).toBe(true);
    expect(improve.title).toMatch(/network/);
    expect((screen.getByTestId('selection-format-bold') as HTMLButtonElement).disabled).toBe(false);
  });

  it('dismisses on Escape', async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      render(<SelectionToolbar anchorRect={ANCHOR} selectedText="hi" onFormat={vi.fn()} onDismiss={onDismiss} />);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('names every control for assistive tech and supports arrow-key navigation', async () => {
    await act(async () => {
      render(<SelectionToolbar anchorRect={ANCHOR} selectedText="hi" onFormat={vi.fn()} onDismiss={vi.fn()} />);
    });
    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
    const bold = screen.getByRole('button', { name: 'Bold' });
    bold.focus();
    fireEvent.keyDown(bold, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Italic' }));
  });

  it('positions with viewport coordinates (fixed) and flips below near the top edge', async () => {
    await act(async () => {
      render(
        <SelectionToolbar anchorRect={new DOMRect(100, 10, 50, 20)} selectedText="hi" onFormat={vi.fn()} onDismiss={vi.fn()} />,
      );
    });
    const tb = screen.getByTestId('selection-toolbar');
    expect(parseFloat(tb.style.top)).toBe(38); // below: bottom (30) + 8
  });
});
