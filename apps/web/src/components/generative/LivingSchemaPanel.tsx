/**
 * LivingSchemaPanel — Hashbrown-powered panel that renders LivingSchemaPreview
 * components inside the spec editor when writing schemas or API contracts.
 *
 * Editor tools let the model read the current selection and insert markdown
 * sections, making the AI aware of the document context.
 */
import { useRef } from 'react';
import { useUiChat, exposeComponent, useTool } from '@hashbrownai/react';
import { s } from '@hashbrownai/core';
import { LivingSchemaPreview } from './LivingSchemaPreview';

// ── Component schema ─────────────────────────────────────────────────────────

const exposedSchemaPreview = exposeComponent(LivingSchemaPreview, {
  name: 'LivingSchemaPreview',
  description:
    'Renders an interactive, visual preview of a database entity, API endpoint, or state machine schema.',
  props: {
    entityName: s.streaming.string('The entity or table name').optional(),
    entityDescription: s.streaming.string('What this entity represents').optional(),
    schemaType: s.enum(['entity', 'api', 'state-machine'], 'The type of schema').optional(),
    fields: s
      .array(
        s.object({
          name: s.string('Field name'),
          type: s.string('Data type (e.g. uuid, text, timestamp, jsonb)'),
          description: s.string('What this field stores').optional(),
          required: s.boolean('Is this field required?').optional(),
          references: s.string('Name of entity this field references, if a FK').optional(),
        }, 'A single field definition'),
        'The fields/properties of this entity',
      )
      .optional(),
    relatedEntities: s
      .array(
        s.object({
          name: s.string('Entity name'),
          description: s.string('Brief description').optional(),
          fields: s.array(
            s.object({
              name: s.string('Field name'),
              type: s.string('Data type'),
            }, 'A related field'),
            'Fields',
          ).optional(),
        }, 'A related entity'),
        'Other entities this one relates to',
      )
      .optional(),
  },
});

// ── Panel ─────────────────────────────────────────────────────────────────────

export interface LivingSchemaPanelProps {
  /** Current selection in the editor */
  selection?: string;
  /** Callback to insert markdown into the editor at current cursor */
  onInsert?: (markdown: string) => void;
}

export function LivingSchemaPanel({ selection, onInsert }: LivingSchemaPanelProps) {
  const insertRef = useRef(onInsert);
  insertRef.current = onInsert;

  const getEditorSelection = useTool({
    name: 'getEditorSelection',
    description: 'Get the currently selected text in the spec editor',
    parameters: s.object({}, 'No parameters needed'),
    handler: () => ({ selection: selection ?? '' }),
    deps: [selection],
  });

  const insertMarkdownSection = useTool({
    name: 'insertMarkdownSection',
    description: 'Insert a markdown section into the spec editor at the current cursor position',
    parameters: s.object({
      markdown: s.string('The markdown text to insert'),
    }, 'Insert parameters'),
    handler: ({ markdown }: { markdown: string }) => {
      insertRef.current?.(markdown);
      return { inserted: true };
    },
    deps: [],
  });

  const chat = useUiChat({
    system: `You are the Nyx spec editor assistant. You help users visualize and author structured schemas.
When asked to preview a schema, use the LivingSchemaPreview component to render it.
You can also use getEditorSelection to see what the user has written, and insertMarkdownSection to add schema documentation to their spec.
Keep schemas concise and developer-friendly.`,
    components: [exposedSchemaPreview],
    tools: [getEditorSelection, insertMarkdownSection],
  });

  const assistantMessages = chat.messages.filter((m) => m.role === 'assistant');

  return (
    <div className="space-y-3" data-testid="living-schema-panel">
      {assistantMessages.map((message, i) =>
        message.role === 'assistant' ? (
          <div key={i}>
            {typeof message.ui !== 'undefined' ? message.ui : null}
            {message.content && typeof message.content === 'string' && (
              <p className="text-sm text-slate-600">{message.content}</p>
            )}
          </div>
        ) : null,
      )}

      {/* Input */}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const msg = fd.get('msg')?.toString().trim();
          if (msg) {
            chat.sendMessage({ role: 'user', content: msg });
            (e.currentTarget.querySelector('input[name="msg"]') as HTMLInputElement).value = '';
          }
        }}
      >
        <input
          name="msg"
          type="text"
          className="flex-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none"
          placeholder="Ask for a schema preview…"
          data-testid="living-schema-input"
        />
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
          data-testid="living-schema-submit"
        >
          Preview
        </button>
      </form>
    </div>
  );
}
