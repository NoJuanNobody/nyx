import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearanceSettings } from '../../components/AppearanceSettings';
import { useUIStore } from '../../stores/ui.store';

describe('AppearanceSettings', () => {
  it('switches theme and accent and persists them', () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByTestId('theme-dark'));
    expect(useUIStore.getState().theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('nyx:theme')).toBe('dark');

    fireEvent.click(screen.getByTestId('accent-teal'));
    expect(useUIStore.getState().accent).toBe('teal');
    expect(document.documentElement.style.getPropertyValue('--accent-hue')).toBe('200');
    expect(screen.getByTestId('accent-teal')).toHaveAttribute('aria-checked', 'true');
  });
});
