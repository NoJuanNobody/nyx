// Gatekeeper service: evaluates stage transition rules before allowing a document
// to advance to the next lifecycle stage. Rules are stored as a JSON array on
// each lifecycle_stage row (`gate_rules` column) and checked server-side.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, lifecycleStages, lifecycles } from '../db/schema.js';

// ── Types ────────────────────────────────────────────────────────────

export type GateRuleType = 'min_content_length' | 'min_word_count' | 'required_section';

export interface GateRule {
  /** Unique identifier for this rule within the stage */
  id: string;
  /** Rule type determines which check is performed */
  type: GateRuleType;
  /** Human-readable label shown in the UI checklist */
  label: string;
  /**
   * Type-specific value:
   * - min_content_length: minimum character count (number)
   * - min_word_count:     minimum word count (number)
   * - required_section:   section heading substring to match (string)
   */
  value: number | string;
}

export interface GateRuleResult extends GateRule {
  /** Whether this rule was satisfied */
  met: boolean;
  /** Human-readable explanation when the rule is NOT met */
  reason?: string;
}

export interface GateCheckResult {
  /** true only if every rule is met */
  passed: boolean;
  rules: GateRuleResult[];
}

// ── Rule evaluators ──────────────────────────────────────────────────

function evaluateRule(rule: GateRule, content: string): GateRuleResult {
  switch (rule.type) {
    case 'min_content_length': {
      const min = Number(rule.value);
      const met = content.length >= min;
      return {
        ...rule,
        met,
        reason: met
          ? undefined
          : `Must be at least ${min} characters long (currently ${content.length})`,
      };
    }
    case 'min_word_count': {
      const min = Number(rule.value);
      const count = content.trim() === '' ? 0 : content.trim().split(/\s+/).length;
      const met = count >= min;
      return {
        ...rule,
        met,
        reason: met
          ? undefined
          : `Must contain at least ${min} words (currently ${count})`,
      };
    }
    case 'required_section': {
      const pattern = String(rule.value);
      // Match any markdown heading (# … ######) that contains the pattern
      const met = new RegExp(`^#{1,6}\\s+.*${escapeRegExp(pattern)}`, 'mi').test(content);
      return {
        ...rule,
        met,
        reason: met
          ? undefined
          : `Must include a section heading containing "${pattern}"`,
      };
    }
    default:
      // Unknown rule types pass silently so future rule types don't block transitions
      return { ...rule, met: true };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Service ──────────────────────────────────────────────────────────

export const gatekeeperService = {
  /**
   * Evaluate all gate rules for a stage transition.
   *
   * @param documentId   - The document being advanced
   * @param targetSlug   - The slug of the stage the document is moving INTO
   * @param lifecycleId  - Optional lifecycle ID; falls back to the document's
   *                       lifecycle or the system default if omitted.
   */
  async evaluateGate(
    documentId: string,
    targetSlug: string,
    lifecycleId?: string | null,
  ): Promise<GateCheckResult> {
    // 1. Fetch the document to get its content and current lifecycle
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) return { passed: true, rules: [] };

    // 2. Resolve the lifecycle to search in
    let resolvedLifecycleId = lifecycleId ?? doc.lifecycleId ?? null;

    if (!resolvedLifecycleId) {
      const [defaultLc] = await db
        .select()
        .from(lifecycles)
        .where(eq(lifecycles.isDefault, true));
      resolvedLifecycleId = defaultLc?.id ?? null;
    }

    if (!resolvedLifecycleId) return { passed: true, rules: [] };

    // 3. Find the target stage
    const [targetStage] = await db
      .select()
      .from(lifecycleStages)
      .where(
        and(
          eq(lifecycleStages.lifecycleId, resolvedLifecycleId),
          eq(lifecycleStages.slug, targetSlug),
        ),
      );

    if (!targetStage) return { passed: true, rules: [] };

    const rules = (targetStage.gateRules as GateRule[]) ?? [];
    if (rules.length === 0) return { passed: true, rules: [] };

    // 4. Evaluate each rule against the document's current content
    const results = rules.map((rule) => evaluateRule(rule, doc.content ?? ''));

    return {
      passed: results.every((r) => r.met),
      rules: results,
    };
  },

  /**
   * Replace the gate rules for a specific lifecycle stage.
   */
  async setGateRules(stageId: string, rules: GateRule[]): Promise<void> {
    await db
      .update(lifecycleStages)
      .set({ gateRules: rules })
      .where(eq(lifecycleStages.id, stageId));
  },
};
