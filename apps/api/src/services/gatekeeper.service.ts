// Sprint gatekeeper service: enforces stage transition rules.
// Documents can only advance to the next pipeline stage when defined criteria are met.

/**
 * Default stage ordering used when a document has no lifecycle attached.
 * Matches the documentStageEnum defined in the schema.
 */
const DEFAULT_STAGE_ORDER = [
  'conception',
  'definition',
  'architecture',
  'implementation',
  'execution',
];

const MIN_CONTENT_LENGTH = 100;

export interface GateCheck {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
}

export const gatekeeperService = {
  /**
   * Evaluate whether a document is allowed to transition to `targetStage`.
   *
   * Checks enforced:
   * 1. Content must not be empty
   * 2. Content must meet minimum length (100 chars)
   * 3. Target stage must be a valid next stage (sequential order, no skipping)
   */
  evaluateGate(
    document: { content: string; stage: string | null },
    targetStage: string,
    stageOrder: string[] = DEFAULT_STAGE_ORDER,
  ): GateResult {
    const checks: GateCheck[] = [];

    // Check 1: content not empty
    const contentTrimmed = (document.content ?? '').trim();
    const contentNotEmpty = contentTrimmed.length > 0;
    checks.push({
      name: 'content_not_empty',
      passed: contentNotEmpty,
      ...(contentNotEmpty ? {} : { reason: 'Document content must not be empty' }),
    });

    // Check 2: minimum content length
    const meetsMinLength = contentTrimmed.length >= MIN_CONTENT_LENGTH;
    checks.push({
      name: 'minimum_content_length',
      passed: meetsMinLength,
      ...(meetsMinLength
        ? {}
        : {
            reason: `Document content must be at least ${MIN_CONTENT_LENGTH} characters (currently ${contentTrimmed.length})`,
          }),
    });

    // Check 3: valid stage transition order
    const currentIndex = document.stage ? stageOrder.indexOf(document.stage) : -1;
    const targetIndex = stageOrder.indexOf(targetStage);

    let validTransition: boolean;
    let transitionReason: string | undefined;

    if (targetIndex === -1) {
      validTransition = false;
      transitionReason = `Target stage "${targetStage}" is not a recognized stage`;
    } else if (document.stage === null) {
      // No current stage — allow transition to any valid stage (initial assignment)
      validTransition = true;
    } else if (currentIndex === -1) {
      // Current stage not in known order — allow any valid target
      validTransition = true;
    } else if (targetIndex <= currentIndex) {
      validTransition = false;
      transitionReason = `Cannot move backward from "${document.stage}" to "${targetStage}"`;
    } else if (targetIndex !== currentIndex + 1) {
      validTransition = false;
      transitionReason =
        `Cannot skip stages: must move from "${document.stage}" to "${stageOrder[currentIndex + 1]}", not "${targetStage}"`;
    } else {
      validTransition = true;
    }

    checks.push({
      name: 'valid_stage_transition',
      passed: validTransition,
      ...(validTransition ? {} : { reason: transitionReason }),
    });

    return {
      passed: checks.every((c) => c.passed),
      checks,
    };
  },
};
