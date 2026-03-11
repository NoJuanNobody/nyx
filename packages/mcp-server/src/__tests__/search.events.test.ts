import { describe, it, expect, vi } from 'vitest';
import { searchEventBus } from '../search/search.events.js';

describe('SearchEventBus', () => {
  it('emits search_started event', () => {
    const handler = vi.fn();
    searchEventBus.on('search_started', handler);
    searchEventBus.emitSearchStarted('test query');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'search_started',
      query: 'test query',
    });

    searchEventBus.removeListener('search_started', handler);
  });

  it('emits search_completed with results', () => {
    const handler = vi.fn();
    searchEventBus.on('search_completed', handler);
    const results = [
      { title: 'Test', url: 'https://example.com', snippet: 'snippet', source: 'brave' },
    ];
    searchEventBus.emitSearchCompleted('test query', results);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'search_completed',
      query: 'test query',
      results,
    });

    searchEventBus.removeListener('search_completed', handler);
  });

  it('emits search_failed with error', () => {
    const handler = vi.fn();
    searchEventBus.on('search_failed', handler);
    searchEventBus.emitSearchFailed('test query', 'API error');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'search_failed',
      query: 'test query',
      error: 'API error',
    });

    searchEventBus.removeListener('search_failed', handler);
  });
});
