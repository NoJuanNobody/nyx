import { describe, it, expect } from 'vitest';
import { formatOutput } from '../utils/output.js';

describe('formatOutput', () => {
  it('formats data as JSON by default', () => {
    const data = { id: '1', name: 'test' };
    const result = formatOutput(data);
    expect(JSON.parse(result)).toEqual(data);
  });

  it('formats array as table', () => {
    const data = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ];
    const result = formatOutput(data, 'table');
    expect(result).toContain('id');
    expect(result).toContain('name');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
    // Should have header + separator + 2 rows = 4 lines
    expect(result.split('\n').length).toBe(4);
  });

  it('formats object as key-value table', () => {
    const data = { apiKey: 'abc123', apiUrl: 'http://localhost' };
    const result = formatOutput(data, 'table');
    expect(result).toContain('apiKey');
    expect(result).toContain('abc123');
  });

  it('returns "(no results)" for empty array in table mode', () => {
    expect(formatOutput([], 'table')).toBe('(no results)');
  });

  it('stringifies primitives', () => {
    expect(formatOutput('hello')).toBe('"hello"');
    expect(formatOutput('hello', 'table')).toBe('hello');
  });
});
