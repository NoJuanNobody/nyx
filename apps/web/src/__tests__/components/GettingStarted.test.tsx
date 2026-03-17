import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GettingStarted } from '../../pages/GettingStarted';

function renderPage() {
  return render(
    <MemoryRouter>
      <GettingStarted />
    </MemoryRouter>,
  );
}

describe('GettingStarted', () => {
  it('renders the page heading', () => {
    renderPage();
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(
      screen.getByText('Learn how to use Nyx to keep your specs and code in sync.'),
    ).toBeInTheDocument();
  });

  it('renders all three tabs', () => {
    renderPage();
    expect(screen.getByTestId('tab-tutorial')).toBeInTheDocument();
    expect(screen.getByTestId('tab-help')).toBeInTheDocument();
    expect(screen.getByTestId('tab-examples')).toBeInTheDocument();
  });

  it('shows the tutorial tab by default', () => {
    renderPage();
    expect(screen.getByTestId('tutorial-tab')).toBeInTheDocument();
    expect(screen.getByTestId('tutorial-progress')).toHaveTextContent('0/5 steps');
  });

  it('renders all five tutorial steps', () => {
    renderPage();
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`tutorial-step-${i}`)).toBeInTheDocument();
    }
  });

  it('marks a tutorial step as completed when clicked', () => {
    renderPage();
    const checkbox = screen.getByLabelText(/Mark "1. Connect your repository" complete/);
    fireEvent.click(checkbox);
    expect(screen.getByTestId('tutorial-progress')).toHaveTextContent('1/5 steps');
  });

  it('unmarks a tutorial step when clicked again', () => {
    renderPage();
    const checkbox = screen.getByLabelText(/Mark "1. Connect your repository" complete/);
    fireEvent.click(checkbox);
    expect(screen.getByTestId('tutorial-progress')).toHaveTextContent('1/5 steps');
    const uncheckbox = screen.getByLabelText(/Mark "1. Connect your repository" incomplete/);
    fireEvent.click(uncheckbox);
    expect(screen.getByTestId('tutorial-progress')).toHaveTextContent('0/5 steps');
  });

  it('switches to the help tab and shows FAQ topics', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('tab-help'));
    expect(screen.getByTestId('help-tab')).toBeInTheDocument();
    expect(screen.getByText('What is Nyx?')).toBeInTheDocument();
    expect(screen.getByText('How does drift detection work?')).toBeInTheDocument();
  });

  it('expands a help topic when clicked', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('tab-help'));
    const topicButton = screen.getByText('What is Nyx?');
    fireEvent.click(topicButton);
    expect(
      screen.getByText(/product versioning platform that keeps technical documentation/),
    ).toBeInTheDocument();
  });

  it('collapses a help topic when clicked again', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('tab-help'));
    const topicButton = screen.getByText('What is Nyx?');
    fireEvent.click(topicButton);
    expect(
      screen.getByText(/product versioning platform that keeps technical documentation/),
    ).toBeInTheDocument();
    fireEvent.click(topicButton);
    expect(
      screen.queryByText(/product versioning platform that keeps technical documentation/),
    ).not.toBeInTheDocument();
  });

  it('switches to the examples tab and shows example projects', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('tab-examples'));
    expect(screen.getByTestId('examples-tab')).toBeInTheDocument();
    expect(screen.getByText('User Authentication Flow')).toBeInTheDocument();
    expect(screen.getByText('REST API Endpoint Design')).toBeInTheDocument();
    expect(screen.getByText('Dashboard UI Component')).toBeInTheDocument();
  });

  it('shows tags on example projects', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('tab-examples'));
    expect(screen.getByText('Auth')).toBeInTheDocument();
    expect(screen.getAllByText('Backend').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Security')).toBeInTheDocument();
  });

  it('shows spec snippets in example projects', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('tab-examples'));
    expect(screen.getByText(/multi-provider authentication system/)).toBeInTheDocument();
  });

  it('shows tutorial step links for incomplete steps', () => {
    renderPage();
    expect(screen.getByText('Go to Repositories')).toBeInTheDocument();
    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
  });

  it('hides tutorial step links for completed steps', () => {
    renderPage();
    const checkbox = screen.getByLabelText(/Mark "1. Connect your repository" complete/);
    fireEvent.click(checkbox);
    expect(screen.queryByText('Go to Repositories')).not.toBeInTheDocument();
  });
});
