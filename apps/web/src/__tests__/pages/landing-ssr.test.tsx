// @vitest-environment node
/**
 * SSR tests for Landing: verifies that FadeIn-wrapped content renders visible
 * (opacity: 1) in renderToString so crawlers see the full page body.
 */
import { describe, it, expect } from 'vitest';
import * as ReactDOMServer from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import React from 'react';
import { Landing } from '../../pages/Landing';

function renderLandingToString(): string {
  return ReactDOMServer.renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, { path: '/', element: React.createElement(Landing) }),
      ),
    ),
  );
}

describe('Landing SSR', () => {
  it('produces non-empty HTML in Node (SSR) environment', () => {
    const html = renderLandingToString();
    expect(html.length).toBeGreaterThan(500);
  });

  it('renders FadeIn content as visible (opacity:1, not opacity:0)', () => {
    const html = renderLandingToString();
    // With the SSR fix, inView defaults to true → FadeIn elements render opacity:1.
    // Use a regex: opacity:0.3 and opacity:0.4 appear in non-FadeIn styles and
    // contain "opacity:0" as a substring, so we check for the exact value 0.
    expect(html).toContain('opacity:1');
    expect(html).not.toMatch(/opacity:0(?![.\d])/);
  });

  it('renders the hero h1 text', () => {
    const html = renderLandingToString();
    expect(html).toContain('From first idea');
    expect(html).toContain('living codebase');
  });

  it('renders all six feature titles', () => {
    const html = renderLandingToString();
    expect(html).toContain('Always In Sync');
    expect(html).toContain('AI at Every Stage');
    expect(html).toContain('Non-Dev to Ticket');
    expect(html).toContain('Full Version History');
    expect(html).toContain('AI Agent Map');
    expect(html).toContain('AI-Ready Specs');
  });

  it('renders the stat section (problem section) numbers', () => {
    const html = renderLandingToString();
    expect(html).toContain('62%');
    expect(html).toContain('41%');
    expect(html).toContain('8h+');
  });
});
