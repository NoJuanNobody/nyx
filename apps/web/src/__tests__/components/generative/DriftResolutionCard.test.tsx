import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DriftResolutionCard } from '../../../components/generative/DriftResolutionCard';

describe('DriftResolutionCard', () => {
  it('renders summary and severity badge', () => {
    render(
      <DriftResolutionCard
        summary="The User entity no longer has an email field in the code."
        severity="high"
      />,
    );

    expect(screen.getByTestId('drift-resolution-card')).toBeTruthy();
    expect(screen.getByText('The User entity no longer has an email field in the code.')).toBeTruthy();
    expect(screen.getByTestId('drift-severity-badge').textContent).toBe('high');
  });

  it('renders spec and code snippets side by side', () => {
    render(
      <DriftResolutionCard
        summary="Field mismatch"
        specSnippet="email: string"
        codeSnippet="// email removed"
      />,
    );

    expect(screen.getByTestId('drift-spec-snippet')).toBeTruthy();
    expect(screen.getByTestId('drift-code-snippet')).toBeTruthy();
    expect(screen.getByText('email: string')).toBeTruthy();
    expect(screen.getByText('// email removed')).toBeTruthy();
  });

  it('calls onAction when user picks a recommendation', () => {
    const onAction = vi.fn();
    render(
      <DriftResolutionCard
        summary="Drift detected"
        recommendations={['Update Spec to Match Code', 'Generate PR']}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByTestId('drift-action-update-spec-to-match-code'));
    expect(onAction).toHaveBeenCalledWith('Update Spec to Match Code');
  });

  it('calls onSnooze when snooze is clicked', () => {
    const onSnooze = vi.fn();
    render(
      <DriftResolutionCard
        summary="Drift detected"
        recommendations={['Update Spec', 'Snooze']}
        onSnooze={onSnooze}
      />,
    );

    fireEvent.click(screen.getByTestId('drift-action-snooze'));
    expect(onSnooze).toHaveBeenCalled();
  });

  it('shows resolved state after action', () => {
    render(
      <DriftResolutionCard
        summary="Drift detected"
        recommendations={['Update Spec']}
        onAction={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('drift-action-update-spec'));
    expect(screen.getByTestId('drift-resolution-card-resolved')).toBeTruthy();
    expect(screen.getByText('Update Spec', { exact: false })).toBeTruthy();
  });

  it('uses medium severity by default', () => {
    render(<DriftResolutionCard summary="Some drift" />);
    expect(screen.getByTestId('drift-severity-badge').textContent).toBe('medium');
  });
});
