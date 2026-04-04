import { Marked } from 'marked';
// @ts-expect-error no type declarations
import { markedTerminal } from 'marked-terminal';

const marked = new Marked();
marked.use(markedTerminal({
  reflowText: true,
  width: Math.min(process.stdout.columns || 80, 100),
  tab: 2,
}) as Record<string, unknown>);

export function renderMarkdown(text: string): string {
  return (marked.parse(text) as string).trimEnd();
}
