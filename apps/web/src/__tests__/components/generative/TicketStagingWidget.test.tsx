import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TicketStagingWidget } from '../../../components/generative/TicketStagingWidget';

describe('TicketStagingWidget', () => {
  it('renders with provided title and description', () => {
    render(
      <TicketStagingWidget
        title="Add email verification"
        description="Users should verify their email on sign-up."
        priority="high"
      />,
    );

    expect(screen.getByTestId('ticket-staging-widget')).toBeTruthy();
    const titleInput = screen.getByTestId('ticket-title-input') as HTMLInputElement;
    expect(titleInput.value).toBe('Add email verification');
    const descInput = screen.getByTestId('ticket-description-input') as HTMLTextAreaElement;
    expect(descInput.value).toBe('Users should verify their email on sign-up.');
  });

  it('calls onDispatch with current values on approve', () => {
    const onDispatch = vi.fn();
    render(
      <TicketStagingWidget
        title="Fix login bug"
        description="Login fails when..."
        priority="medium"
        labels={['bug', 'auth']}
        onDispatch={onDispatch}
      />,
    );

    fireEvent.click(screen.getByTestId('ticket-dispatch-btn'));
    expect(onDispatch).toHaveBeenCalledWith({
      title: 'Fix login bug',
      description: 'Login fails when...',
      priority: 'medium',
      labels: ['bug', 'auth'],
    });
  });

  it('disables dispatch when title is empty', () => {
    render(<TicketStagingWidget title="" />);
    const btn = screen.getByTestId('ticket-dispatch-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('allows editing title before dispatch', () => {
    const onDispatch = vi.fn();
    render(
      <TicketStagingWidget title="Original title" onDispatch={onDispatch} />,
    );

    const titleInput = screen.getByTestId('ticket-title-input') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByTestId('ticket-dispatch-btn'));

    expect(onDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Updated title' }),
    );
  });

  it('calls onDismiss when dismiss is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <TicketStagingWidget title="Some ticket" onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByTestId('ticket-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('shows dispatched state after approval', () => {
    render(
      <TicketStagingWidget title="My ticket" onDispatch={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('ticket-dispatch-btn'));
    expect(screen.getByTestId('ticket-staging-dispatched')).toBeTruthy();
  });

  it('renders labels as chips', () => {
    render(
      <TicketStagingWidget
        title="Ticket"
        labels={['feature', 'frontend']}
      />,
    );

    expect(screen.getByText('feature')).toBeTruthy();
    expect(screen.getByText('frontend')).toBeTruthy();
  });
});
