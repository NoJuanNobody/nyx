import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LifecycleExplorer } from '../../components/LifecycleExplorer';
import { STAGES } from '../../lib/stages';

describe('LifecycleExplorer', () => {
  it('does not pull external stylesheets (works offline in the desktop shell)', () => {
    render(<LifecycleExplorer />);
    expect(document.head.querySelector('link[rel="stylesheet"][href^="http"]')).toBeNull();
  });

  it('marks the active stage and moves between stages with arrow keys', async () => {
    const user = userEvent.setup();
    render(<LifecycleExplorer />);
    const nodes = STAGES.map((_, i) => screen.getByTestId(`stage-node-${i}`));
    expect(nodes[0]).toHaveAttribute('aria-current', 'step');
    expect(nodes.filter((n) => n.tabIndex === 0)).toHaveLength(1);

    nodes[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('stage-node-1')).toHaveAttribute('aria-current', 'step');

    await user.keyboard('{End}');
    expect(screen.getByTestId(`stage-node-${STAGES.length - 1}`)).toHaveAttribute('aria-current', 'step');
    await user.keyboard('{Home}');
    expect(screen.getByTestId('stage-node-0')).toHaveAttribute('aria-current', 'step');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('stage-node-0')).toHaveAttribute('aria-current', 'step');
  });
});
