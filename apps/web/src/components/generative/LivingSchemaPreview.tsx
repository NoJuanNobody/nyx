/**
 * LivingSchemaPreview — generative UI component for interactive entity/schema
 * visualization inside the spec editor.
 *
 * The model can stream a JSON/table view of database schemas, API contracts,
 * or state machines. Users can interact with the rendered entities inline.
 */

export interface EntityField {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  /** Whether this is a foreign key reference */
  references?: string;
}

export interface SchemaEntity {
  name: string;
  description?: string;
  fields: EntityField[];
}

export interface LivingSchemaPreviewProps {
  /** Entity/table name, e.g. "User" or "Order" */
  entityName?: string;
  /** High-level description of the entity */
  entityDescription?: string;
  /** Schema type: entity table, API endpoint, or state machine */
  schemaType?: 'entity' | 'api' | 'state-machine';
  /** The fields / properties to display */
  fields?: EntityField[];
  /** Related entities (for ER diagrams) */
  relatedEntities?: SchemaEntity[];
}

const TYPE_BADGE: Record<string, string> = {
  string: 'bg-green-100 text-green-700',
  number: 'bg-blue-100 text-blue-700',
  boolean: 'bg-purple-100 text-purple-700',
  uuid: 'bg-slate-100 text-slate-600',
  timestamp: 'bg-orange-100 text-orange-700',
  jsonb: 'bg-yellow-100 text-yellow-700',
  text: 'bg-green-100 text-green-700',
  integer: 'bg-blue-100 text-blue-700',
};

function FieldTypeChip({ type }: { type: string }) {
  const baseType = type.toLowerCase().replace(/[^a-z]/g, '');
  const style = TYPE_BADGE[baseType] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${style}`}>{type}</span>
  );
}

export function LivingSchemaPreview({
  entityName = 'Entity',
  entityDescription,
  schemaType = 'entity',
  fields = [],
  relatedEntities = [],
}: LivingSchemaPreviewProps) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white shadow-sm"
      data-testid="living-schema-preview"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <span className="font-mono text-sm font-semibold text-slate-800">{entityName}</span>
        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 capitalize">
          {schemaType}
        </span>
      </div>

      {entityDescription && (
        <div className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
          {entityDescription}
        </div>
      )}

      {/* Fields table */}
      {fields.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Field</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Type</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fields.map((field) => (
                <tr key={field.name} className="hover:bg-slate-50/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-medium text-slate-700">{field.name}</span>
                      {field.required && (
                        <span className="text-red-400 text-xs" title="required">*</span>
                      )}
                      {field.references && (
                        <span className="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-500" title={`references ${field.references}`}>
                          → {field.references}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <FieldTypeChip type={field.type} />
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{field.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-xs text-slate-400">
          Waiting for schema fields…
        </div>
      )}

      {/* Related entities */}
      {relatedEntities.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="mb-2 text-xs font-medium text-slate-500">Related entities</div>
          <div className="flex flex-wrap gap-2">
            {relatedEntities.map((e) => (
              <span
                key={e.name}
                className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-600"
                title={e.description}
              >
                {e.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
