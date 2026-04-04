export type OutputFormat = 'json' | 'table';

interface ColumnDef {
  key: string;
  label?: string;
  width?: number;
  transform?: (val: unknown) => string;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export { timeAgo };

export function formatTable(
  data: unknown[],
  columns: ColumnDef[],
): string {
  if (data.length === 0) return '(no results)';

  const rows = data.map((row) => {
    const r = row as Record<string, unknown>;
    return columns.map((col) => {
      const raw = r[col.key];
      if (col.transform) return col.transform(raw);
      return raw == null ? '' : String(raw);
    });
  });

  const widths = columns.map((col, i) => {
    const label = col.label ?? col.key;
    const maxData = Math.max(...rows.map((r) => r[i].length));
    const natural = Math.max(label.length, maxData);
    return col.width ? Math.min(natural, col.width) : natural;
  });

  const header = columns
    .map((col, i) => (col.label ?? col.key).padEnd(widths[i]))
    .join('  ');
  const separator = widths.map((w) => '─'.repeat(w)).join('──');
  const body = rows.map((row) =>
    row.map((cell, i) => truncate(cell, widths[i]).padEnd(widths[i])).join('  '),
  );

  return [header, separator, ...body].join('\n');
}

export function formatOutput(data: unknown, format: OutputFormat = 'json'): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // Table format
  if (Array.isArray(data)) {
    if (data.length === 0) return '(no results)';
    const keys = Object.keys(data[0] as Record<string, unknown>);
    return formatTable(data, keys.map((k) => ({ key: k, width: 60 })));
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
