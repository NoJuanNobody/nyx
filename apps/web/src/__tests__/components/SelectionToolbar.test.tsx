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
});
