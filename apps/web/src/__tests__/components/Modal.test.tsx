import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Modal } from '../../components/Modal';

describe('Modal', () => {
  it('renders into document.body via Portal, not inside the trigger parent', async () => {
    const onClose = vi.fn();

    await act(async () => {
      render(
        <div data-testid="trigger-parent">
          <Modal open={true} onClose={onClose} title="Test Modal">
            <p>Modal content</p>
          </Modal>
        </div>,
      );
    });

    const dialog = screen.getByText('Test Modal').closest('.fixed');
    expect(dialog).toBeTruthy();
    // The modal should be a direct child of document.body (portal), not inside trigger-parent
    expect(dialog!.parentElement).toBe(document.body);
  });

  it('closes on Escape key', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <Modal open={true} onClose={onClose} title="Test">
          content
        </Modal>,
      );
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on backdrop click', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <Modal open={true} onClose={onClose} title="Test">
          content
        </Modal>,
      );
    });
    const backdrop = screen.getByText('Test').closest('.fixed');
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside the dialog', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <Modal open={true} onClose={onClose} title="Test">
          <button type="button">Inside</button>
        </Modal>,
      );
    });
    fireEvent.click(screen.getByText('Inside'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing when open=false', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Hidden">
        hidden content
      </Modal>,
    );
    expect(screen.queryByText('Hidden')).toBeNull();
  });
});
