import { EventEmitter } from 'events';
import type { SearchEvent } from './search.types.js';

class SearchEventBus extends EventEmitter {
  emitSearchStarted(query: string) {
    const event: SearchEvent = {
      type: 'search_started',
      query,
      timestamp: new Date().toISOString(),
    };
    this.emit('search_started', event);
  }

  emitSearchCompleted(query: string, results: SearchEvent['results']) {
    const event: SearchEvent = {
      type: 'search_completed',
      query,
      results,
      timestamp: new Date().toISOString(),
    };
    this.emit('search_completed', event);
  }

  emitSearchFailed(query: string, error: string) {
    const event: SearchEvent = {
      type: 'search_failed',
      query,
      error,
      timestamp: new Date().toISOString(),
    };
    this.emit('search_failed', event);
  }
}

export const searchEventBus = new SearchEventBus();
