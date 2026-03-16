export type OutputFormat = 'json' | 'table';

export function formatOutput(data: unknown, format: OutputFormat = 'json'): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // Table format
  if (Array.isArray(data)) {
    if (data.length === 0) return '(no results)';
    const keys = Object.keys(data[0] as Record<string, unknown>);
    const widths = keys.map((k) => {
      const values = data.map((row) => String((row as Record<string, unknown>)[k] ?? ''));
      return Math.max(k.length, ...values.map((v) => v.length));
    });

    const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
    const separator = widths.map((w) => '-'.repeat(w)).join('  ');
    const rows = data.map((row) =>
      keys.map((k, i) => String((row as Record<string, unknown>)[k] ?? '').padEnd(widths[i])).join('  '),
    );

    return [header, separator, ...rows].join('\n');
  }

  if (data !== null && typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    const maxKey = Math.max(...entries.map(([k]) => k.length));
    return entries
      .map(([k, v]) => `${k.padEnd(maxKey)}  ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
  }

  return String(data);
}

export function error(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
