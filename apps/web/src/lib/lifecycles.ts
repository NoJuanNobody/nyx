/**
 * Multi-lifecycle registry.
 *
 * Each lifecycle defines a pipeline of stages with rich display metadata.
 * The `software_development` lifecycle is registered as the default and
 * mirrors the original 5-stage pipeline.
 */

export interface StageInfo {
  id: string;
  label: string;
  abbreviation: string;
  subtitle: string;
  color: string;
  textColor: string;
  dotColor: string;
  borderColor: string;
  hex: string;
  who: string;
  description: string;
  icon: string;
  ai: string;
  output: string;
  docs: string[];
}

export interface LifecycleType {
  slug: string;
  label: string;
  description: string;
  icon: string;
  stages: StageInfo[];
  connectors: string[];
  suggestions: Record<string, string[]>;
}

// ── Registry ──────────────────────────────────────────────────────

export const LIFECYCLES = new Map<string, LifecycleType>();

// ── Default: Software Development ─────────────────────────────────

LIFECYCLES.set('software_development', {
  slug: 'software_development',
  label: 'Software Development',
  description: 'Full software product lifecycle from idea to deployed code',
  icon: '◎',
  stages: [
    {
      id: 'conception',
      label: 'Conception',
      abbreviation: 'CO',
      subtitle: 'Idea & Vision',
      color: 'bg-amber-100',
      textColor: 'text-amber-700',
      dotColor: 'bg-amber-400',
      borderColor: 'border-amber-300',
      hex: '#E8C547',
      who: 'Product Managers, Founders',
      description: 'Capture the initial idea, problem space, and vision',
      icon: '◎',
      ai: 'Stress-tests your idea, identifies blind spots, suggests missing angles',
      output: 'Validated concept brief ready for product definition',
      docs: ['Problem Statement', 'Value Proposition', 'Market Opportunity', 'Rough Concept Notes'],
    },
    {
      id: 'definition',
      label: 'Definition',
      abbreviation: 'DF',
      subtitle: 'Product Spec',
      color: 'bg-teal-100',
      textColor: 'text-teal-700',
      dotColor: 'bg-teal-400',
      borderColor: 'border-teal-300',
      hex: '#4EC9B0',
      who: 'Product Managers, Designers',
      description: 'Translate the idea into a complete product specification',
      icon: '◈',
      ai: 'Flags ambiguous requirements, generates user stories from PRD, scores completeness',
      output: 'Structured PRD that engineering can trust',
      docs: ['Product Requirements Doc (PRD)', 'User Stories', 'Personas', 'Feature List', 'Competitive Analysis'],
    },
    {
      id: 'architecture',
      label: 'Architecture',
      abbreviation: 'AR',
      subtitle: 'System Design',
      color: 'bg-indigo-100',
      textColor: 'text-indigo-700',
      dotColor: 'bg-indigo-400',
      borderColor: 'border-indigo-300',
      hex: '#7B9FE0',
      who: 'Tech Leads, Senior Engineers',
      description: 'Design the system that implements the specification',
      icon: '◫',
      ai: 'Reviews architecture for gaps, suggests patterns, links decisions back to PRD intent',
      output: 'Architecture docs linked to every PRD requirement they serve',
      docs: ['System Architecture Doc', 'Data Models', 'API Contracts', 'Component Hierarchy', 'Tech Stack Decisions'],
    },
    {
      id: 'implementation',
      label: 'Implementation',
      abbreviation: 'IM',
      subtitle: 'Dev Specs',
      color: 'bg-violet-100',
      textColor: 'text-violet-700',
      dotColor: 'bg-violet-400',
      borderColor: 'border-violet-300',
      hex: '#C084FC',
      who: 'Engineers, QA',
      description: 'Create developer-ready specifications for AI coding agents',
      icon: '◧',
      ai: 'Scores spec quality for AI code generation, auto-generates tickets, suggests edge cases',
      output: 'Implementation-ready specs optimized for Claude Code & Copilot',
      docs: ['AI-Ready Feature Specs', 'Ticket Breakdowns', 'Acceptance Criteria', 'Edge Cases', 'Test Plans'],
    },
    {
      id: 'execution',
      label: 'Execution',
      abbreviation: 'EX',
      subtitle: 'Code & Sync',
      color: 'bg-emerald-100',
      textColor: 'text-emerald-700',
      dotColor: 'bg-emerald-400',
      borderColor: 'border-emerald-300',
      hex: '#F87171',
      who: 'Engineers, DevOps',
      description: 'Track the living codebase and keep docs in sync',
      icon: '◉',
      ai: 'Watches commits, detects doc-code drift in real time, flags intent violations',
      output: 'Codebase that never diverges silently from its original intent',
      docs: ['Living Codebase', 'Auto-Updated Docs', 'Drift Alerts', 'Change History', 'Rollback Points'],
    },
  ],
  connectors: [
    'Concept brief seeds the PRD',
    'PRD requirements drive architecture',
    'Architecture shapes implementation specs',
    'Specs generate code via AI agents',
  ],
  suggestions: {
    conception: ['Stress-test this idea', 'Identify blind spots', 'Suggest target user personas'],
    definition: ['Generate user stories', 'Flag ambiguous requirements', 'Suggest success metrics'],
    architecture: ['Review for gaps', 'Link back to PRD', 'Identify scalability concerns'],
    implementation: ['Score AI-readiness', 'Generate ticket breakdown', 'Add edge cases'],
    execution: ['Check for drift', 'Summarize changes', 'Generate release notes'],
  },
});

// ── #157: Scientific Writing ──────────────────────────────────────

LIFECYCLES.set('scientific_writing', {
  slug: 'scientific_writing',
  label: 'Scientific Writing',
  description: 'Research-to-publication pipeline for academic and scientific papers',
  icon: '🔬',
  stages: [
    { id: 'research_notes', label: 'Research Notes', abbreviation: 'RN', subtitle: 'Data & Observations', color: 'bg-sky-100', textColor: 'text-sky-700', dotColor: 'bg-sky-400', borderColor: 'border-sky-300', hex: '#38BDF8', who: 'Researchers, Lab Teams', description: 'Collect raw data, observations, and preliminary findings', icon: '📝', ai: 'Identifies patterns in raw data, suggests hypotheses, flags missing controls', output: 'Organized research notes with tagged observations', docs: ['Lab Notebook', 'Data Logs', 'Observation Notes', 'Hypothesis Draft'] },
    { id: 'literature_review', label: 'Literature Review', abbreviation: 'LR', subtitle: 'Prior Work', color: 'bg-cyan-100', textColor: 'text-cyan-700', dotColor: 'bg-cyan-400', borderColor: 'border-cyan-300', hex: '#22D3EE', who: 'Researchers, Academics', description: 'Survey existing literature and establish theoretical framework', icon: '📚', ai: 'Identifies citation gaps, suggests related papers, checks for conflicting findings', output: 'Comprehensive literature review with citation map', docs: ['Literature Survey', 'Citation Matrix', 'Gap Analysis', 'Theoretical Framework'] },
    { id: 'draft_sections', label: 'Draft Sections', abbreviation: 'DS', subtitle: 'First Draft', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#60A5FA', who: 'Lead Author, Co-authors', description: 'Write initial manuscript sections: intro, methods, results, discussion', icon: '✍️', ai: 'Checks logical flow, suggests clearer phrasing, flags unsupported claims', output: 'Complete first draft of all manuscript sections', docs: ['Introduction', 'Methods', 'Results', 'Discussion', 'Abstract'] },
    { id: 'peer_review', label: 'Peer Review', abbreviation: 'PR', subtitle: 'External Feedback', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A78BFA', who: 'Peer Reviewers, Advisors', description: 'Submit for internal or external peer review and collect feedback', icon: '👥', ai: 'Simulates reviewer concerns, identifies weak arguments, suggests preemptive clarifications', output: 'Annotated feedback from peer reviewers', docs: ['Reviewer Comments', 'Response Plan', 'Strength/Weakness Analysis'] },
    { id: 'revisions', label: 'Revisions', abbreviation: 'RV', subtitle: 'Refinement', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#FB923C', who: 'Lead Author', description: 'Address reviewer feedback and refine the manuscript', icon: '🔄', ai: 'Tracks changes against reviewer comments, ensures all feedback is addressed', output: 'Revised manuscript with point-by-point response to reviewers', docs: ['Revision Tracker', 'Response to Reviewers', 'Change Log'] },
    { id: 'final_paper', label: 'Final Paper', abbreviation: 'FP', subtitle: 'Publication Ready', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#4ADE80', who: 'Lead Author, Journal Editor', description: 'Finalize formatting, references, and submit to journal', icon: '📄', ai: 'Checks journal formatting requirements, validates references, generates submission checklist', output: 'Publication-ready manuscript with all supplementary materials', docs: ['Final Manuscript', 'Supplementary Materials', 'Cover Letter', 'Submission Checklist'] },
  ],
  connectors: ['Research findings inform the literature review', 'Literature review frames the draft', 'Draft goes through peer review', 'Review feedback drives revisions', 'Revisions produce the final paper'],
  suggestions: {
    research_notes: ['Organize observations', 'Identify patterns', 'Suggest controls'],
    literature_review: ['Find related papers', 'Identify gaps', 'Build citation map'],
    draft_sections: ['Check logical flow', 'Strengthen arguments', 'Clarify methods'],
    peer_review: ['Anticipate reviewer concerns', 'Identify weak points', 'Suggest preemptive edits'],
    revisions: ['Track changes', 'Verify all feedback addressed', 'Strengthen weak sections'],
    final_paper: ['Check formatting', 'Validate references', 'Generate submission checklist'],
  },
});

// ── #158: Hardware Design ─────────────────────────────────────────

LIFECYCLES.set('hardware_design', {
  slug: 'hardware_design',
  label: 'Hardware Design',
  description: 'Electronic and mechanical hardware from schematic to manufacturing',
  icon: '🔧',
  stages: [
    { id: 'schematic_design', label: 'Schematic Design', abbreviation: 'SD', subtitle: 'Circuit Design', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#F87171', who: 'Electrical Engineers', description: 'Design circuit schematics and select components', icon: '⚡', ai: 'Validates component compatibility, suggests alternatives, checks for design rule violations', output: 'Complete schematic with BOM', docs: ['Schematic Diagram', 'Bill of Materials', 'Component Selection Rationale', 'Design Constraints'] },
    { id: 'pcb_layout', label: 'PCB Layout', abbreviation: 'PL', subtitle: 'Board Design', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#FB923C', who: 'PCB Designers, Layout Engineers', description: 'Translate schematic into physical PCB layout', icon: '🖥️', ai: 'Checks trace routing rules, thermal analysis, signal integrity concerns', output: 'Gerber-ready PCB layout files', docs: ['PCB Layout', 'Layer Stack-up', 'Design Rule Check Report', 'Thermal Analysis'] },
    { id: 'prototyping', label: 'Prototyping', abbreviation: 'PT', subtitle: 'Build & Verify', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#FACC15', who: 'Hardware Engineers, Technicians', description: 'Build physical prototypes and verify basic functionality', icon: '🔨', ai: 'Generates test procedures, identifies common assembly issues, tracks prototype iterations', output: 'Working prototype with assembly notes', docs: ['Assembly Instructions', 'Prototype Log', 'Initial Test Results', 'Issue Tracker'] },
    { id: 'testing', label: 'Testing', abbreviation: 'TS', subtitle: 'Validation', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Test Engineers, QA', description: 'Run comprehensive tests: functional, environmental, compliance', icon: '🧪', ai: 'Suggests test cases, identifies edge conditions, compares results to specifications', output: 'Complete test report with pass/fail summary', docs: ['Test Plan', 'Test Results', 'Compliance Report', 'Failure Analysis'] },
    { id: 'manufacturing_prep', label: 'Manufacturing Prep', abbreviation: 'MP', subtitle: 'Production Ready', color: 'bg-teal-100', textColor: 'text-teal-700', dotColor: 'bg-teal-400', borderColor: 'border-teal-300', hex: '#2DD4BF', who: 'Manufacturing Engineers, Procurement', description: 'Prepare documentation and processes for mass production', icon: '🏭', ai: 'Reviews DFM, identifies cost optimization opportunities, validates production documents', output: 'Manufacturing package ready for production line', docs: ['Manufacturing Plan', 'DFM Report', 'Quality Control Plan', 'Supply Chain Setup'] },
    { id: 'final_specs', label: 'Final Specs', abbreviation: 'FS', subtitle: 'Release Package', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#34D399', who: 'Engineering Lead, Product Owner', description: 'Compile final specifications and release documentation', icon: '📋', ai: 'Cross-references all specs for consistency, generates compliance matrix', output: 'Complete product specification package', docs: ['Final Specifications', 'Datasheet', 'Certification Docs', 'Release Notes'] },
  ],
  connectors: ['Schematic drives the PCB layout', 'Layout becomes the prototype', 'Prototype goes through testing', 'Test results inform manufacturing prep', 'Prep produces final specifications'],
  suggestions: {
    schematic_design: ['Check component availability', 'Validate power budget', 'Review design constraints'],
    pcb_layout: ['Check trace widths', 'Verify thermal design', 'Run DRC'],
    prototyping: ['Generate test procedure', 'Track assembly issues', 'Document deviations'],
    testing: ['Suggest edge cases', 'Compare to spec', 'Identify failure modes'],
    manufacturing_prep: ['Review DFM', 'Optimize BOM cost', 'Check supply chain'],
    final_specs: ['Cross-reference specs', 'Generate compliance matrix', 'Validate completeness'],
  },
});

// ── #159: Creative Writing ────────────────────────────────────────

LIFECYCLES.set('creative_writing', {
  slug: 'creative_writing',
  label: 'Creative Writing',
  description: 'Fiction and non-fiction writing from outline to publication',
  icon: '✒️',
  stages: [
    { id: 'outline', label: 'Outline', abbreviation: 'OL', subtitle: 'Story Structure', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Author', description: 'Create story outline, character profiles, and plot structure', icon: '📋', ai: 'Suggests plot structures, identifies pacing issues, proposes character arcs', output: 'Detailed outline with character sheets and plot beats', docs: ['Story Outline', 'Character Profiles', 'Plot Structure', 'World-Building Notes'] },
    { id: 'first_draft', label: 'First Draft', abbreviation: 'FD', subtitle: 'Raw Writing', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Author', description: 'Write the complete first draft without heavy self-editing', icon: '✍️', ai: 'Maintains voice consistency, flags plot holes, tracks continuity', output: 'Complete first draft manuscript', docs: ['Manuscript Draft', 'Chapter Notes', 'Continuity Tracker'] },
    { id: 'revision_passes', label: 'Revision Passes', abbreviation: 'RP', subtitle: 'Self-Editing', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Author', description: 'Perform structural and line-level revisions', icon: '🔄', ai: 'Identifies weak passages, suggests tightening, checks pacing and tension', output: 'Revised manuscript with tracked changes', docs: ['Revision Notes', 'Structural Changes', 'Line Edit Log'] },
    { id: 'feedback_integration', label: 'Feedback Integration', abbreviation: 'FI', subtitle: 'Beta Readers', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#FB7185', who: 'Author, Beta Readers, Editor', description: 'Incorporate feedback from beta readers and editors', icon: '💬', ai: 'Synthesizes feedback themes, prioritizes changes, suggests compromises', output: 'Manuscript incorporating external feedback', docs: ['Beta Reader Feedback', 'Editor Notes', 'Change Priority List'] },
    { id: 'final_polish', label: 'Final Polish', abbreviation: 'FP', subtitle: 'Copyediting', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Author, Copyeditor', description: 'Final copyediting, proofreading, and formatting', icon: '✨', ai: 'Catches typos, checks grammar, ensures style consistency', output: 'Clean, polished manuscript', docs: ['Copyedit Pass', 'Style Guide Compliance', 'Final Proofread'] },
    { id: 'publication_ready', label: 'Publication Ready', abbreviation: 'PB', subtitle: 'Ship It', color: 'bg-fuchsia-100', textColor: 'text-fuchsia-700', dotColor: 'bg-fuchsia-400', borderColor: 'border-fuchsia-300', hex: '#D946EF', who: 'Author, Publisher', description: 'Final manuscript ready for publication or submission', icon: '📚', ai: 'Generates query letter, synopsis, checks submission requirements', output: 'Submission-ready manuscript package', docs: ['Final Manuscript', 'Query Letter', 'Synopsis', 'Author Bio'] },
  ],
  connectors: ['Outline guides the first draft', 'First draft goes through revisions', 'Revisions incorporate feedback', 'Feedback drives final polish', 'Polish produces publication-ready work'],
  suggestions: {
    outline: ['Strengthen plot structure', 'Develop character arcs', 'Check pacing'],
    first_draft: ['Maintain voice', 'Flag plot holes', 'Track continuity'],
    revision_passes: ['Identify weak passages', 'Tighten prose', 'Check tension'],
    feedback_integration: ['Synthesize feedback', 'Prioritize changes', 'Resolve conflicts'],
    final_polish: ['Check grammar', 'Ensure consistency', 'Final proofread'],
    publication_ready: ['Generate synopsis', 'Check submission requirements', 'Review query letter'],
  },
});

// ── #160: Marketing Copy ──────────────────────────────────────────

LIFECYCLES.set('marketing_copy', {
  slug: 'marketing_copy',
  label: 'Marketing Copy',
  description: 'Marketing content from brief to live deployment with A/B testing',
  icon: '📣',
  stages: [
    { id: 'brief_strategy', label: 'Brief & Strategy', abbreviation: 'BS', subtitle: 'Campaign Plan', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Marketing Managers, Strategists', description: 'Define campaign objectives, target audience, and messaging strategy', icon: '🎯', ai: 'Analyzes audience segments, suggests positioning, identifies competitive messaging gaps', output: 'Complete creative brief with messaging framework', docs: ['Creative Brief', 'Audience Personas', 'Messaging Framework', 'Competitive Positioning'] },
    { id: 'draft_variations', label: 'Draft Variations', abbreviation: 'DV', subtitle: 'Copy Options', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Copywriters, Content Team', description: 'Write multiple copy variations for testing', icon: '✍️', ai: 'Generates headline variants, suggests CTAs, checks tone alignment with brand voice', output: 'Multiple copy variations per channel', docs: ['Headline Variations', 'Body Copy Drafts', 'CTA Options', 'Channel Adaptations'] },
    { id: 'ab_testing', label: 'A/B Testing Data', abbreviation: 'AB', subtitle: 'Performance Data', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Growth Team, Analysts', description: 'Run A/B tests and collect performance data', icon: '📊', ai: 'Analyzes test results, identifies statistical significance, recommends winners', output: 'Test results with performance analysis', docs: ['Test Setup', 'Performance Metrics', 'Statistical Analysis', 'Winner Recommendation'] },
    { id: 'refinement', label: 'Refinement', abbreviation: 'RF', subtitle: 'Optimization', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Copywriters, Marketing Lead', description: 'Refine winning copy based on test data and stakeholder feedback', icon: '🔧', ai: 'Suggests copy improvements based on data, maintains brand consistency across channels', output: 'Optimized copy for all channels', docs: ['Refined Copy', 'Stakeholder Feedback', 'Channel-Specific Versions'] },
    { id: 'final_version', label: 'Final Version', abbreviation: 'FV', subtitle: 'Approved Copy', color: 'bg-fuchsia-100', textColor: 'text-fuchsia-700', dotColor: 'bg-fuchsia-400', borderColor: 'border-fuchsia-300', hex: '#D946EF', who: 'Marketing Lead, Legal', description: 'Final approval and legal review of all copy', icon: '✅', ai: 'Checks legal compliance, brand guidelines adherence, accessibility', output: 'Approved final copy with sign-offs', docs: ['Approved Copy', 'Legal Review', 'Brand Compliance Check', 'Approval Chain'] },
    { id: 'live', label: 'Live', abbreviation: 'LV', subtitle: 'Deployed', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Marketing Ops, DevOps', description: 'Deploy copy to live channels and monitor performance', icon: '🚀', ai: 'Monitors live performance, suggests real-time optimizations, flags underperforming variants', output: 'Live copy with performance dashboard', docs: ['Deployment Log', 'Performance Dashboard', 'Optimization Notes', 'Post-Launch Report'] },
  ],
  connectors: ['Brief shapes the draft variations', 'Variations feed A/B testing', 'Test data drives refinement', 'Refinement produces final version', 'Final version goes live'],
  suggestions: {
    brief_strategy: ['Define target audience', 'Analyze competition', 'Set campaign goals'],
    draft_variations: ['Generate headline options', 'Vary CTAs', 'Adapt for channels'],
    ab_testing: ['Analyze significance', 'Identify winners', 'Spot patterns'],
    refinement: ['Apply test learnings', 'Check brand voice', 'Optimize CTAs'],
    final_version: ['Check legal compliance', 'Verify brand guidelines', 'Review accessibility'],
    live: ['Monitor performance', 'Suggest optimizations', 'Flag issues'],
  },
});

// ── #161: Journalism ──────────────────────────────────────────────

LIFECYCLES.set('journalism', {
  slug: 'journalism',
  label: 'Journalism',
  description: 'News and investigative journalism from pitch to publication',
  icon: '📰',
  stages: [
    { id: 'story_pitch', label: 'Story Pitch', abbreviation: 'SP', subtitle: 'Story Idea', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Reporter, Editor', description: 'Develop and pitch the story idea with angle and sources', icon: '💡', ai: 'Evaluates newsworthiness, suggests angles, identifies source types needed', output: 'Approved story pitch with source plan', docs: ['Story Pitch', 'Source List', 'Angle Analysis', 'Timeline Estimate'] },
    { id: 'research_reporting', label: 'Research & Reporting', abbreviation: 'RR', subtitle: 'Investigation', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Reporter, Researcher', description: 'Conduct interviews, gather data, and verify facts', icon: '🔍', ai: 'Identifies public records, suggests interview questions, fact-checks claims', output: 'Complete research file with verified facts', docs: ['Interview Notes', 'Data Files', 'Fact-Check Log', 'Source Verification'] },
    { id: 'draft_article', label: 'Draft Article', abbreviation: 'DA', subtitle: 'Writing', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Reporter', description: 'Write the article with proper structure and attribution', icon: '✍️', ai: 'Checks structure, suggests leads, ensures proper attribution', output: 'Complete article draft with sourcing', docs: ['Article Draft', 'Source Attribution', 'Supporting Data'] },
    { id: 'editorial_review', label: 'Editorial Review', abbreviation: 'ER', subtitle: 'Editor Feedback', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Editor, Copy Editor', description: 'Editorial review for accuracy, clarity, and editorial standards', icon: '📝', ai: 'Checks AP style, identifies potential legal issues, suggests headline options', output: 'Edited article with editorial notes', docs: ['Editor Markup', 'Legal Review Notes', 'Headline Options'] },
    { id: 'revisions', label: 'Revisions', abbreviation: 'RV', subtitle: 'Final Edits', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#F43F5E', who: 'Reporter, Editor', description: 'Address editorial feedback and finalize the article', icon: '🔄', ai: 'Tracks changes, verifies all editorial notes addressed, final fact-check', output: 'Revised article ready for publication', docs: ['Revision Log', 'Final Fact-Check', 'Updated Draft'] },
    { id: 'published', label: 'Published', abbreviation: 'PB', subtitle: 'Live Story', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Editor, Digital Team', description: 'Publish the article and monitor reader engagement', icon: '📢', ai: 'Generates social media snippets, suggests follow-up angles, monitors engagement', output: 'Published article with distribution plan', docs: ['Published Article', 'Social Media Plan', 'Engagement Metrics', 'Follow-up Ideas'] },
  ],
  connectors: ['Pitch guides research & reporting', 'Reporting produces the draft', 'Draft goes through editorial review', 'Review drives revisions', 'Revisions lead to publication'],
  suggestions: {
    story_pitch: ['Evaluate newsworthiness', 'Suggest angles', 'Identify sources'],
    research_reporting: ['Find public records', 'Suggest interview questions', 'Fact-check claims'],
    draft_article: ['Check structure', 'Suggest lead', 'Verify attribution'],
    editorial_review: ['Check AP style', 'Flag legal issues', 'Suggest headlines'],
    revisions: ['Track changes', 'Final fact-check', 'Verify completeness'],
    published: ['Generate social snippets', 'Suggest follow-ups', 'Monitor engagement'],
  },
});

// ── #162: Academic Curricula ──────────────────────────────────────

LIFECYCLES.set('academic_curricula', {
  slug: 'academic_curricula',
  label: 'Academic Curricula',
  description: 'Curriculum development from learning objectives to final program',
  icon: '🎓',
  stages: [
    { id: 'learning_objectives', label: 'Learning Objectives', abbreviation: 'LO', subtitle: 'Goals & Outcomes', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Curriculum Designer, Subject Experts', description: 'Define learning objectives and measurable outcomes', icon: '🎯', ai: 'Checks Bloom\'s taxonomy alignment, suggests measurable outcomes, identifies prerequisites', output: 'Complete learning objectives with alignment matrix', docs: ['Learning Objectives', 'Bloom\'s Taxonomy Map', 'Prerequisite Analysis', 'Outcome Metrics'] },
    { id: 'content_outline', label: 'Content Outline', abbreviation: 'CO', subtitle: 'Course Structure', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Curriculum Designer', description: 'Create detailed content outline organized by modules and lessons', icon: '📋', ai: 'Suggests logical sequencing, identifies content gaps, estimates time allocations', output: 'Detailed course outline with module structure', docs: ['Course Outline', 'Module Breakdown', 'Time Allocation', 'Resource List'] },
    { id: 'lesson_materials', label: 'Lesson Materials', abbreviation: 'LM', subtitle: 'Content Creation', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Content Developers, Instructors', description: 'Develop lesson plans, slides, readings, and activities', icon: '📖', ai: 'Suggests engaging activities, checks reading level, generates discussion prompts', output: 'Complete lesson materials for all modules', docs: ['Lesson Plans', 'Slides', 'Reading Materials', 'Activity Guides', 'Discussion Prompts'] },
    { id: 'assessments', label: 'Assessments', abbreviation: 'AS', subtitle: 'Evaluation Tools', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Assessment Designers, Instructors', description: 'Create quizzes, exams, rubrics, and project assessments', icon: '📝', ai: 'Aligns assessments to objectives, suggests question types, validates rubric criteria', output: 'Complete assessment suite with rubrics', docs: ['Quiz Bank', 'Exam Templates', 'Rubrics', 'Project Briefs', 'Assessment Map'] },
    { id: 'pilot_testing', label: 'Pilot Testing', abbreviation: 'PT', subtitle: 'Trial Run', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Pilot Instructors, Students', description: 'Run the curriculum with a pilot group and collect feedback', icon: '🧪', ai: 'Analyzes student performance data, identifies confusing sections, suggests improvements', output: 'Pilot results with improvement recommendations', docs: ['Pilot Feedback', 'Student Performance Data', 'Instructor Notes', 'Improvement Plan'] },
    { id: 'final_curriculum', label: 'Final Curriculum', abbreviation: 'FC', subtitle: 'Approved Program', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Department Head, Academic Board', description: 'Finalize and approve the complete curriculum package', icon: '🏫', ai: 'Generates curriculum summary, checks accreditation requirements, creates instructor guide', output: 'Approved curriculum ready for implementation', docs: ['Final Curriculum', 'Instructor Guide', 'Student Handbook', 'Accreditation Docs'] },
  ],
  connectors: ['Objectives shape the content outline', 'Outline drives lesson materials', 'Materials inform assessments', 'Assessments are validated through pilot testing', 'Pilot results finalize the curriculum'],
  suggestions: {
    learning_objectives: ['Check Bloom\'s alignment', 'Define measurable outcomes', 'Identify prerequisites'],
    content_outline: ['Suggest module sequence', 'Identify content gaps', 'Estimate time'],
    lesson_materials: ['Suggest activities', 'Check reading level', 'Generate prompts'],
    assessments: ['Align to objectives', 'Suggest question types', 'Validate rubrics'],
    pilot_testing: ['Analyze performance data', 'Identify pain points', 'Suggest fixes'],
    final_curriculum: ['Generate summary', 'Check accreditation', 'Create instructor guide'],
  },
});

// ── #163: Financial Reports ───────────────────────────────────────

LIFECYCLES.set('financial_reports', {
  slug: 'financial_reports',
  label: 'Financial Reports',
  description: 'Financial reporting from data collection to regulatory filing',
  icon: '💰',
  stages: [
    { id: 'data_collection', label: 'Data Collection', abbreviation: 'DC', subtitle: 'Raw Financial Data', color: 'bg-slate-100', textColor: 'text-slate-700', dotColor: 'bg-slate-400', borderColor: 'border-slate-300', hex: '#64748B', who: 'Accountants, Data Analysts', description: 'Collect and reconcile financial data from all sources', icon: '📊', ai: 'Identifies data anomalies, flags reconciliation issues, suggests missing data sources', output: 'Reconciled financial dataset', docs: ['Data Sources', 'Reconciliation Report', 'Anomaly Log', 'Data Quality Assessment'] },
    { id: 'analysis_framework', label: 'Analysis Framework', abbreviation: 'AF', subtitle: 'Analytical Structure', color: 'bg-zinc-100', textColor: 'text-zinc-700', dotColor: 'bg-zinc-400', borderColor: 'border-zinc-300', hex: '#71717A', who: 'Financial Analysts, Controllers', description: 'Define analysis framework, KPIs, and comparison periods', icon: '📐', ai: 'Suggests relevant KPIs, identifies trends, recommends comparison frameworks', output: 'Analysis framework with KPI definitions', docs: ['KPI Definitions', 'Analysis Plan', 'Comparison Framework', 'Benchmark Data'] },
    { id: 'draft_report', label: 'Draft Report', abbreviation: 'DR', subtitle: 'Initial Report', color: 'bg-neutral-100', textColor: 'text-neutral-700', dotColor: 'bg-neutral-400', borderColor: 'border-neutral-300', hex: '#A3A3A3', who: 'Financial Analysts, Report Writers', description: 'Draft the financial report with narrative and visualizations', icon: '📝', ai: 'Generates narrative from data, suggests visualizations, checks calculation accuracy', output: 'Complete draft report with charts and commentary', docs: ['Draft Report', 'Financial Statements', 'Charts & Graphs', 'Management Commentary'] },
    { id: 'audit_review', label: 'Audit Review', abbreviation: 'AR', subtitle: 'Verification', color: 'bg-stone-100', textColor: 'text-stone-700', dotColor: 'bg-stone-400', borderColor: 'border-stone-300', hex: '#A8A29E', who: 'Internal Audit, External Auditors', description: 'Internal and external audit review of the report', icon: '🔍', ai: 'Cross-references figures, identifies material misstatements, checks GAAP/IFRS compliance', output: 'Audit report with findings', docs: ['Audit Findings', 'Compliance Check', 'Material Adjustments', 'Auditor Notes'] },
    { id: 'revisions', label: 'Revisions', abbreviation: 'RV', subtitle: 'Corrections', color: 'bg-gray-100', textColor: 'text-gray-700', dotColor: 'bg-gray-400', borderColor: 'border-gray-300', hex: '#9CA3AF', who: 'Financial Analysts, Controllers', description: 'Address audit findings and make necessary corrections', icon: '🔄', ai: 'Tracks adjustments, ensures all findings addressed, recalculates affected figures', output: 'Corrected report with adjustment log', docs: ['Adjustment Log', 'Revised Statements', 'Response to Audit', 'Recalculation Notes'] },
    { id: 'final_filing', label: 'Final Filing', abbreviation: 'FF', subtitle: 'Submitted', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'CFO, Compliance Officer', description: 'Final approval and regulatory filing', icon: '📋', ai: 'Checks filing requirements, validates formatting, generates filing checklist', output: 'Filed financial report with confirmation', docs: ['Final Report', 'Filing Confirmation', 'Board Approval', 'Compliance Certificate'] },
  ],
  connectors: ['Data collection feeds the analysis framework', 'Framework structures the draft report', 'Draft goes through audit review', 'Audit findings drive revisions', 'Revisions produce the final filing'],
  suggestions: {
    data_collection: ['Identify anomalies', 'Check reconciliation', 'Validate sources'],
    analysis_framework: ['Suggest KPIs', 'Identify trends', 'Set benchmarks'],
    draft_report: ['Generate narrative', 'Suggest visualizations', 'Check calculations'],
    audit_review: ['Cross-reference figures', 'Check compliance', 'Flag issues'],
    revisions: ['Track adjustments', 'Verify corrections', 'Recalculate totals'],
    final_filing: ['Check filing requirements', 'Validate format', 'Generate checklist'],
  },
});

// ── #164: Real Estate Listings ────────────────────────────────────

LIFECYCLES.set('real_estate_listings', {
  slug: 'real_estate_listings',
  label: 'Real Estate Listings',
  description: 'Property listing from intake to live market listing',
  icon: '🏠',
  stages: [
    { id: 'property_intake', label: 'Property Intake', abbreviation: 'PI', subtitle: 'Initial Info', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Listing Agent', description: 'Gather property details, owner information, and listing agreement', icon: '📋', ai: 'Identifies missing property details, suggests comparable properties, estimates listing timeline', output: 'Complete property intake package', docs: ['Property Details', 'Listing Agreement', 'Owner Info', 'Initial Assessment'] },
    { id: 'photos_description', label: 'Photos & Description', abbreviation: 'PD', subtitle: 'Visual Assets', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Photographer, Copywriter', description: 'Professional photography, virtual tours, and property description', icon: '📸', ai: 'Writes compelling property descriptions, suggests photo angles, highlights unique features', output: 'Professional photos and property description', docs: ['Photo Gallery', 'Virtual Tour', 'Property Description', 'Feature Highlights'] },
    { id: 'market_analysis', label: 'Market Analysis', abbreviation: 'MA', subtitle: 'Pricing Strategy', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Listing Agent, Appraiser', description: 'Analyze comparable sales and determine pricing strategy', icon: '📊', ai: 'Pulls comparable sales data, analyzes market trends, suggests pricing strategy', output: 'CMA report with pricing recommendation', docs: ['Comparative Market Analysis', 'Pricing Strategy', 'Market Trends', 'Comparable Sales'] },
    { id: 'listing_draft', label: 'Listing Draft', abbreviation: 'LD', subtitle: 'MLS Entry', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Listing Agent', description: 'Draft the MLS listing with all required fields and descriptions', icon: '📝', ai: 'Optimizes MLS fields, checks for required disclosures, enhances searchability', output: 'Complete MLS listing draft', docs: ['MLS Draft', 'Disclosure Forms', 'Marketing Plan', 'Showing Instructions'] },
    { id: 'approval', label: 'Approval', abbreviation: 'AP', subtitle: 'Owner Sign-off', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'Property Owner, Listing Agent', description: 'Owner reviews and approves all listing materials', icon: '✅', ai: 'Generates review summary for owner, highlights key selling points, confirms accuracy', output: 'Approved listing ready for market', docs: ['Owner Approval', 'Final Review Checklist', 'Marketing Materials Approval'] },
    { id: 'live_listing', label: 'Live Listing', abbreviation: 'LL', subtitle: 'On Market', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Listing Agent, Marketing Team', description: 'Listing goes live on MLS and marketing channels', icon: '🏡', ai: 'Monitors market response, suggests price adjustments, tracks showings and feedback', output: 'Active listing with marketing distribution', docs: ['Live Listing', 'Marketing Distribution', 'Showing Feedback', 'Market Response'] },
  ],
  connectors: ['Property intake guides photos & description', 'Description informs market analysis', 'Analysis shapes the listing draft', 'Draft requires owner approval', 'Approval puts the listing live'],
  suggestions: {
    property_intake: ['Check missing details', 'Suggest comparables', 'Estimate timeline'],
    photos_description: ['Write description', 'Highlight features', 'Suggest angles'],
    market_analysis: ['Pull comparable sales', 'Analyze trends', 'Suggest pricing'],
    listing_draft: ['Optimize MLS fields', 'Check disclosures', 'Enhance searchability'],
    approval: ['Generate review summary', 'Confirm accuracy', 'Highlight key points'],
    live_listing: ['Monitor response', 'Suggest adjustments', 'Track showings'],
  },
});

// ── #165: Pharma Documentation ────────────────────────────────────

LIFECYCLES.set('pharma_documentation', {
  slug: 'pharma_documentation',
  label: 'Pharma Documentation',
  description: 'Pharmaceutical regulatory documentation from protocol to submission',
  icon: '💊',
  stages: [
    { id: 'protocol_design', label: 'Protocol Design', abbreviation: 'PD', subtitle: 'Study Protocol', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Clinical Scientists, Medical Affairs', description: 'Design clinical study protocol with endpoints and methodology', icon: '🔬', ai: 'Reviews protocol design, suggests endpoints, identifies regulatory requirements', output: 'Complete study protocol with statistical analysis plan', docs: ['Study Protocol', 'Statistical Analysis Plan', 'Endpoint Definitions', 'Inclusion/Exclusion Criteria'] },
    { id: 'safety_data', label: 'Safety Data', abbreviation: 'SD', subtitle: 'Safety Profile', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Pharmacovigilance, Safety Scientists', description: 'Compile and analyze safety data from preclinical and clinical studies', icon: '🛡️', ai: 'Identifies safety signals, categorizes adverse events, generates safety narratives', output: 'Comprehensive safety data package', docs: ['Safety Summary', 'Adverse Event Tables', 'Signal Detection Report', 'Preclinical Safety'] },
    { id: 'efficacy_results', label: 'Efficacy Results', abbreviation: 'ER', subtitle: 'Clinical Results', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'Biostatisticians, Clinical Scientists', description: 'Analyze and present efficacy results from clinical trials', icon: '📈', ai: 'Validates statistical methods, generates result summaries, checks for data integrity', output: 'Complete efficacy results with statistical analysis', docs: ['Efficacy Summary', 'Statistical Tables', 'Figures & Graphs', 'Subgroup Analyses'] },
    { id: 'regulatory_draft', label: 'Regulatory Draft', abbreviation: 'RD', subtitle: 'Submission Docs', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Regulatory Writers, Medical Writers', description: 'Draft regulatory submission documents (CTD modules)', icon: '📋', ai: 'Checks CTD structure, ensures cross-referencing, validates regulatory terminology', output: 'Complete regulatory document draft', docs: ['Module 2 Summary', 'Clinical Overview', 'Nonclinical Overview', 'Quality Summary'] },
    { id: 'compliance_review', label: 'Compliance Review', abbreviation: 'CR', subtitle: 'QC & Review', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Quality Assurance, Regulatory Affairs', description: 'Quality control review and compliance verification', icon: '🔍', ai: 'Cross-checks data consistency, validates GCP compliance, flags discrepancies', output: 'QC-approved documents with compliance certification', docs: ['QC Report', 'Compliance Checklist', 'Discrepancy Log', 'Sign-off Matrix'] },
    { id: 'submission_ready', label: 'Submission Ready', abbreviation: 'SR', subtitle: 'Filed', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Regulatory Affairs Lead', description: 'Final submission package assembly and filing', icon: '📤', ai: 'Validates submission completeness, generates cover letters, checks eCTD technical requirements', output: 'Submission-ready regulatory package', docs: ['Submission Package', 'Cover Letter', 'eCTD Validation', 'Filing Confirmation'] },
  ],
  connectors: ['Protocol design structures safety data collection', 'Safety data complements efficacy results', 'Results feed the regulatory draft', 'Draft undergoes compliance review', 'Review produces submission-ready package'],
  suggestions: {
    protocol_design: ['Review endpoints', 'Check regulatory requirements', 'Validate methodology'],
    safety_data: ['Identify safety signals', 'Categorize adverse events', 'Generate narratives'],
    efficacy_results: ['Validate statistics', 'Generate summaries', 'Check data integrity'],
    regulatory_draft: ['Check CTD structure', 'Validate cross-references', 'Review terminology'],
    compliance_review: ['Cross-check data', 'Validate GCP compliance', 'Flag discrepancies'],
    submission_ready: ['Check completeness', 'Generate cover letter', 'Validate eCTD'],
  },
});

// ── #166: HR Policies ─────────────────────────────────────────────

LIFECYCLES.set('hr_policies', {
  slug: 'hr_policies',
  label: 'HR Policies',
  description: 'Human resources policy development from concept to published policy',
  icon: '👥',
  stages: [
    { id: 'policy_concept', label: 'Policy Concept', abbreviation: 'PC', subtitle: 'Need Assessment', color: 'bg-sky-100', textColor: 'text-sky-700', dotColor: 'bg-sky-400', borderColor: 'border-sky-300', hex: '#38BDF8', who: 'HR Director, Policy Analysts', description: 'Identify policy need and define objectives', icon: '💡', ai: 'Benchmarks against industry standards, identifies regulatory requirements, suggests scope', output: 'Policy concept brief with regulatory context', docs: ['Policy Brief', 'Regulatory Requirements', 'Industry Benchmarks', 'Impact Assessment'] },
    { id: 'stakeholder_input', label: 'Stakeholder Input', abbreviation: 'SI', subtitle: 'Consultation', color: 'bg-cyan-100', textColor: 'text-cyan-700', dotColor: 'bg-cyan-400', borderColor: 'border-cyan-300', hex: '#22D3EE', who: 'HR Team, Department Heads, Employees', description: 'Gather input from affected stakeholders', icon: '🗣️', ai: 'Synthesizes feedback themes, identifies conflicting interests, suggests compromises', output: 'Stakeholder input summary with recommendations', docs: ['Feedback Summary', 'Stakeholder Map', 'Conflicting Interests Analysis', 'Recommendation Report'] },
    { id: 'draft_policy', label: 'Draft Policy', abbreviation: 'DP', subtitle: 'Initial Draft', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'HR Policy Writers', description: 'Draft the policy document with clear language and procedures', icon: '📝', ai: 'Checks for clarity and consistency, suggests plain language alternatives, ensures completeness', output: 'Complete policy draft with procedures', docs: ['Policy Draft', 'Procedures', 'FAQ', 'Exception Handling'] },
    { id: 'legal_review', label: 'Legal Review', abbreviation: 'LR', subtitle: 'Compliance Check', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Legal Counsel, Compliance Team', description: 'Legal review for regulatory compliance and risk mitigation', icon: '⚖️', ai: 'Checks against labor laws, identifies liability exposure, suggests protective language', output: 'Legally reviewed policy with compliance sign-off', docs: ['Legal Review', 'Compliance Checklist', 'Risk Assessment', 'Recommended Changes'] },
    { id: 'employee_feedback', label: 'Employee Feedback', abbreviation: 'EF', subtitle: 'Comment Period', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Employees, HR Representatives', description: 'Open comment period for employee feedback on the policy', icon: '💬', ai: 'Analyzes feedback sentiment, categorizes concerns, suggests policy adjustments', output: 'Employee feedback summary with policy adjustments', docs: ['Employee Comments', 'Sentiment Analysis', 'Adjustment Recommendations', 'Response Plan'] },
    { id: 'published_policy', label: 'Published Policy', abbreviation: 'PP', subtitle: 'Active Policy', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'HR Director, Executive Team', description: 'Final approval, publication, and employee communication', icon: '📢', ai: 'Generates employee communications, creates training materials, sets review schedule', output: 'Published policy with rollout plan', docs: ['Final Policy', 'Employee Communication', 'Training Materials', 'Review Schedule'] },
  ],
  connectors: ['Policy concept shapes stakeholder input', 'Input informs the draft policy', 'Draft goes through legal review', 'Legal review precedes employee feedback', 'Feedback finalizes the published policy'],
  suggestions: {
    policy_concept: ['Benchmark industry standards', 'Identify regulations', 'Assess impact'],
    stakeholder_input: ['Synthesize feedback', 'Identify conflicts', 'Suggest compromises'],
    draft_policy: ['Check clarity', 'Ensure completeness', 'Suggest plain language'],
    legal_review: ['Check labor laws', 'Identify liability', 'Suggest protective language'],
    employee_feedback: ['Analyze sentiment', 'Categorize concerns', 'Suggest adjustments'],
    published_policy: ['Generate communications', 'Create training materials', 'Set review schedule'],
  },
});

// ── #167: Contract Law ────────────────────────────────────────────

LIFECYCLES.set('contract_law', {
  slug: 'contract_law',
  label: 'Contract Law',
  description: 'Legal contract lifecycle from requirements to executed agreement',
  icon: '⚖️',
  stages: [
    { id: 'requirements_scope', label: 'Requirements & Scope', abbreviation: 'RS', subtitle: 'Deal Terms', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Business Owner, Legal Lead', description: 'Define contract requirements, key terms, and scope', icon: '📋', ai: 'Identifies missing terms, suggests standard clauses, benchmarks against similar agreements', output: 'Complete requirements document with term sheet', docs: ['Requirements Doc', 'Term Sheet', 'Scope Definition', 'Risk Profile'] },
    { id: 'draft_agreement', label: 'Draft Agreement', abbreviation: 'DA', subtitle: 'Initial Draft', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Legal Counsel, Contract Drafters', description: 'Draft the complete agreement with all clauses and schedules', icon: '📝', ai: 'Generates clause language, checks for internal consistency, suggests protective provisions', output: 'Complete contract draft with exhibits', docs: ['Contract Draft', 'Schedules & Exhibits', 'Definitions Section', 'Boilerplate Clauses'] },
    { id: 'stakeholder_review', label: 'Stakeholder Review', abbreviation: 'SR', subtitle: 'Internal Review', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Business Stakeholders, Finance, Ops', description: 'Internal stakeholder review of business and operational terms', icon: '👥', ai: 'Summarizes business impact, identifies operational concerns, flags unusual provisions', output: 'Stakeholder-reviewed draft with comments', docs: ['Review Comments', 'Business Impact Analysis', 'Operational Assessment', 'Sign-off Sheet'] },
    { id: 'legal_revision', label: 'Legal Revision', abbreviation: 'LV', subtitle: 'Redlining', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Legal Counsel', description: 'Incorporate stakeholder feedback and prepare for counterparty review', icon: '🔴', ai: 'Tracks all changes, ensures legal consistency, prepares redline comparison', output: 'Revised draft with tracked changes', docs: ['Redlined Draft', 'Change Summary', 'Issue Resolution Log', 'Outstanding Items'] },
    { id: 'negotiation_rounds', label: 'Negotiation Rounds', abbreviation: 'NR', subtitle: 'Counterparty Talks', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#F43F5E', who: 'Legal Teams (Both Parties)', description: 'Exchange drafts with counterparty, negotiate terms', icon: '🤝', ai: 'Analyzes counterparty redlines, suggests compromises, tracks negotiation progress', output: 'Negotiated agreement acceptable to both parties', docs: ['Counterparty Redline', 'Negotiation Log', 'Compromise Proposals', 'Open Issues'] },
    { id: 'final_executed', label: 'Final Executed', abbreviation: 'FE', subtitle: 'Signed Contract', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Authorized Signatories', description: 'Final agreement execution with signatures and delivery', icon: '✍️', ai: 'Generates execution checklist, verifies all conditions precedent, creates obligation tracker', output: 'Fully executed agreement with obligation tracking', docs: ['Executed Agreement', 'Signature Page', 'Obligation Tracker', 'Key Dates Calendar'] },
  ],
  connectors: ['Requirements shape the draft agreement', 'Draft goes through stakeholder review', 'Review drives legal revision', 'Revision enables negotiation rounds', 'Negotiation produces the final executed contract'],
  suggestions: {
    requirements_scope: ['Identify missing terms', 'Suggest standard clauses', 'Assess risks'],
    draft_agreement: ['Generate clause language', 'Check consistency', 'Add protective provisions'],
    stakeholder_review: ['Summarize business impact', 'Flag unusual provisions', 'Track approvals'],
    legal_revision: ['Track all changes', 'Prepare redline', 'Resolve issues'],
    negotiation_rounds: ['Analyze counterparty changes', 'Suggest compromises', 'Track progress'],
    final_executed: ['Generate execution checklist', 'Verify conditions', 'Create obligation tracker'],
  },
});

// ── #168: Architectural Design ────────────────────────────────────

LIFECYCLES.set('architectural_design', {
  slug: 'architectural_design',
  label: 'Architectural Design',
  description: 'Building and space design from concept to construction-ready documents',
  icon: '🏗️',
  stages: [
    { id: 'concept_sketch', label: 'Concept Sketch', abbreviation: 'CS', subtitle: 'Design Vision', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Architect, Client', description: 'Develop initial design concepts and sketches', icon: '✏️', ai: 'Suggests design approaches, identifies site constraints, generates mood boards', output: 'Approved concept sketches with design direction', docs: ['Concept Sketches', 'Site Analysis', 'Design Brief', 'Mood Board', 'Precedent Studies'] },
    { id: 'detailed_drawings', label: 'Detailed Drawings', abbreviation: 'DD', subtitle: 'Technical Drawings', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Architect, Drafters', description: 'Create detailed architectural drawings and plans', icon: '📐', ai: 'Checks building code compliance, suggests structural solutions, validates dimensions', output: 'Complete architectural drawing set', docs: ['Floor Plans', 'Elevations', 'Sections', 'Detail Drawings', 'Site Plan'] },
    { id: 'materials_spec', label: 'Materials Spec', abbreviation: 'MS', subtitle: 'Material Selection', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Architect, Interior Designer', description: 'Select and specify all materials and finishes', icon: '🧱', ai: 'Suggests material alternatives, checks sustainability ratings, estimates lead times', output: 'Complete material specification document', docs: ['Material Schedule', 'Finish Schedule', 'Sustainability Report', 'Product Specifications'] },
    { id: 'cost_analysis', label: 'Cost Analysis', abbreviation: 'CA', subtitle: 'Budget Estimate', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Quantity Surveyor, Architect', description: 'Prepare detailed cost estimates and budget analysis', icon: '💲', ai: 'Generates cost estimates, identifies value engineering opportunities, compares to budget', output: 'Detailed cost estimate with budget comparison', docs: ['Cost Estimate', 'Budget Analysis', 'Value Engineering Options', 'Cash Flow Projection'] },
    { id: 'contractor_review', label: 'Contractor Review', abbreviation: 'CR', subtitle: 'Builder Feedback', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'General Contractor, Subcontractors', description: 'Contractor review for constructability and practical issues', icon: '🏗️', ai: 'Identifies constructability issues, suggests sequencing, flags coordination needs', output: 'Contractor-reviewed plans with RFI responses', docs: ['Contractor Comments', 'RFI Log', 'Constructability Review', 'Coordination Issues'] },
    { id: 'construction_ready', label: 'Construction Ready', abbreviation: 'CX', subtitle: 'Permit Set', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Architect, Owner', description: 'Final construction documents ready for permitting and building', icon: '🏛️', ai: 'Validates permit requirements, generates submission checklist, creates construction timeline', output: 'Construction-ready document set', docs: ['Construction Documents', 'Permit Application', 'Project Schedule', 'Contract Documents'] },
  ],
  connectors: ['Concept sketches guide detailed drawings', 'Drawings inform materials specification', 'Materials feed cost analysis', 'Cost analysis goes through contractor review', 'Review produces construction-ready documents'],
  suggestions: {
    concept_sketch: ['Suggest design approaches', 'Analyze site constraints', 'Generate mood board'],
    detailed_drawings: ['Check building codes', 'Validate dimensions', 'Suggest structural solutions'],
    materials_spec: ['Suggest alternatives', 'Check sustainability', 'Estimate lead times'],
    cost_analysis: ['Generate estimates', 'Find VE opportunities', 'Compare to budget'],
    contractor_review: ['Identify constructability issues', 'Suggest sequencing', 'Flag coordination'],
    construction_ready: ['Validate permit requirements', 'Generate checklist', 'Create timeline'],
  },
});

// ── #169: Music Production ────────────────────────────────────────

LIFECYCLES.set('music_production', {
  slug: 'music_production',
  label: 'Music Production',
  description: 'Music creation from composition to distribution-ready master',
  icon: '🎵',
  stages: [
    { id: 'composition_arrangement', label: 'Composition & Arrangement', abbreviation: 'CA', subtitle: 'Songwriting', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Songwriter, Composer, Arranger', description: 'Write and arrange the musical composition', icon: '🎼', ai: 'Suggests chord progressions, identifies arrangement gaps, checks song structure', output: 'Complete arrangement with lead sheets', docs: ['Lead Sheet', 'Arrangement Notes', 'Chord Chart', 'Lyrics', 'Reference Tracks'] },
    { id: 'recording_sessions', label: 'Recording Sessions', abbreviation: 'RS', subtitle: 'Tracking', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Musicians, Recording Engineer', description: 'Record all tracks in the studio or remotely', icon: '🎙️', ai: 'Suggests microphone placement, identifies performance issues, tracks session progress', output: 'Complete multitrack recording', docs: ['Session Log', 'Track List', 'Performance Notes', 'Technical Settings'] },
    { id: 'mixing_draft', label: 'Mixing Draft', abbreviation: 'MD', subtitle: 'Initial Mix', color: 'bg-fuchsia-100', textColor: 'text-fuchsia-700', dotColor: 'bg-fuchsia-400', borderColor: 'border-fuchsia-300', hex: '#D946EF', who: 'Mixing Engineer', description: 'Create the initial mix with levels, panning, EQ, and effects', icon: '🎚️', ai: 'Analyzes frequency balance, suggests EQ adjustments, identifies phase issues', output: 'Draft mix for review', docs: ['Mix Notes', 'Plugin Chain', 'Revision Requests', 'Reference Comparison'] },
    { id: 'mastering_notes', label: 'Mastering Notes', abbreviation: 'MN', subtitle: 'Final Polish', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Mastering Engineer', description: 'Prepare mastering notes and specifications', icon: '📊', ai: 'Analyzes loudness levels, checks format requirements, suggests mastering approach', output: 'Mastering specifications and notes', docs: ['Mastering Specs', 'Loudness Analysis', 'Format Requirements', 'Mastering Notes'] },
    { id: 'final_mix', label: 'Final Mix', abbreviation: 'FM', subtitle: 'Approved Master', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#F43F5E', who: 'Artist, Producer, Mastering Engineer', description: 'Final approved mix and master', icon: '✅', ai: 'Final quality check, cross-platform playback analysis, metadata validation', output: 'Approved final master', docs: ['Final Master', 'Approval Notes', 'Quality Check Report', 'Metadata'] },
    { id: 'distribution_ready', label: 'Distribution Ready', abbreviation: 'DR', subtitle: 'Release Package', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Artist, Label, Distributor', description: 'Complete release package with metadata and artwork', icon: '📦', ai: 'Validates ISRC codes, checks platform requirements, generates release timeline', output: 'Distribution-ready release package', docs: ['Release Package', 'ISRC Registration', 'Artwork & Credits', 'Distribution Plan', 'Marketing Brief'] },
  ],
  connectors: ['Composition guides recording sessions', 'Recordings become the mixing draft', 'Mix informs mastering notes', 'Mastering produces the final mix', 'Final mix becomes distribution-ready'],
  suggestions: {
    composition_arrangement: ['Suggest chord progressions', 'Check song structure', 'Identify arrangement gaps'],
    recording_sessions: ['Track session progress', 'Note performance issues', 'Log technical settings'],
    mixing_draft: ['Analyze frequency balance', 'Suggest EQ adjustments', 'Check phase'],
    mastering_notes: ['Analyze loudness', 'Check format requirements', 'Suggest approach'],
    final_mix: ['Quality check', 'Cross-platform analysis', 'Validate metadata'],
    distribution_ready: ['Validate ISRC codes', 'Check platform requirements', 'Create timeline'],
  },
});

// ── #170: Educational Textbooks ───────────────────────────────────

LIFECYCLES.set('educational_textbooks', {
  slug: 'educational_textbooks',
  label: 'Educational Textbooks',
  description: 'Textbook development from outline to publication-ready manuscript',
  icon: '📖',
  stages: [
    { id: 'outline_structure', label: 'Outline & Structure', abbreviation: 'OS', subtitle: 'Book Plan', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Author, Publisher', description: 'Create detailed table of contents and chapter outlines', icon: '📋', ai: 'Suggests logical chapter sequencing, identifies coverage gaps, checks against standards', output: 'Approved book outline with chapter structure', docs: ['Table of Contents', 'Chapter Outlines', 'Learning Standards Map', 'Scope & Sequence'] },
    { id: 'chapter_drafts', label: 'Chapter Drafts', abbreviation: 'CD', subtitle: 'Content Writing', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Author, Contributors', description: 'Write complete chapter drafts with examples and exercises', icon: '✍️', ai: 'Checks reading level, suggests examples, generates practice problems', output: 'Complete chapter manuscripts', docs: ['Chapter Drafts', 'Examples', 'Practice Problems', 'Key Terms', 'Chapter Summaries'] },
    { id: 'subject_matter_review', label: 'Subject Matter Review', abbreviation: 'SM', subtitle: 'Expert Review', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Subject Matter Experts, Reviewers', description: 'Expert review for accuracy, completeness, and pedagogy', icon: '🔍', ai: 'Identifies factual errors, suggests additional topics, evaluates pedagogical approach', output: 'Expert review report with recommendations', docs: ['Review Comments', 'Accuracy Check', 'Pedagogy Assessment', 'Content Gaps'] },
    { id: 'copyediting_pass', label: 'Copyediting Pass', abbreviation: 'CE', subtitle: 'Editorial Review', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Copyeditors', description: 'Thorough copyediting for grammar, style, and consistency', icon: '📝', ai: 'Checks grammar, enforces style guide, ensures terminology consistency', output: 'Copyedited manuscript', docs: ['Copyedit Markup', 'Style Guide Queries', 'Consistency Check', 'Author Queries'] },
    { id: 'illustrations_layout', label: 'Illustrations & Layout', abbreviation: 'IL', subtitle: 'Visual Design', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Illustrators, Designers, Typesetters', description: 'Create illustrations, diagrams, and page layout', icon: '🎨', ai: 'Suggests diagram types, checks accessibility of visuals, validates figure references', output: 'Complete illustrated and typeset manuscript', docs: ['Illustrations', 'Diagrams', 'Page Proofs', 'Figure Captions', 'Layout Specifications'] },
    { id: 'publication_ready', label: 'Publication Ready', abbreviation: 'PB', subtitle: 'Print Ready', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Publisher, Production Manager', description: 'Final proofread, index generation, and production files', icon: '📚', ai: 'Generates index, validates cross-references, checks print specifications', output: 'Publication-ready manuscript files', docs: ['Final Manuscript', 'Index', 'Print Specifications', 'Digital Formats', 'Errata Sheet'] },
  ],
  connectors: ['Outline structures the chapter drafts', 'Drafts go through subject matter review', 'Review precedes copyediting pass', 'Editing leads to illustrations & layout', 'Layout produces publication-ready files'],
  suggestions: {
    outline_structure: ['Check standard alignment', 'Suggest sequencing', 'Identify gaps'],
    chapter_drafts: ['Check reading level', 'Suggest examples', 'Generate problems'],
    subject_matter_review: ['Check accuracy', 'Evaluate pedagogy', 'Suggest additions'],
    copyediting_pass: ['Check grammar', 'Enforce style guide', 'Ensure consistency'],
    illustrations_layout: ['Suggest diagram types', 'Check accessibility', 'Validate references'],
    publication_ready: ['Generate index', 'Validate cross-references', 'Check print specs'],
  },
});

// ── #171: Marketing Campaigns ─────────────────────────────────────

LIFECYCLES.set('marketing_campaigns', {
  slug: 'marketing_campaigns',
  label: 'Marketing Campaigns',
  description: 'Full marketing campaign from strategy to launch',
  icon: '📢',
  stages: [
    { id: 'strategy_brief', label: 'Strategy & Creative Brief', abbreviation: 'SB', subtitle: 'Campaign Plan', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Marketing Director, Strategy Team', description: 'Define campaign strategy, objectives, and creative direction', icon: '🎯', ai: 'Analyzes market opportunity, suggests campaign themes, defines KPIs', output: 'Complete campaign strategy and creative brief', docs: ['Campaign Strategy', 'Creative Brief', 'Target Audience', 'Budget Allocation', 'KPI Framework'] },
    { id: 'asset_drafts', label: 'Asset Drafts', abbreviation: 'AD', subtitle: 'Content Creation', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Creative Team, Designers, Copywriters', description: 'Create draft campaign assets across all channels', icon: '🎨', ai: 'Checks brand consistency, suggests visual treatments, generates copy variations', output: 'Draft assets for all campaign channels', docs: ['Visual Assets', 'Copy Drafts', 'Video Scripts', 'Social Media Content', 'Email Templates'] },
    { id: 'stakeholder_feedback', label: 'Stakeholder Feedback', abbreviation: 'SF', subtitle: 'Internal Review', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Stakeholders, Product Team, Legal', description: 'Collect and consolidate stakeholder feedback on assets', icon: '💬', ai: 'Synthesizes feedback, identifies contradictions, prioritizes changes', output: 'Consolidated feedback with action items', docs: ['Feedback Summary', 'Action Items', 'Legal Review', 'Approval Status'] },
    { id: 'refinements', label: 'Refinements', abbreviation: 'RF', subtitle: 'Final Edits', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Creative Team', description: 'Refine assets based on feedback and finalize creative', icon: '🔧', ai: 'Tracks feedback implementation, checks final quality, ensures channel specifications met', output: 'Refined campaign assets', docs: ['Updated Assets', 'Revision Log', 'Quality Check', 'Channel Specs'] },
    { id: 'final_assets', label: 'Final Assets', abbreviation: 'FA', subtitle: 'Approved Creative', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Marketing Director, Legal', description: 'Final approval of all campaign assets and materials', icon: '✅', ai: 'Validates all specifications, checks legal compliance, generates asset inventory', output: 'Approved final campaign assets', docs: ['Final Assets', 'Asset Inventory', 'Legal Sign-off', 'Distribution Matrix'] },
    { id: 'launch_ready', label: 'Launch Ready', abbreviation: 'LR', subtitle: 'Go Live', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Campaign Manager, Ops Team', description: 'Campaign launch with scheduled distribution and monitoring', icon: '🚀', ai: 'Creates launch checklist, schedules distribution, sets up monitoring dashboards', output: 'Launched campaign with active monitoring', docs: ['Launch Checklist', 'Distribution Schedule', 'Monitoring Dashboard', 'Post-Launch Report'] },
  ],
  connectors: ['Strategy brief drives asset drafts', 'Drafts go through stakeholder feedback', 'Feedback drives refinements', 'Refinements produce final assets', 'Final assets go to launch'],
  suggestions: {
    strategy_brief: ['Analyze market opportunity', 'Define KPIs', 'Suggest themes'],
    asset_drafts: ['Check brand consistency', 'Generate variations', 'Adapt for channels'],
    stakeholder_feedback: ['Synthesize feedback', 'Prioritize changes', 'Track approvals'],
    refinements: ['Track implementation', 'Check quality', 'Verify specifications'],
    final_assets: ['Validate specs', 'Check compliance', 'Generate inventory'],
    launch_ready: ['Create launch checklist', 'Schedule distribution', 'Set up monitoring'],
  },
});

// ── #172: Game Design ─────────────────────────────────────────────

LIFECYCLES.set('game_design', {
  slug: 'game_design',
  label: 'Game Design',
  description: 'Game development from design document to release candidate',
  icon: '🎮',
  stages: [
    { id: 'design_document', label: 'Design Document', abbreviation: 'GD', subtitle: 'Game Vision', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Game Designer, Creative Director', description: 'Write the comprehensive game design document', icon: '📋', ai: 'Identifies design inconsistencies, suggests mechanics, analyzes player motivation loops', output: 'Complete game design document', docs: ['Game Design Document', 'Core Mechanics', 'Narrative Outline', 'Art Direction', 'Target Audience'] },
    { id: 'mechanics_prototype', label: 'Mechanics Prototype', abbreviation: 'MP', subtitle: 'Core Gameplay', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Gameplay Programmers, Designers', description: 'Build and test core game mechanics prototypes', icon: '⚙️', ai: 'Analyzes game feel, suggests balance adjustments, identifies fun factor issues', output: 'Playable mechanics prototype', docs: ['Prototype Build', 'Mechanics Documentation', 'Balance Spreadsheet', 'Play Session Notes'] },
    { id: 'level_design', label: 'Level Design', abbreviation: 'LD', subtitle: 'Content & Levels', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Level Designers, Environment Artists', description: 'Design levels, encounters, and progression systems', icon: '🗺️', ai: 'Analyzes difficulty curves, suggests pacing improvements, checks progression balance', output: 'Complete level designs with documentation', docs: ['Level Layouts', 'Encounter Design', 'Progression System', 'Difficulty Curve', 'Collectible Placement'] },
    { id: 'playtesting_feedback', label: 'Playtesting Feedback', abbreviation: 'PF', subtitle: 'Player Testing', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'QA, Playtesters, Community', description: 'Conduct playtests and collect player feedback', icon: '🎯', ai: 'Analyzes playtest data, identifies friction points, suggests UX improvements', output: 'Playtest report with actionable findings', docs: ['Playtest Report', 'Player Feedback', 'Bug Reports', 'Heatmaps', 'Session Recordings'] },
    { id: 'polish_pass', label: 'Polish Pass', abbreviation: 'PP', subtitle: 'Final Polish', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'Full Team', description: 'Bug fixes, visual polish, audio polish, and optimization', icon: '✨', ai: 'Prioritizes bug fixes, suggests visual improvements, identifies performance bottlenecks', output: 'Polished build ready for certification', docs: ['Bug Fix Log', 'Polish List', 'Performance Report', 'Audio Mix Notes', 'Visual Polish'] },
    { id: 'release_candidate', label: 'Release Candidate', abbreviation: 'RC', subtitle: 'Ship It', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Producer, QA Lead', description: 'Release candidate build for final certification and distribution', icon: '🏆', ai: 'Generates release notes, validates platform requirements, creates day-one patch list', output: 'Certified release candidate', docs: ['Release Candidate', 'Certification Checklist', 'Release Notes', 'Day-One Patch', 'Marketing Materials'] },
  ],
  connectors: ['Design document guides the mechanics prototype', 'Prototype informs level design', 'Levels go through playtesting', 'Playtest feedback drives polish pass', 'Polish produces the release candidate'],
  suggestions: {
    design_document: ['Check design consistency', 'Suggest mechanics', 'Analyze player loops'],
    mechanics_prototype: ['Analyze game feel', 'Suggest balance', 'Identify fun factor'],
    level_design: ['Analyze difficulty curve', 'Suggest pacing', 'Check progression'],
    playtesting_feedback: ['Analyze playtest data', 'Identify friction', 'Suggest UX fixes'],
    polish_pass: ['Prioritize bugs', 'Suggest visual improvements', 'Check performance'],
    release_candidate: ['Generate release notes', 'Validate platform requirements', 'Create patch list'],
  },
});

// ── #173: Video Production ────────────────────────────────────────

LIFECYCLES.set('video_production', {
  slug: 'video_production',
  label: 'Video Production',
  description: 'Video content from script to final delivery',
  icon: '🎬',
  stages: [
    { id: 'script_treatment', label: 'Script & Treatment', abbreviation: 'ST', subtitle: 'Concept & Script', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Writer, Director, Producer', description: 'Write the script, treatment, and creative brief', icon: '📝', ai: 'Suggests story structure, identifies pacing issues, generates shot list from script', output: 'Approved script and treatment', docs: ['Script', 'Treatment', 'Creative Brief', 'Character Breakdown', 'Location List'] },
    { id: 'storyboard', label: 'Storyboard', abbreviation: 'SB', subtitle: 'Visual Planning', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Storyboard Artist, Director', description: 'Create visual storyboard from the approved script', icon: '🎞️', ai: 'Suggests camera angles, identifies visual continuity issues, estimates shot timing', output: 'Complete storyboard with shot descriptions', docs: ['Storyboard Panels', 'Shot List', 'Camera Notes', 'Timing Estimates'] },
    { id: 'production_notes', label: 'Production Notes', abbreviation: 'PN', subtitle: 'Pre-Production', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Producer, Line Producer, AD', description: 'Create production schedule, call sheets, and logistics', icon: '📋', ai: 'Generates production schedule, identifies logistical conflicts, estimates budget per scene', output: 'Complete pre-production package', docs: ['Production Schedule', 'Call Sheets', 'Budget Breakdown', 'Equipment List', 'Crew List'] },
    { id: 'rough_cut', label: 'Rough Cut', abbreviation: 'RC', subtitle: 'First Edit', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Editor, Director', description: 'Assemble the rough cut from filmed footage', icon: '🎬', ai: 'Analyzes pacing, suggests alternate takes, identifies missing coverage', output: 'Rough cut for review', docs: ['Rough Cut', 'Edit Decision List', 'Missing Coverage Notes', 'Music Temp Track'] },
    { id: 'color_sound', label: 'Color & Sound', abbreviation: 'CS', subtitle: 'Post-Production', color: 'bg-teal-100', textColor: 'text-teal-700', dotColor: 'bg-teal-400', borderColor: 'border-teal-300', hex: '#2DD4BF', who: 'Colorist, Sound Designer, Mixer', description: 'Color grading, sound design, and audio mixing', icon: '🎨', ai: 'Analyzes color consistency, checks audio levels, suggests sound design elements', output: 'Color-graded and sound-mixed version', docs: ['Color Grade Notes', 'Sound Design', 'Audio Mix', 'VFX Shots', 'Music Cues'] },
    { id: 'final_delivery', label: 'Final Delivery', abbreviation: 'FD', subtitle: 'Deliverables', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Post Supervisor, Producer', description: 'Final deliverables in all required formats', icon: '📦', ai: 'Validates delivery specs, generates QC report, creates deliverable manifest', output: 'Complete delivery package', docs: ['Final Master', 'Delivery Manifest', 'QC Report', 'Closed Captions', 'Promotional Materials'] },
  ],
  connectors: ['Script drives the storyboard', 'Storyboard informs production notes', 'Production produces the rough cut', 'Rough cut gets color & sound', 'Color & sound produce the final delivery'],
  suggestions: {
    script_treatment: ['Suggest story structure', 'Identify pacing issues', 'Generate shot list'],
    storyboard: ['Suggest camera angles', 'Check visual continuity', 'Estimate timing'],
    production_notes: ['Generate schedule', 'Identify conflicts', 'Estimate budget'],
    rough_cut: ['Analyze pacing', 'Suggest alternate takes', 'Identify missing coverage'],
    color_sound: ['Check color consistency', 'Analyze audio levels', 'Suggest sound design'],
    final_delivery: ['Validate delivery specs', 'Generate QC report', 'Create manifest'],
  },
});

// ── #174: Graphic Design ──────────────────────────────────────────

LIFECYCLES.set('graphic_design', {
  slug: 'graphic_design',
  label: 'Graphic Design',
  description: 'Graphic design projects from brief to final deliverables',
  icon: '🎨',
  stages: [
    { id: 'brief_direction', label: 'Brief & Creative Direction', abbreviation: 'BD', subtitle: 'Project Brief', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Client, Art Director', description: 'Define the design brief and creative direction', icon: '🎯', ai: 'Suggests visual styles, identifies brand constraints, creates mood boards', output: 'Approved creative brief with direction', docs: ['Creative Brief', 'Mood Board', 'Brand Guidelines', 'Project Scope', 'Reference Gallery'] },
    { id: 'concept_sketches', label: 'Concept Sketches', abbreviation: 'CS', subtitle: 'Initial Concepts', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Designer', description: 'Create initial concept sketches and design explorations', icon: '✏️', ai: 'Suggests composition approaches, checks visual hierarchy, identifies typography options', output: 'Multiple concept directions for review', docs: ['Concept Sketches', 'Design Explorations', 'Typography Study', 'Color Palettes'] },
    { id: 'design_iterations', label: 'Design Iterations', abbreviation: 'DI', subtitle: 'Refinement', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Designer', description: 'Develop selected concepts into detailed design iterations', icon: '🔄', ai: 'Checks accessibility, validates color contrast, suggests layout improvements', output: 'Detailed design iterations', docs: ['Design Iterations', 'Layout Variations', 'Color System', 'Component Library'] },
    { id: 'client_feedback', label: 'Client Feedback', abbreviation: 'CF', subtitle: 'Client Review', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Client, Stakeholders', description: 'Present designs to client and collect structured feedback', icon: '💬', ai: 'Organizes feedback by theme, identifies conflicting input, suggests design compromises', output: 'Client feedback with clear action items', docs: ['Client Feedback', 'Presentation Deck', 'Action Items', 'Priority Matrix'] },
    { id: 'refinements', label: 'Refinements', abbreviation: 'RF', subtitle: 'Final Edits', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Designer', description: 'Apply client feedback and make final design refinements', icon: '✨', ai: 'Tracks feedback implementation, checks final quality, validates specifications', output: 'Refined designs ready for approval', docs: ['Refined Designs', 'Change Log', 'Quality Check', 'Specification Validation'] },
    { id: 'final_deliverables', label: 'Final Deliverables', abbreviation: 'FD', subtitle: 'Delivered', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Designer, Production', description: 'Prepare and deliver final files in all required formats', icon: '📦', ai: 'Validates file formats, checks print specifications, generates asset guide', output: 'Complete deliverable package', docs: ['Final Files', 'Asset Guide', 'Print-Ready Files', 'Digital Files', 'Style Guide Update'] },
  ],
  connectors: ['Brief guides concept sketches', 'Sketches evolve through design iterations', 'Iterations go through client feedback', 'Feedback drives refinements', 'Refinements produce final deliverables'],
  suggestions: {
    brief_direction: ['Suggest visual styles', 'Create mood board', 'Identify constraints'],
    concept_sketches: ['Check visual hierarchy', 'Suggest compositions', 'Explore typography'],
    design_iterations: ['Check accessibility', 'Validate color contrast', 'Improve layout'],
    client_feedback: ['Organize feedback', 'Identify conflicts', 'Suggest compromises'],
    refinements: ['Track changes', 'Check quality', 'Validate specs'],
    final_deliverables: ['Validate formats', 'Check print specs', 'Generate asset guide'],
  },
});

// ── Helpers ───────────────────────────────────────────────────────

const DEFAULT_LIFECYCLE_SLUG = 'software_development';

export function getLifecycle(slug?: string | null): LifecycleType {
  return LIFECYCLES.get(slug || DEFAULT_LIFECYCLE_SLUG) ?? LIFECYCLES.get(DEFAULT_LIFECYCLE_SLUG)!;
}

export function getStages(slug?: string | null): StageInfo[] {
  return getLifecycle(slug).stages;
}

export function getStageInfo(stageId: string, lifecycleSlug?: string | null): StageInfo | undefined {
  return getStages(lifecycleSlug).find((s) => s.id === stageId);
}

export function getNextStage(currentStageId: string, lifecycleSlug?: string | null): string | null {
  const stages = getStages(lifecycleSlug);
  const idx = stages.findIndex((s) => s.id === currentStageId);
  if (idx === -1 || idx >= stages.length - 1) return null;
  return stages[idx + 1].id;
}

export function getAllLifecycles(): LifecycleType[] {
  return Array.from(LIFECYCLES.values());
}
