import { useState, useEffect } from 'react';
import { fetchStageGateRules, updateStageGateRules, type GateRule, type GateRuleType } from '../lib/api';

interface Stage {
  id: string;
  slug: string;
  label: string;
}

interface LifecycleGateRulesEditorProps {
  stages: Stage[];
}

const RULE_TYPE_LABELS: Record<GateRuleType, string> = {
  min_content_length: 'Minimum content length (characters)',
  min_word_count: 'Minimum word count',
  required_section: 'Required section heading',
};

function newRule(): GateRule {
  return {
    id: crypto.randomUUID(),
    type: 'min_word_count',
    label: '',
    value: 100,
  };
}

/**
 * LifecycleGateRulesEditor — lets admins view and manage the gate rules
 * that control which criteria must be met before a document can advance
 * to each lifecycle stage.
 */
export function LifecycleGateRulesEditor({ stages }: LifecycleGateRulesEditorProps) {
  const [selectedStageId, setSelectedStageId] = useState<string>(stages[0]?.id ?? '');
  const [rules, setRules] = useState<GateRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStageId) return;
    setLoading(true);
    setError(null);
    fetchStageGateRules(selectedStageId)
      .then((data) => setRules(data.rules))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load rules'))
      .finally(() => setLoading(false));
  }, [selectedStageId]);

  const handleSave = async () => {
    if (!selectedStageId) return;
    setSaving(true);
    setError(null);
    try {
      await updateStageGateRules(selectedStageId, rules);
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save rules');
    } finally {
      setSaving(false);
    }
  };

  const addRule = () => setRules((prev) => [...prev, newRule()]);

  const removeRule = (id: string) => setRules((prev) => prev.filter((r) => r.id !== id));

  const updateRule = (id: string, patch: Partial<GateRule>) =>
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const selectedStage = stages.find((s) => s.id === selectedStageId);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-slate-900">Stage Gate Rules</h3>
        <p className="mt-1 text-sm text-slate-500">
          Define requirements that documents must meet before they can advance to each stage.
          Rules are evaluated server-side when a user changes a document's stage.
        </p>
      </div>

      {/* Stage selector */}
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Select stage to configure</label>
        <select
          value={selectedStageId}
          onChange={(e) => setSelectedStageId(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2">
          {[1, 2].map((i) => <div key={i} className="h-14 rounded-lg bg-slate-100" />)}
        </div>
      ) : (
        <>
          {/* Rules list */}
          <div className="space-y-3">
            {rules.length === 0 && (
              <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
                No gate rules for <strong>{selectedStage?.label}</strong>. Add a rule to start enforcing entry criteria.
              </p>
            )}

            {rules.map((rule) => (
              <div key={rule.id} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex items-start gap-3">
                  {/* Rule type */}
                  <div className="flex-1">
                    <label className="block text-xs font-medium text-slate-600 mb-1">Rule type</label>
                    <select
                      value={rule.type}
                      onChange={(e) => updateRule(rule.id, { type: e.target.value as GateRuleType })}
                      className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm outline-none focus:border-blue-400"
                    >
                      {(Object.keys(RULE_TYPE_LABELS) as GateRuleType[]).map((t) => (
                        <option key={t} value={t}>{RULE_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                  </div>

                  {/* Delete */}
                  <button
                    type="button"
                    onClick={() => removeRule(rule.id)}
                    className="mt-5 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                    title="Remove rule"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                    </svg>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Label */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Display label</label>
                    <input
                      type="text"
                      value={rule.label}
                      onChange={(e) => updateRule(rule.id, { label: e.target.value })}
                      placeholder="e.g. Must have acceptance criteria"
                      className="w-full rounded-md border border-slate-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
                    />
                  </div>

                  {/* Value */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      {rule.type === 'required_section' ? 'Section heading text' : 'Threshold'}
                    </label>
                    <input
                      type={rule.type === 'required_section' ? 'text' : 'number'}
                      value={rule.value}
                      min={rule.type !== 'required_section' ? 1 : undefined}
                      onChange={(e) =>
                        updateRule(rule.id, {
                          value: rule.type === 'required_section' ? e.target.value : Number(e.target.value),
                        })
                      }
                      placeholder={rule.type === 'required_section' ? 'e.g. Acceptance Criteria' : '100'}
                      className="w-full rounded-md border border-slate-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Add rule */}
          <button
            type="button"
            onClick={addRule}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 py-2 text-sm font-medium text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add gate rule
          </button>

          {/* Error */}
          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* Save */}
          <div className="flex items-center justify-between">
            {savedAt && !saving && (
              <span className="text-xs text-green-600">
                Saved {savedAt.toLocaleTimeString()}
              </span>
            )}
            <div className="ml-auto">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : 'Save gate rules'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
