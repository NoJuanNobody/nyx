/**
 * Lifecycle seed script — registers all lifecycle pipelines and their stages.
 *
 * Safe to run in any environment. Uses ON CONFLICT DO NOTHING for idempotency.
 *
 * Usage:
 *   DATABASE_URL=<url> pnpm --filter @nyx/api db:seed-lifecycles
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { lifecycles, lifecycleStages } from './schema.js';

// ── Lifecycle definitions ─────────────────────────────────────────

interface StageSeed {
  slug: string;
  sortOrder: number;
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

interface LifecycleSeed {
  slug: string;
  label: string;
  description: string;
  icon: string;
  isDefault: boolean;
  sortOrder: number;
  stages: StageSeed[];
}

export const LIFECYCLE_SEEDS: LifecycleSeed[] = [
  // ── Software Development (default) ──────────────────────────────
  {
    slug: 'software_development',
    label: 'Software Development',
    description: 'Full software product lifecycle from idea to deployed code',
    icon: '◎',
    isDefault: true,
    sortOrder: 0,
    stages: [
      { slug: 'conception', sortOrder: 0, label: 'Conception', abbreviation: 'CO', subtitle: 'Idea & Vision', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#E8C547', who: 'Product Managers, Founders', description: 'Capture the initial idea, problem space, and vision', icon: '◎', ai: 'Stress-tests your idea, identifies blind spots, suggests missing angles', output: 'Validated concept brief ready for product definition', docs: ['Problem Statement', 'Value Proposition', 'Market Opportunity', 'Rough Concept Notes'] },
      { slug: 'definition', sortOrder: 1, label: 'Definition', abbreviation: 'DF', subtitle: 'Product Spec', color: 'bg-teal-100', textColor: 'text-teal-700', dotColor: 'bg-teal-400', borderColor: 'border-teal-300', hex: '#4EC9B0', who: 'Product Managers, Designers', description: 'Translate the idea into a complete product specification', icon: '◈', ai: 'Flags ambiguous requirements, generates user stories from PRD, scores completeness', output: 'Structured PRD that engineering can trust', docs: ['Product Requirements Doc (PRD)', 'User Stories', 'Personas', 'Feature List', 'Competitive Analysis'] },
      { slug: 'architecture', sortOrder: 2, label: 'Architecture', abbreviation: 'AR', subtitle: 'System Design', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#7B9FE0', who: 'Tech Leads, Senior Engineers', description: 'Design the system that implements the specification', icon: '◫', ai: 'Reviews architecture for gaps, suggests patterns, links decisions back to PRD intent', output: 'Architecture docs linked to every PRD requirement they serve', docs: ['System Architecture Doc', 'Data Models', 'API Contracts', 'Component Hierarchy', 'Tech Stack Decisions'] },
      { slug: 'implementation', sortOrder: 3, label: 'Implementation', abbreviation: 'IM', subtitle: 'Dev Specs', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#C084FC', who: 'Engineers, QA', description: 'Create developer-ready specifications for AI coding agents', icon: '◧', ai: 'Scores spec quality for AI code generation, auto-generates tickets, suggests edge cases', output: 'Implementation-ready specs optimized for Claude Code & Copilot', docs: ['AI-Ready Feature Specs', 'Ticket Breakdowns', 'Acceptance Criteria', 'Edge Cases', 'Test Plans'] },
      { slug: 'execution', sortOrder: 4, label: 'Execution', abbreviation: 'EX', subtitle: 'Code & Sync', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#F87171', who: 'Engineers, DevOps', description: 'Track the living codebase and keep docs in sync', icon: '◉', ai: 'Watches commits, detects doc-code drift in real time, flags intent violations', output: 'Codebase that never diverges silently from its original intent', docs: ['Living Codebase', 'Auto-Updated Docs', 'Drift Alerts', 'Change History', 'Rollback Points'] },
    ],
  },

  // ── #157: Scientific Writing ────────────────────────────────────
  {
    slug: 'scientific_writing', label: 'Scientific Writing', description: 'Research-to-publication pipeline for academic and scientific papers', icon: '🔬', isDefault: false, sortOrder: 1,
    stages: [
      { slug: 'research_notes', sortOrder: 0, label: 'Research Notes', abbreviation: 'RN', subtitle: 'Data & Observations', color: 'bg-sky-100', textColor: 'text-sky-700', dotColor: 'bg-sky-400', borderColor: 'border-sky-300', hex: '#38BDF8', who: 'Researchers, Lab Teams', description: 'Collect raw data, observations, and preliminary findings', icon: '📝', ai: 'Identifies patterns in raw data, suggests hypotheses, flags missing controls', output: 'Organized research notes with tagged observations', docs: ['Lab Notebook', 'Data Logs', 'Observation Notes', 'Hypothesis Draft'] },
      { slug: 'literature_review', sortOrder: 1, label: 'Literature Review', abbreviation: 'LR', subtitle: 'Prior Work', color: 'bg-cyan-100', textColor: 'text-cyan-700', dotColor: 'bg-cyan-400', borderColor: 'border-cyan-300', hex: '#22D3EE', who: 'Researchers, Academics', description: 'Survey existing literature and establish theoretical framework', icon: '📚', ai: 'Identifies citation gaps, suggests related papers, checks for conflicting findings', output: 'Comprehensive literature review with citation map', docs: ['Literature Survey', 'Citation Matrix', 'Gap Analysis', 'Theoretical Framework'] },
      { slug: 'draft_sections', sortOrder: 2, label: 'Draft Sections', abbreviation: 'DS', subtitle: 'First Draft', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#60A5FA', who: 'Lead Author, Co-authors', description: 'Write initial manuscript sections', icon: '✍️', ai: 'Checks logical flow, suggests clearer phrasing, flags unsupported claims', output: 'Complete first draft of all manuscript sections', docs: ['Introduction', 'Methods', 'Results', 'Discussion', 'Abstract'] },
      { slug: 'peer_review', sortOrder: 3, label: 'Peer Review', abbreviation: 'PR', subtitle: 'External Feedback', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A78BFA', who: 'Peer Reviewers, Advisors', description: 'Submit for internal or external peer review', icon: '👥', ai: 'Simulates reviewer concerns, identifies weak arguments, suggests clarifications', output: 'Annotated feedback from peer reviewers', docs: ['Reviewer Comments', 'Response Plan', 'Strength/Weakness Analysis'] },
      { slug: 'revisions', sortOrder: 4, label: 'Revisions', abbreviation: 'RV', subtitle: 'Refinement', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#FB923C', who: 'Lead Author', description: 'Address reviewer feedback and refine the manuscript', icon: '🔄', ai: 'Tracks changes against reviewer comments, ensures all feedback addressed', output: 'Revised manuscript with point-by-point response', docs: ['Revision Tracker', 'Response to Reviewers', 'Change Log'] },
      { slug: 'final_paper', sortOrder: 5, label: 'Final Paper', abbreviation: 'FP', subtitle: 'Publication Ready', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#4ADE80', who: 'Lead Author, Journal Editor', description: 'Finalize formatting, references, and submit', icon: '📄', ai: 'Checks journal formatting, validates references, generates submission checklist', output: 'Publication-ready manuscript', docs: ['Final Manuscript', 'Supplementary Materials', 'Cover Letter', 'Submission Checklist'] },
    ],
  },

  // ── #158: Hardware Design ───────────────────────────────────────
  {
    slug: 'hardware_design', label: 'Hardware Design', description: 'Electronic and mechanical hardware from schematic to manufacturing', icon: '🔧', isDefault: false, sortOrder: 2,
    stages: [
      { slug: 'schematic_design', sortOrder: 0, label: 'Schematic Design', abbreviation: 'SD', subtitle: 'Circuit Design', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#F87171', who: 'Electrical Engineers', description: 'Design circuit schematics and select components', icon: '⚡', ai: 'Validates component compatibility, suggests alternatives', output: 'Complete schematic with BOM', docs: ['Schematic Diagram', 'Bill of Materials', 'Component Selection', 'Design Constraints'] },
      { slug: 'pcb_layout', sortOrder: 1, label: 'PCB Layout', abbreviation: 'PL', subtitle: 'Board Design', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#FB923C', who: 'PCB Designers', description: 'Translate schematic into physical PCB layout', icon: '🖥️', ai: 'Checks trace routing, thermal analysis, signal integrity', output: 'Gerber-ready PCB layout files', docs: ['PCB Layout', 'Layer Stack-up', 'DRC Report', 'Thermal Analysis'] },
      { slug: 'prototyping', sortOrder: 2, label: 'Prototyping', abbreviation: 'PT', subtitle: 'Build & Verify', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#FACC15', who: 'Hardware Engineers', description: 'Build physical prototypes and verify functionality', icon: '🔨', ai: 'Generates test procedures, tracks prototype iterations', output: 'Working prototype with assembly notes', docs: ['Assembly Instructions', 'Prototype Log', 'Test Results', 'Issue Tracker'] },
      { slug: 'testing', sortOrder: 3, label: 'Testing', abbreviation: 'TS', subtitle: 'Validation', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Test Engineers, QA', description: 'Run comprehensive functional and compliance tests', icon: '🧪', ai: 'Suggests test cases, compares results to specifications', output: 'Complete test report', docs: ['Test Plan', 'Test Results', 'Compliance Report', 'Failure Analysis'] },
      { slug: 'manufacturing_prep', sortOrder: 4, label: 'Manufacturing Prep', abbreviation: 'MP', subtitle: 'Production Ready', color: 'bg-teal-100', textColor: 'text-teal-700', dotColor: 'bg-teal-400', borderColor: 'border-teal-300', hex: '#2DD4BF', who: 'Manufacturing Engineers', description: 'Prepare for mass production', icon: '🏭', ai: 'Reviews DFM, identifies cost optimization', output: 'Manufacturing package', docs: ['Manufacturing Plan', 'DFM Report', 'QC Plan', 'Supply Chain Setup'] },
      { slug: 'final_specs', sortOrder: 5, label: 'Final Specs', abbreviation: 'FS', subtitle: 'Release Package', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#34D399', who: 'Engineering Lead', description: 'Compile final specifications and release docs', icon: '📋', ai: 'Cross-references specs, generates compliance matrix', output: 'Complete product spec package', docs: ['Final Specifications', 'Datasheet', 'Certification Docs', 'Release Notes'] },
    ],
  },

  // ── #159: Creative Writing ──────────────────────────────────────
  {
    slug: 'creative_writing', label: 'Creative Writing', description: 'Fiction and non-fiction writing from outline to publication', icon: '✒️', isDefault: false, sortOrder: 3,
    stages: [
      { slug: 'outline', sortOrder: 0, label: 'Outline', abbreviation: 'OL', subtitle: 'Story Structure', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Author', description: 'Create story outline and character profiles', icon: '📋', ai: 'Suggests plot structures, identifies pacing issues', output: 'Detailed outline with character sheets', docs: ['Story Outline', 'Character Profiles', 'Plot Structure', 'World-Building Notes'] },
      { slug: 'first_draft', sortOrder: 1, label: 'First Draft', abbreviation: 'FD', subtitle: 'Raw Writing', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Author', description: 'Write the complete first draft', icon: '✍️', ai: 'Maintains voice consistency, flags plot holes', output: 'Complete first draft manuscript', docs: ['Manuscript Draft', 'Chapter Notes', 'Continuity Tracker'] },
      { slug: 'revision_passes', sortOrder: 2, label: 'Revision Passes', abbreviation: 'RP', subtitle: 'Self-Editing', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Author', description: 'Perform structural and line-level revisions', icon: '🔄', ai: 'Identifies weak passages, checks pacing and tension', output: 'Revised manuscript', docs: ['Revision Notes', 'Structural Changes', 'Line Edit Log'] },
      { slug: 'feedback_integration', sortOrder: 3, label: 'Feedback Integration', abbreviation: 'FI', subtitle: 'Beta Readers', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#FB7185', who: 'Author, Beta Readers, Editor', description: 'Incorporate feedback from beta readers and editors', icon: '💬', ai: 'Synthesizes feedback themes, prioritizes changes', output: 'Manuscript incorporating external feedback', docs: ['Beta Reader Feedback', 'Editor Notes', 'Change Priority List'] },
      { slug: 'final_polish', sortOrder: 4, label: 'Final Polish', abbreviation: 'FP', subtitle: 'Copyediting', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Author, Copyeditor', description: 'Final copyediting, proofreading, and formatting', icon: '✨', ai: 'Catches typos, ensures style consistency', output: 'Clean, polished manuscript', docs: ['Copyedit Pass', 'Style Guide Compliance', 'Final Proofread'] },
      { slug: 'publication_ready', sortOrder: 5, label: 'Publication Ready', abbreviation: 'PB', subtitle: 'Ship It', color: 'bg-fuchsia-100', textColor: 'text-fuchsia-700', dotColor: 'bg-fuchsia-400', borderColor: 'border-fuchsia-300', hex: '#D946EF', who: 'Author, Publisher', description: 'Final manuscript ready for publication', icon: '📚', ai: 'Generates query letter, checks submission requirements', output: 'Submission-ready package', docs: ['Final Manuscript', 'Query Letter', 'Synopsis', 'Author Bio'] },
    ],
  },

  // ── #160: Marketing Copy ────────────────────────────────────────
  {
    slug: 'marketing_copy', label: 'Marketing Copy', description: 'Marketing content from brief to live deployment', icon: '📣', isDefault: false, sortOrder: 4,
    stages: [
      { slug: 'brief_strategy', sortOrder: 0, label: 'Brief & Strategy', abbreviation: 'BS', subtitle: 'Campaign Plan', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Marketing Managers', description: 'Define campaign objectives and messaging strategy', icon: '🎯', ai: 'Analyzes audience segments, suggests positioning', output: 'Complete creative brief', docs: ['Creative Brief', 'Audience Personas', 'Messaging Framework', 'Competitive Positioning'] },
      { slug: 'draft_variations', sortOrder: 1, label: 'Draft Variations', abbreviation: 'DV', subtitle: 'Copy Options', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Copywriters', description: 'Write multiple copy variations for testing', icon: '✍️', ai: 'Generates headline variants, checks tone alignment', output: 'Multiple copy variations', docs: ['Headline Variations', 'Body Copy Drafts', 'CTA Options', 'Channel Adaptations'] },
      { slug: 'ab_testing', sortOrder: 2, label: 'A/B Testing Data', abbreviation: 'AB', subtitle: 'Performance Data', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Growth Team, Analysts', description: 'Run A/B tests and collect performance data', icon: '📊', ai: 'Analyzes test results, recommends winners', output: 'Test results with analysis', docs: ['Test Setup', 'Performance Metrics', 'Statistical Analysis', 'Winner Recommendation'] },
      { slug: 'refinement', sortOrder: 3, label: 'Refinement', abbreviation: 'RF', subtitle: 'Optimization', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Copywriters, Marketing Lead', description: 'Refine winning copy based on test data', icon: '🔧', ai: 'Suggests improvements based on data', output: 'Optimized copy', docs: ['Refined Copy', 'Stakeholder Feedback', 'Channel-Specific Versions'] },
      { slug: 'final_version', sortOrder: 4, label: 'Final Version', abbreviation: 'FV', subtitle: 'Approved Copy', color: 'bg-fuchsia-100', textColor: 'text-fuchsia-700', dotColor: 'bg-fuchsia-400', borderColor: 'border-fuchsia-300', hex: '#D946EF', who: 'Marketing Lead, Legal', description: 'Final approval and legal review', icon: '✅', ai: 'Checks legal compliance, brand guidelines', output: 'Approved final copy', docs: ['Approved Copy', 'Legal Review', 'Brand Compliance', 'Approval Chain'] },
      { slug: 'live', sortOrder: 5, label: 'Live', abbreviation: 'LV', subtitle: 'Deployed', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Marketing Ops', description: 'Deploy to live channels and monitor', icon: '🚀', ai: 'Monitors performance, suggests optimizations', output: 'Live copy with monitoring', docs: ['Deployment Log', 'Performance Dashboard', 'Optimization Notes', 'Post-Launch Report'] },
    ],
  },

  // ── #161: Journalism ────────────────────────────────────────────
  {
    slug: 'journalism', label: 'Journalism', description: 'News and investigative journalism from pitch to publication', icon: '📰', isDefault: false, sortOrder: 5,
    stages: [
      { slug: 'story_pitch', sortOrder: 0, label: 'Story Pitch', abbreviation: 'SP', subtitle: 'Story Idea', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Reporter, Editor', description: 'Develop and pitch the story idea', icon: '💡', ai: 'Evaluates newsworthiness, suggests angles', output: 'Approved story pitch', docs: ['Story Pitch', 'Source List', 'Angle Analysis', 'Timeline Estimate'] },
      { slug: 'research_reporting', sortOrder: 1, label: 'Research & Reporting', abbreviation: 'RR', subtitle: 'Investigation', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Reporter', description: 'Conduct interviews, gather data, verify facts', icon: '🔍', ai: 'Identifies public records, fact-checks claims', output: 'Complete research file', docs: ['Interview Notes', 'Data Files', 'Fact-Check Log', 'Source Verification'] },
      { slug: 'draft_article', sortOrder: 2, label: 'Draft Article', abbreviation: 'DA', subtitle: 'Writing', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Reporter', description: 'Write the article with proper attribution', icon: '✍️', ai: 'Checks structure, ensures proper attribution', output: 'Complete article draft', docs: ['Article Draft', 'Source Attribution', 'Supporting Data'] },
      { slug: 'editorial_review', sortOrder: 3, label: 'Editorial Review', abbreviation: 'ER', subtitle: 'Editor Feedback', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Editor, Copy Editor', description: 'Editorial review for accuracy and standards', icon: '📝', ai: 'Checks AP style, identifies legal issues', output: 'Edited article', docs: ['Editor Markup', 'Legal Review', 'Headline Options'] },
      { slug: 'revisions', sortOrder: 4, label: 'Revisions', abbreviation: 'RV', subtitle: 'Final Edits', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#F43F5E', who: 'Reporter, Editor', description: 'Address editorial feedback and finalize', icon: '🔄', ai: 'Tracks changes, verifies all feedback addressed', output: 'Revised article', docs: ['Revision Log', 'Final Fact-Check', 'Updated Draft'] },
      { slug: 'published', sortOrder: 5, label: 'Published', abbreviation: 'PB', subtitle: 'Live Story', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Editor, Digital Team', description: 'Publish and monitor engagement', icon: '📢', ai: 'Generates social media snippets, suggests follow-ups', output: 'Published article', docs: ['Published Article', 'Social Media Plan', 'Engagement Metrics', 'Follow-up Ideas'] },
    ],
  },

  // ── #162: Academic Curricula ─────────────────────────────────────
  {
    slug: 'academic_curricula', label: 'Academic Curricula', description: 'Curriculum development from learning objectives to final program', icon: '🎓', isDefault: false, sortOrder: 6,
    stages: [
      { slug: 'learning_objectives', sortOrder: 0, label: 'Learning Objectives', abbreviation: 'LO', subtitle: 'Goals & Outcomes', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Curriculum Designer', description: 'Define learning objectives and outcomes', icon: '🎯', ai: 'Checks Bloom\'s taxonomy alignment', output: 'Learning objectives with alignment matrix', docs: ['Learning Objectives', 'Bloom\'s Map', 'Prerequisite Analysis', 'Outcome Metrics'] },
      { slug: 'content_outline', sortOrder: 1, label: 'Content Outline', abbreviation: 'CO', subtitle: 'Course Structure', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Curriculum Designer', description: 'Create detailed content outline', icon: '📋', ai: 'Suggests logical sequencing, identifies gaps', output: 'Detailed course outline', docs: ['Course Outline', 'Module Breakdown', 'Time Allocation', 'Resource List'] },
      { slug: 'lesson_materials', sortOrder: 2, label: 'Lesson Materials', abbreviation: 'LM', subtitle: 'Content Creation', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Content Developers', description: 'Develop lesson plans, slides, activities', icon: '📖', ai: 'Suggests activities, checks reading level', output: 'Complete lesson materials', docs: ['Lesson Plans', 'Slides', 'Readings', 'Activity Guides', 'Discussion Prompts'] },
      { slug: 'assessments', sortOrder: 3, label: 'Assessments', abbreviation: 'AS', subtitle: 'Evaluation Tools', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Assessment Designers', description: 'Create quizzes, exams, rubrics', icon: '📝', ai: 'Aligns assessments to objectives', output: 'Complete assessment suite', docs: ['Quiz Bank', 'Exam Templates', 'Rubrics', 'Project Briefs', 'Assessment Map'] },
      { slug: 'pilot_testing', sortOrder: 4, label: 'Pilot Testing', abbreviation: 'PT', subtitle: 'Trial Run', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Pilot Instructors, Students', description: 'Run pilot and collect feedback', icon: '🧪', ai: 'Analyzes student performance data', output: 'Pilot results with recommendations', docs: ['Pilot Feedback', 'Performance Data', 'Instructor Notes', 'Improvement Plan'] },
      { slug: 'final_curriculum', sortOrder: 5, label: 'Final Curriculum', abbreviation: 'FC', subtitle: 'Approved Program', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Department Head', description: 'Finalize and approve curriculum', icon: '🏫', ai: 'Checks accreditation requirements', output: 'Approved curriculum', docs: ['Final Curriculum', 'Instructor Guide', 'Student Handbook', 'Accreditation Docs'] },
    ],
  },

  // ── #163: Financial Reports ─────────────────────────────────────
  {
    slug: 'financial_reports', label: 'Financial Reports', description: 'Financial reporting from data collection to regulatory filing', icon: '💰', isDefault: false, sortOrder: 7,
    stages: [
      { slug: 'data_collection', sortOrder: 0, label: 'Data Collection', abbreviation: 'DC', subtitle: 'Raw Financial Data', color: 'bg-slate-100', textColor: 'text-slate-700', dotColor: 'bg-slate-400', borderColor: 'border-slate-300', hex: '#64748B', who: 'Accountants, Analysts', description: 'Collect and reconcile financial data', icon: '📊', ai: 'Identifies anomalies, flags reconciliation issues', output: 'Reconciled dataset', docs: ['Data Sources', 'Reconciliation Report', 'Anomaly Log', 'Data Quality Assessment'] },
      { slug: 'analysis_framework', sortOrder: 1, label: 'Analysis Framework', abbreviation: 'AF', subtitle: 'Analytical Structure', color: 'bg-zinc-100', textColor: 'text-zinc-700', dotColor: 'bg-zinc-400', borderColor: 'border-zinc-300', hex: '#71717A', who: 'Financial Analysts', description: 'Define KPIs and comparison frameworks', icon: '📐', ai: 'Suggests relevant KPIs, identifies trends', output: 'Analysis framework', docs: ['KPI Definitions', 'Analysis Plan', 'Comparison Framework', 'Benchmark Data'] },
      { slug: 'draft_report', sortOrder: 2, label: 'Draft Report', abbreviation: 'DR', subtitle: 'Initial Report', color: 'bg-neutral-100', textColor: 'text-neutral-700', dotColor: 'bg-neutral-400', borderColor: 'border-neutral-300', hex: '#A3A3A3', who: 'Report Writers', description: 'Draft the financial report', icon: '📝', ai: 'Generates narrative, checks calculations', output: 'Draft report with charts', docs: ['Draft Report', 'Financial Statements', 'Charts', 'Management Commentary'] },
      { slug: 'audit_review', sortOrder: 3, label: 'Audit Review', abbreviation: 'AR', subtitle: 'Verification', color: 'bg-stone-100', textColor: 'text-stone-700', dotColor: 'bg-stone-400', borderColor: 'border-stone-300', hex: '#A8A29E', who: 'Auditors', description: 'Internal and external audit review', icon: '🔍', ai: 'Cross-references figures, checks GAAP/IFRS', output: 'Audit report', docs: ['Audit Findings', 'Compliance Check', 'Adjustments', 'Auditor Notes'] },
      { slug: 'revisions', sortOrder: 4, label: 'Revisions', abbreviation: 'RV', subtitle: 'Corrections', color: 'bg-gray-100', textColor: 'text-gray-700', dotColor: 'bg-gray-400', borderColor: 'border-gray-300', hex: '#9CA3AF', who: 'Financial Analysts', description: 'Address audit findings', icon: '🔄', ai: 'Tracks adjustments, recalculates affected figures', output: 'Corrected report', docs: ['Adjustment Log', 'Revised Statements', 'Response to Audit', 'Recalculation Notes'] },
      { slug: 'final_filing', sortOrder: 5, label: 'Final Filing', abbreviation: 'FF', subtitle: 'Submitted', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'CFO, Compliance', description: 'Final approval and regulatory filing', icon: '📋', ai: 'Checks filing requirements, validates formatting', output: 'Filed financial report', docs: ['Final Report', 'Filing Confirmation', 'Board Approval', 'Compliance Certificate'] },
    ],
  },

  // ── #164: Real Estate Listings ──────────────────────────────────
  {
    slug: 'real_estate_listings', label: 'Real Estate Listings', description: 'Property listing from intake to live market listing', icon: '🏠', isDefault: false, sortOrder: 8,
    stages: [
      { slug: 'property_intake', sortOrder: 0, label: 'Property Intake', abbreviation: 'PI', subtitle: 'Initial Info', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Listing Agent', description: 'Gather property details and listing agreement', icon: '📋', ai: 'Identifies missing details, suggests comparables', output: 'Complete intake package', docs: ['Property Details', 'Listing Agreement', 'Owner Info', 'Initial Assessment'] },
      { slug: 'photos_description', sortOrder: 1, label: 'Photos & Description', abbreviation: 'PD', subtitle: 'Visual Assets', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Photographer, Copywriter', description: 'Professional photography and property description', icon: '📸', ai: 'Writes compelling descriptions, highlights features', output: 'Professional photos and description', docs: ['Photo Gallery', 'Virtual Tour', 'Property Description', 'Feature Highlights'] },
      { slug: 'market_analysis', sortOrder: 2, label: 'Market Analysis', abbreviation: 'MA', subtitle: 'Pricing Strategy', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Listing Agent', description: 'Analyze comparable sales and pricing', icon: '📊', ai: 'Pulls comparable data, analyzes trends', output: 'CMA report', docs: ['CMA', 'Pricing Strategy', 'Market Trends', 'Comparable Sales'] },
      { slug: 'listing_draft', sortOrder: 3, label: 'Listing Draft', abbreviation: 'LD', subtitle: 'MLS Entry', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Listing Agent', description: 'Draft the MLS listing', icon: '📝', ai: 'Optimizes MLS fields, checks disclosures', output: 'Complete MLS draft', docs: ['MLS Draft', 'Disclosures', 'Marketing Plan', 'Showing Instructions'] },
      { slug: 'approval', sortOrder: 4, label: 'Approval', abbreviation: 'AP', subtitle: 'Owner Sign-off', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'Property Owner', description: 'Owner reviews and approves listing', icon: '✅', ai: 'Generates review summary, confirms accuracy', output: 'Approved listing', docs: ['Owner Approval', 'Review Checklist', 'Marketing Approval'] },
      { slug: 'live_listing', sortOrder: 5, label: 'Live Listing', abbreviation: 'LL', subtitle: 'On Market', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Listing Agent', description: 'Listing goes live on MLS', icon: '🏡', ai: 'Monitors response, suggests adjustments', output: 'Active listing', docs: ['Live Listing', 'Marketing Distribution', 'Showing Feedback', 'Market Response'] },
    ],
  },

  // ── #165: Pharma Documentation ──────────────────────────────────
  {
    slug: 'pharma_documentation', label: 'Pharma Documentation', description: 'Pharmaceutical regulatory documentation from protocol to submission', icon: '💊', isDefault: false, sortOrder: 9,
    stages: [
      { slug: 'protocol_design', sortOrder: 0, label: 'Protocol Design', abbreviation: 'PD', subtitle: 'Study Protocol', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Clinical Scientists', description: 'Design clinical study protocol', icon: '🔬', ai: 'Reviews protocol, suggests endpoints', output: 'Complete study protocol', docs: ['Study Protocol', 'Statistical Analysis Plan', 'Endpoint Definitions', 'Criteria'] },
      { slug: 'safety_data', sortOrder: 1, label: 'Safety Data', abbreviation: 'SD', subtitle: 'Safety Profile', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Pharmacovigilance', description: 'Compile and analyze safety data', icon: '🛡️', ai: 'Identifies safety signals, categorizes events', output: 'Safety data package', docs: ['Safety Summary', 'Adverse Events', 'Signal Detection', 'Preclinical Safety'] },
      { slug: 'efficacy_results', sortOrder: 2, label: 'Efficacy Results', abbreviation: 'ER', subtitle: 'Clinical Results', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'Biostatisticians', description: 'Analyze and present efficacy results', icon: '📈', ai: 'Validates statistics, generates summaries', output: 'Complete efficacy results', docs: ['Efficacy Summary', 'Statistical Tables', 'Figures', 'Subgroup Analyses'] },
      { slug: 'regulatory_draft', sortOrder: 3, label: 'Regulatory Draft', abbreviation: 'RD', subtitle: 'Submission Docs', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Regulatory Writers', description: 'Draft regulatory submission documents', icon: '📋', ai: 'Checks CTD structure, validates terminology', output: 'Complete regulatory draft', docs: ['Module 2 Summary', 'Clinical Overview', 'Nonclinical Overview', 'Quality Summary'] },
      { slug: 'compliance_review', sortOrder: 4, label: 'Compliance Review', abbreviation: 'CR', subtitle: 'QC & Review', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Quality Assurance', description: 'Quality control and compliance review', icon: '🔍', ai: 'Cross-checks data consistency, validates GCP', output: 'QC-approved documents', docs: ['QC Report', 'Compliance Checklist', 'Discrepancy Log', 'Sign-off Matrix'] },
      { slug: 'submission_ready', sortOrder: 5, label: 'Submission Ready', abbreviation: 'SR', subtitle: 'Filed', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Regulatory Affairs Lead', description: 'Final submission package assembly', icon: '📤', ai: 'Validates completeness, checks eCTD requirements', output: 'Submission-ready package', docs: ['Submission Package', 'Cover Letter', 'eCTD Validation', 'Filing Confirmation'] },
    ],
  },

  // ── #166: HR Policies ───────────────────────────────────────────
  {
    slug: 'hr_policies', label: 'HR Policies', description: 'HR policy development from concept to published policy', icon: '👥', isDefault: false, sortOrder: 10,
    stages: [
      { slug: 'policy_concept', sortOrder: 0, label: 'Policy Concept', abbreviation: 'PC', subtitle: 'Need Assessment', color: 'bg-sky-100', textColor: 'text-sky-700', dotColor: 'bg-sky-400', borderColor: 'border-sky-300', hex: '#38BDF8', who: 'HR Director', description: 'Identify policy need and objectives', icon: '💡', ai: 'Benchmarks against industry standards', output: 'Policy concept brief', docs: ['Policy Brief', 'Regulatory Requirements', 'Industry Benchmarks', 'Impact Assessment'] },
      { slug: 'stakeholder_input', sortOrder: 1, label: 'Stakeholder Input', abbreviation: 'SI', subtitle: 'Consultation', color: 'bg-cyan-100', textColor: 'text-cyan-700', dotColor: 'bg-cyan-400', borderColor: 'border-cyan-300', hex: '#22D3EE', who: 'HR Team, Department Heads', description: 'Gather stakeholder input', icon: '🗣️', ai: 'Synthesizes feedback, identifies conflicts', output: 'Stakeholder input summary', docs: ['Feedback Summary', 'Stakeholder Map', 'Conflict Analysis', 'Recommendations'] },
      { slug: 'draft_policy', sortOrder: 2, label: 'Draft Policy', abbreviation: 'DP', subtitle: 'Initial Draft', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'HR Policy Writers', description: 'Draft the policy document', icon: '📝', ai: 'Checks clarity, suggests plain language', output: 'Complete policy draft', docs: ['Policy Draft', 'Procedures', 'FAQ', 'Exception Handling'] },
      { slug: 'legal_review', sortOrder: 3, label: 'Legal Review', abbreviation: 'LR', subtitle: 'Compliance Check', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Legal Counsel', description: 'Legal and compliance review', icon: '⚖️', ai: 'Checks labor laws, identifies liability', output: 'Legally reviewed policy', docs: ['Legal Review', 'Compliance Checklist', 'Risk Assessment', 'Recommended Changes'] },
      { slug: 'employee_feedback', sortOrder: 4, label: 'Employee Feedback', abbreviation: 'EF', subtitle: 'Comment Period', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Employees', description: 'Open comment period for employee feedback', icon: '💬', ai: 'Analyzes sentiment, categorizes concerns', output: 'Employee feedback summary', docs: ['Employee Comments', 'Sentiment Analysis', 'Adjustments', 'Response Plan'] },
      { slug: 'published_policy', sortOrder: 5, label: 'Published Policy', abbreviation: 'PP', subtitle: 'Active Policy', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'HR Director', description: 'Final approval and publication', icon: '📢', ai: 'Generates communications, creates training materials', output: 'Published policy with rollout plan', docs: ['Final Policy', 'Communication', 'Training Materials', 'Review Schedule'] },
    ],
  },

  // ── #167: Contract Law ──────────────────────────────────────────
  {
    slug: 'contract_law', label: 'Contract Law', description: 'Legal contract lifecycle from requirements to executed agreement', icon: '⚖️', isDefault: false, sortOrder: 11,
    stages: [
      { slug: 'requirements_scope', sortOrder: 0, label: 'Requirements & Scope', abbreviation: 'RS', subtitle: 'Deal Terms', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Business Owner, Legal Lead', description: 'Define contract requirements and scope', icon: '📋', ai: 'Identifies missing terms, benchmarks agreements', output: 'Requirements with term sheet', docs: ['Requirements', 'Term Sheet', 'Scope Definition', 'Risk Profile'] },
      { slug: 'draft_agreement', sortOrder: 1, label: 'Draft Agreement', abbreviation: 'DA', subtitle: 'Initial Draft', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Legal Counsel', description: 'Draft the complete agreement', icon: '📝', ai: 'Generates clause language, checks consistency', output: 'Complete contract draft', docs: ['Contract Draft', 'Schedules', 'Definitions', 'Boilerplate'] },
      { slug: 'stakeholder_review', sortOrder: 2, label: 'Stakeholder Review', abbreviation: 'SR', subtitle: 'Internal Review', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Business, Finance, Ops', description: 'Internal stakeholder review', icon: '👥', ai: 'Summarizes business impact, flags unusual provisions', output: 'Reviewed draft with comments', docs: ['Review Comments', 'Business Impact', 'Operational Assessment', 'Sign-off'] },
      { slug: 'legal_revision', sortOrder: 3, label: 'Legal Revision', abbreviation: 'LV', subtitle: 'Redlining', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Legal Counsel', description: 'Incorporate feedback, prepare redline', icon: '🔴', ai: 'Tracks changes, prepares redline comparison', output: 'Revised draft with tracked changes', docs: ['Redlined Draft', 'Change Summary', 'Issue Log', 'Outstanding Items'] },
      { slug: 'negotiation_rounds', sortOrder: 4, label: 'Negotiation Rounds', abbreviation: 'NR', subtitle: 'Counterparty Talks', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#F43F5E', who: 'Legal Teams (Both Parties)', description: 'Exchange drafts and negotiate terms', icon: '🤝', ai: 'Analyzes counterparty redlines, suggests compromises', output: 'Negotiated agreement', docs: ['Counterparty Redline', 'Negotiation Log', 'Compromises', 'Open Issues'] },
      { slug: 'final_executed', sortOrder: 5, label: 'Final Executed', abbreviation: 'FE', subtitle: 'Signed Contract', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Authorized Signatories', description: 'Final execution with signatures', icon: '✍️', ai: 'Generates execution checklist, creates obligation tracker', output: 'Fully executed agreement', docs: ['Executed Agreement', 'Signature Page', 'Obligation Tracker', 'Key Dates'] },
    ],
  },

  // ── #168: Architectural Design ──────────────────────────────────
  {
    slug: 'architectural_design', label: 'Architectural Design', description: 'Building design from concept to construction-ready documents', icon: '🏗️', isDefault: false, sortOrder: 12,
    stages: [
      { slug: 'concept_sketch', sortOrder: 0, label: 'Concept Sketch', abbreviation: 'CS', subtitle: 'Design Vision', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Architect, Client', description: 'Develop initial design concepts', icon: '✏️', ai: 'Suggests approaches, identifies site constraints', output: 'Approved concept sketches', docs: ['Concept Sketches', 'Site Analysis', 'Design Brief', 'Mood Board', 'Precedents'] },
      { slug: 'detailed_drawings', sortOrder: 1, label: 'Detailed Drawings', abbreviation: 'DD', subtitle: 'Technical Drawings', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Architect, Drafters', description: 'Create detailed architectural drawings', icon: '📐', ai: 'Checks building codes, validates dimensions', output: 'Complete drawing set', docs: ['Floor Plans', 'Elevations', 'Sections', 'Details', 'Site Plan'] },
      { slug: 'materials_spec', sortOrder: 2, label: 'Materials Spec', abbreviation: 'MS', subtitle: 'Material Selection', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Architect', description: 'Select and specify materials', icon: '🧱', ai: 'Suggests alternatives, checks sustainability', output: 'Material specification', docs: ['Material Schedule', 'Finish Schedule', 'Sustainability Report', 'Product Specs'] },
      { slug: 'cost_analysis', sortOrder: 3, label: 'Cost Analysis', abbreviation: 'CA', subtitle: 'Budget Estimate', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Quantity Surveyor', description: 'Prepare cost estimates', icon: '💲', ai: 'Generates estimates, identifies VE opportunities', output: 'Detailed cost estimate', docs: ['Cost Estimate', 'Budget Analysis', 'VE Options', 'Cash Flow'] },
      { slug: 'contractor_review', sortOrder: 4, label: 'Contractor Review', abbreviation: 'CR', subtitle: 'Builder Feedback', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'General Contractor', description: 'Contractor constructability review', icon: '🏗️', ai: 'Identifies constructability issues', output: 'Reviewed plans with RFI responses', docs: ['Contractor Comments', 'RFI Log', 'Constructability Review', 'Coordination'] },
      { slug: 'construction_ready', sortOrder: 5, label: 'Construction Ready', abbreviation: 'CX', subtitle: 'Permit Set', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Architect, Owner', description: 'Final construction documents', icon: '🏛️', ai: 'Validates permit requirements', output: 'Construction-ready documents', docs: ['Construction Docs', 'Permit Application', 'Project Schedule', 'Contract Docs'] },
    ],
  },

  // ── #169: Music Production ──────────────────────────────────────
  {
    slug: 'music_production', label: 'Music Production', description: 'Music creation from composition to distribution', icon: '🎵', isDefault: false, sortOrder: 13,
    stages: [
      { slug: 'composition_arrangement', sortOrder: 0, label: 'Composition & Arrangement', abbreviation: 'CA', subtitle: 'Songwriting', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Songwriter, Composer', description: 'Write and arrange the composition', icon: '🎼', ai: 'Suggests chord progressions, checks structure', output: 'Complete arrangement', docs: ['Lead Sheet', 'Arrangement Notes', 'Chord Chart', 'Lyrics', 'References'] },
      { slug: 'recording_sessions', sortOrder: 1, label: 'Recording Sessions', abbreviation: 'RS', subtitle: 'Tracking', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Musicians, Engineer', description: 'Record all tracks', icon: '🎙️', ai: 'Tracks session progress, identifies issues', output: 'Complete multitrack recording', docs: ['Session Log', 'Track List', 'Performance Notes', 'Technical Settings'] },
      { slug: 'mixing_draft', sortOrder: 2, label: 'Mixing Draft', abbreviation: 'MD', subtitle: 'Initial Mix', color: 'bg-fuchsia-100', textColor: 'text-fuchsia-700', dotColor: 'bg-fuchsia-400', borderColor: 'border-fuchsia-300', hex: '#D946EF', who: 'Mixing Engineer', description: 'Create the initial mix', icon: '🎚️', ai: 'Analyzes frequency balance, suggests EQ', output: 'Draft mix', docs: ['Mix Notes', 'Plugin Chain', 'Revision Requests', 'Reference Comparison'] },
      { slug: 'mastering_notes', sortOrder: 3, label: 'Mastering Notes', abbreviation: 'MN', subtitle: 'Final Polish', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Mastering Engineer', description: 'Prepare mastering specifications', icon: '📊', ai: 'Analyzes loudness, checks format requirements', output: 'Mastering specs', docs: ['Mastering Specs', 'Loudness Analysis', 'Format Requirements', 'Notes'] },
      { slug: 'final_mix', sortOrder: 4, label: 'Final Mix', abbreviation: 'FM', subtitle: 'Approved Master', color: 'bg-rose-100', textColor: 'text-rose-700', dotColor: 'bg-rose-400', borderColor: 'border-rose-300', hex: '#F43F5E', who: 'Artist, Producer', description: 'Final approved mix and master', icon: '✅', ai: 'Quality check, cross-platform analysis', output: 'Approved final master', docs: ['Final Master', 'Approval Notes', 'Quality Check', 'Metadata'] },
      { slug: 'distribution_ready', sortOrder: 5, label: 'Distribution Ready', abbreviation: 'DR', subtitle: 'Release Package', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Artist, Distributor', description: 'Complete release package', icon: '📦', ai: 'Validates ISRC codes, checks platform requirements', output: 'Distribution-ready package', docs: ['Release Package', 'ISRC Registration', 'Artwork', 'Distribution Plan', 'Marketing Brief'] },
    ],
  },

  // ── #170: Educational Textbooks ─────────────────────────────────
  {
    slug: 'educational_textbooks', label: 'Educational Textbooks', description: 'Textbook development from outline to publication', icon: '📖', isDefault: false, sortOrder: 14,
    stages: [
      { slug: 'outline_structure', sortOrder: 0, label: 'Outline & Structure', abbreviation: 'OS', subtitle: 'Book Plan', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Author, Publisher', description: 'Create detailed table of contents', icon: '📋', ai: 'Suggests sequencing, identifies gaps', output: 'Approved book outline', docs: ['Table of Contents', 'Chapter Outlines', 'Standards Map', 'Scope & Sequence'] },
      { slug: 'chapter_drafts', sortOrder: 1, label: 'Chapter Drafts', abbreviation: 'CD', subtitle: 'Content Writing', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Author', description: 'Write complete chapter drafts', icon: '✍️', ai: 'Checks reading level, suggests examples', output: 'Complete chapter manuscripts', docs: ['Chapter Drafts', 'Examples', 'Practice Problems', 'Key Terms', 'Summaries'] },
      { slug: 'subject_matter_review', sortOrder: 2, label: 'Subject Matter Review', abbreviation: 'SM', subtitle: 'Expert Review', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Subject Matter Experts', description: 'Expert review for accuracy', icon: '🔍', ai: 'Identifies errors, evaluates pedagogy', output: 'Expert review report', docs: ['Review Comments', 'Accuracy Check', 'Pedagogy Assessment', 'Content Gaps'] },
      { slug: 'copyediting_pass', sortOrder: 3, label: 'Copyediting Pass', abbreviation: 'CE', subtitle: 'Editorial Review', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Copyeditors', description: 'Thorough copyediting', icon: '📝', ai: 'Checks grammar, enforces style guide', output: 'Copyedited manuscript', docs: ['Copyedit Markup', 'Style Queries', 'Consistency Check', 'Author Queries'] },
      { slug: 'illustrations_layout', sortOrder: 4, label: 'Illustrations & Layout', abbreviation: 'IL', subtitle: 'Visual Design', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Illustrators, Designers', description: 'Create illustrations and page layout', icon: '🎨', ai: 'Suggests diagram types, checks accessibility', output: 'Illustrated and typeset manuscript', docs: ['Illustrations', 'Diagrams', 'Page Proofs', 'Captions', 'Layout Specs'] },
      { slug: 'publication_ready', sortOrder: 5, label: 'Publication Ready', abbreviation: 'PB', subtitle: 'Print Ready', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Publisher', description: 'Final proofread and production files', icon: '📚', ai: 'Generates index, checks print specs', output: 'Publication-ready files', docs: ['Final Manuscript', 'Index', 'Print Specs', 'Digital Formats', 'Errata'] },
    ],
  },

  // ── #171: Marketing Campaigns ───────────────────────────────────
  {
    slug: 'marketing_campaigns', label: 'Marketing Campaigns', description: 'Full marketing campaign from strategy to launch', icon: '📢', isDefault: false, sortOrder: 15,
    stages: [
      { slug: 'strategy_brief', sortOrder: 0, label: 'Strategy & Creative Brief', abbreviation: 'SB', subtitle: 'Campaign Plan', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Marketing Director', description: 'Define campaign strategy and creative direction', icon: '🎯', ai: 'Analyzes market opportunity, defines KPIs', output: 'Campaign strategy and brief', docs: ['Strategy', 'Creative Brief', 'Target Audience', 'Budget', 'KPIs'] },
      { slug: 'asset_drafts', sortOrder: 1, label: 'Asset Drafts', abbreviation: 'AD', subtitle: 'Content Creation', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Creative Team', description: 'Create draft campaign assets', icon: '🎨', ai: 'Checks brand consistency, generates variations', output: 'Draft assets', docs: ['Visual Assets', 'Copy Drafts', 'Video Scripts', 'Social Content', 'Email Templates'] },
      { slug: 'stakeholder_feedback', sortOrder: 2, label: 'Stakeholder Feedback', abbreviation: 'SF', subtitle: 'Internal Review', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Stakeholders, Legal', description: 'Collect stakeholder feedback', icon: '💬', ai: 'Synthesizes feedback, prioritizes changes', output: 'Consolidated feedback', docs: ['Feedback Summary', 'Action Items', 'Legal Review', 'Approval Status'] },
      { slug: 'refinements', sortOrder: 3, label: 'Refinements', abbreviation: 'RF', subtitle: 'Final Edits', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Creative Team', description: 'Refine assets based on feedback', icon: '🔧', ai: 'Tracks feedback implementation', output: 'Refined assets', docs: ['Updated Assets', 'Revision Log', 'Quality Check', 'Channel Specs'] },
      { slug: 'final_assets', sortOrder: 4, label: 'Final Assets', abbreviation: 'FA', subtitle: 'Approved Creative', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Marketing Director', description: 'Final approval of all assets', icon: '✅', ai: 'Validates specs, checks compliance', output: 'Approved final assets', docs: ['Final Assets', 'Asset Inventory', 'Legal Sign-off', 'Distribution Matrix'] },
      { slug: 'launch_ready', sortOrder: 5, label: 'Launch Ready', abbreviation: 'LR', subtitle: 'Go Live', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Campaign Manager', description: 'Launch with monitoring', icon: '🚀', ai: 'Creates launch checklist, sets up monitoring', output: 'Launched campaign', docs: ['Launch Checklist', 'Distribution Schedule', 'Monitoring Dashboard', 'Post-Launch Report'] },
    ],
  },

  // ── #172: Game Design ───────────────────────────────────────────
  {
    slug: 'game_design', label: 'Game Design', description: 'Game development from design document to release candidate', icon: '🎮', isDefault: false, sortOrder: 16,
    stages: [
      { slug: 'design_document', sortOrder: 0, label: 'Design Document', abbreviation: 'GD', subtitle: 'Game Vision', color: 'bg-red-100', textColor: 'text-red-700', dotColor: 'bg-red-400', borderColor: 'border-red-300', hex: '#EF4444', who: 'Game Designer', description: 'Write the game design document', icon: '📋', ai: 'Identifies inconsistencies, analyzes player loops', output: 'Complete GDD', docs: ['GDD', 'Core Mechanics', 'Narrative', 'Art Direction', 'Target Audience'] },
      { slug: 'mechanics_prototype', sortOrder: 1, label: 'Mechanics Prototype', abbreviation: 'MP', subtitle: 'Core Gameplay', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Gameplay Programmers', description: 'Build and test core mechanics', icon: '⚙️', ai: 'Analyzes game feel, suggests balance', output: 'Playable prototype', docs: ['Prototype Build', 'Mechanics Docs', 'Balance Sheet', 'Play Notes'] },
      { slug: 'level_design', sortOrder: 2, label: 'Level Design', abbreviation: 'LD', subtitle: 'Content & Levels', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Level Designers', description: 'Design levels and progression', icon: '🗺️', ai: 'Analyzes difficulty curves, suggests pacing', output: 'Complete level designs', docs: ['Level Layouts', 'Encounter Design', 'Progression', 'Difficulty Curve', 'Collectibles'] },
      { slug: 'playtesting_feedback', sortOrder: 3, label: 'Playtesting Feedback', abbreviation: 'PF', subtitle: 'Player Testing', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'QA, Playtesters', description: 'Conduct playtests and collect feedback', icon: '🎯', ai: 'Analyzes playtest data, identifies friction', output: 'Playtest report', docs: ['Playtest Report', 'Player Feedback', 'Bug Reports', 'Heatmaps', 'Sessions'] },
      { slug: 'polish_pass', sortOrder: 4, label: 'Polish Pass', abbreviation: 'PP', subtitle: 'Final Polish', color: 'bg-green-100', textColor: 'text-green-700', dotColor: 'bg-green-400', borderColor: 'border-green-300', hex: '#22C55E', who: 'Full Team', description: 'Bug fixes, visual and audio polish', icon: '✨', ai: 'Prioritizes bugs, identifies bottlenecks', output: 'Polished build', docs: ['Bug Fix Log', 'Polish List', 'Performance Report', 'Audio Mix', 'Visual Polish'] },
      { slug: 'release_candidate', sortOrder: 5, label: 'Release Candidate', abbreviation: 'RC', subtitle: 'Ship It', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Producer, QA Lead', description: 'Release candidate for certification', icon: '🏆', ai: 'Generates release notes, validates platform requirements', output: 'Certified release candidate', docs: ['Release Candidate', 'Certification Checklist', 'Release Notes', 'Day-One Patch', 'Marketing'] },
    ],
  },

  // ── #173: Video Production ──────────────────────────────────────
  {
    slug: 'video_production', label: 'Video Production', description: 'Video content from script to final delivery', icon: '🎬', isDefault: false, sortOrder: 17,
    stages: [
      { slug: 'script_treatment', sortOrder: 0, label: 'Script & Treatment', abbreviation: 'ST', subtitle: 'Concept & Script', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Writer, Director', description: 'Write script and treatment', icon: '📝', ai: 'Suggests structure, generates shot list', output: 'Approved script', docs: ['Script', 'Treatment', 'Creative Brief', 'Characters', 'Locations'] },
      { slug: 'storyboard', sortOrder: 1, label: 'Storyboard', abbreviation: 'SB', subtitle: 'Visual Planning', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Storyboard Artist', description: 'Create visual storyboard', icon: '🎞️', ai: 'Suggests camera angles, checks continuity', output: 'Complete storyboard', docs: ['Storyboard Panels', 'Shot List', 'Camera Notes', 'Timing'] },
      { slug: 'production_notes', sortOrder: 2, label: 'Production Notes', abbreviation: 'PN', subtitle: 'Pre-Production', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Producer, AD', description: 'Create production schedule and logistics', icon: '📋', ai: 'Generates schedule, identifies conflicts', output: 'Pre-production package', docs: ['Schedule', 'Call Sheets', 'Budget', 'Equipment', 'Crew List'] },
      { slug: 'rough_cut', sortOrder: 3, label: 'Rough Cut', abbreviation: 'RC', subtitle: 'First Edit', color: 'bg-lime-100', textColor: 'text-lime-700', dotColor: 'bg-lime-400', borderColor: 'border-lime-300', hex: '#A3E635', who: 'Editor, Director', description: 'Assemble the rough cut', icon: '🎬', ai: 'Analyzes pacing, suggests alternate takes', output: 'Rough cut for review', docs: ['Rough Cut', 'Edit Decision List', 'Missing Coverage', 'Temp Music'] },
      { slug: 'color_sound', sortOrder: 4, label: 'Color & Sound', abbreviation: 'CS', subtitle: 'Post-Production', color: 'bg-teal-100', textColor: 'text-teal-700', dotColor: 'bg-teal-400', borderColor: 'border-teal-300', hex: '#2DD4BF', who: 'Colorist, Sound Designer', description: 'Color grading and audio mixing', icon: '🎨', ai: 'Checks color consistency, audio levels', output: 'Color-graded and mixed version', docs: ['Color Grade', 'Sound Design', 'Audio Mix', 'VFX', 'Music Cues'] },
      { slug: 'final_delivery', sortOrder: 5, label: 'Final Delivery', abbreviation: 'FD', subtitle: 'Deliverables', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Post Supervisor', description: 'Final deliverables in all formats', icon: '📦', ai: 'Validates delivery specs, generates QC report', output: 'Complete delivery package', docs: ['Final Master', 'Manifest', 'QC Report', 'Captions', 'Promo Materials'] },
    ],
  },

  // ── #192: Unscripted Video Production ──────────────────────────
  {
    slug: 'unscripted_video_production',
    label: 'Unscripted Video Production',
    description: 'Flexible video production without a predetermined script — from concept to delivery',
    icon: '🎥',
    isDefault: false,
    sortOrder: 18,
    stages: [
      { slug: 'brief_concept', sortOrder: 0, label: 'Brief & Concept', abbreviation: 'BC', subtitle: 'Concept', color: 'bg-amber-100', textColor: 'text-amber-700', dotColor: 'bg-amber-400', borderColor: 'border-amber-300', hex: '#F59E0B', who: 'Producer, Director', description: 'Define the video concept, format, audience, and key talking points', icon: '💡', ai: 'Suggests angles, key messages, and talking points based on the concept', output: 'Approved concept brief', docs: ['Project Overview', 'Concept Brief', 'Talking Points', 'Participant List'] },
      { slug: 'shot_list_outline', sortOrder: 1, label: 'Shot List / Outline', abbreviation: 'SL', subtitle: 'Visual Planning', color: 'bg-orange-100', textColor: 'text-orange-700', dotColor: 'bg-orange-400', borderColor: 'border-orange-300', hex: '#F97316', who: 'Director, DP', description: 'Plan shots, angles, and a loose coverage outline in place of a full storyboard', icon: '🎞️', ai: 'Suggests shot types, b-roll ideas, and coverage for the format', output: 'Shot list and coverage outline', docs: ['Shot List', 'Coverage Outline', 'B-Roll Checklist', 'Equipment Notes'] },
      { slug: 'recording_notes', sortOrder: 2, label: 'Recording Notes', abbreviation: 'RN', subtitle: 'Production', color: 'bg-yellow-100', textColor: 'text-yellow-700', dotColor: 'bg-yellow-400', borderColor: 'border-yellow-300', hex: '#EAB308', who: 'Director, DP, Sound', description: 'Capture take logs, timestamps, and on-set notes during recording for use in editing', icon: '🎙️', ai: 'Flags best takes and key moments from recording notes', output: 'Annotated take log and timestamp notes', docs: ['Take Log', 'Timestamp Notes', 'B-Roll Log', 'Audio Notes'] },
      { slug: 'post_production_review', sortOrder: 3, label: 'Post-Production', abbreviation: 'PP', subtitle: 'Editing & Finishing', color: 'bg-teal-100', textColor: 'text-teal-700', dotColor: 'bg-teal-400', borderColor: 'border-teal-300', hex: '#2DD4BF', who: 'Editor', description: 'Edit footage, add graphics and captions, mix audio, and prepare a review cut', icon: '🎬', ai: 'Analyzes pacing and suggests structure from recording notes', output: 'Polished cut ready for stakeholder review', docs: ['Edit Notes', 'Graphics List', 'Music Notes', 'Caption Draft'] },
      { slug: 'stakeholder_review', sortOrder: 4, label: 'Review', abbreviation: 'RV', subtitle: 'Stakeholder Review', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Stakeholders, Client', description: 'Collect structured feedback from stakeholders and track revisions to final approval', icon: '👁️', ai: 'Summarizes feedback themes and prioritizes revision items', output: 'Approved final cut', docs: ['Review Feedback', 'Revision List', 'Approval Sign-off'] },
      { slug: 'final_delivery', sortOrder: 5, label: 'Final Delivery', abbreviation: 'FD', subtitle: 'Deliverables', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Post Supervisor', description: 'Export final video in all required formats and deliver with QC report', icon: '📦', ai: 'Validates delivery specs and generates QC report', output: 'Complete delivery package', docs: ['Final Master', 'Manifest', 'QC Report', 'Captions', 'Distribution Notes'] },
    ],
  },

  // ── #174: Graphic Design ────────────────────────────────────────
  {
    slug: 'graphic_design', label: 'Graphic Design', description: 'Graphic design from brief to final deliverables', icon: '🎨', isDefault: false, sortOrder: 19,
    stages: [
      { slug: 'brief_direction', sortOrder: 0, label: 'Brief & Creative Direction', abbreviation: 'BD', subtitle: 'Project Brief', color: 'bg-blue-100', textColor: 'text-blue-700', dotColor: 'bg-blue-400', borderColor: 'border-blue-300', hex: '#3B82F6', who: 'Client, Art Director', description: 'Define the design brief and direction', icon: '🎯', ai: 'Suggests visual styles, identifies constraints', output: 'Approved creative brief', docs: ['Creative Brief', 'Mood Board', 'Brand Guidelines', 'Scope', 'References'] },
      { slug: 'concept_sketches', sortOrder: 1, label: 'Concept Sketches', abbreviation: 'CS', subtitle: 'Initial Concepts', color: 'bg-indigo-100', textColor: 'text-indigo-700', dotColor: 'bg-indigo-400', borderColor: 'border-indigo-300', hex: '#6366F1', who: 'Designer', description: 'Create initial concept sketches', icon: '✏️', ai: 'Checks visual hierarchy, suggests compositions', output: 'Multiple concept directions', docs: ['Concepts', 'Design Explorations', 'Typography Study', 'Color Palettes'] },
      { slug: 'design_iterations', sortOrder: 2, label: 'Design Iterations', abbreviation: 'DI', subtitle: 'Refinement', color: 'bg-violet-100', textColor: 'text-violet-700', dotColor: 'bg-violet-400', borderColor: 'border-violet-300', hex: '#8B5CF6', who: 'Designer', description: 'Develop selected concepts further', icon: '🔄', ai: 'Checks accessibility, validates contrast', output: 'Detailed design iterations', docs: ['Iterations', 'Layout Variations', 'Color System', 'Components'] },
      { slug: 'client_feedback', sortOrder: 3, label: 'Client Feedback', abbreviation: 'CF', subtitle: 'Client Review', color: 'bg-purple-100', textColor: 'text-purple-700', dotColor: 'bg-purple-400', borderColor: 'border-purple-300', hex: '#A855F7', who: 'Client', description: 'Present designs and collect feedback', icon: '💬', ai: 'Organizes feedback, suggests compromises', output: 'Feedback with action items', docs: ['Client Feedback', 'Presentation', 'Action Items', 'Priority Matrix'] },
      { slug: 'refinements', sortOrder: 4, label: 'Refinements', abbreviation: 'RF', subtitle: 'Final Edits', color: 'bg-pink-100', textColor: 'text-pink-700', dotColor: 'bg-pink-400', borderColor: 'border-pink-300', hex: '#EC4899', who: 'Designer', description: 'Apply feedback and refine', icon: '✨', ai: 'Tracks changes, checks quality', output: 'Refined designs', docs: ['Refined Designs', 'Change Log', 'Quality Check', 'Spec Validation'] },
      { slug: 'final_deliverables', sortOrder: 5, label: 'Final Deliverables', abbreviation: 'FD', subtitle: 'Delivered', color: 'bg-emerald-100', textColor: 'text-emerald-700', dotColor: 'bg-emerald-400', borderColor: 'border-emerald-300', hex: '#10B981', who: 'Designer, Production', description: 'Prepare final files in all formats', icon: '📦', ai: 'Validates formats, checks print specs', output: 'Complete deliverable package', docs: ['Final Files', 'Asset Guide', 'Print-Ready', 'Digital Files', 'Style Guide'] },
    ],
  },
];

// ── Idempotent seeding ────────────────────────────────────────────

export async function ensureLifecycles(): Promise<void> {
  for (const lc of LIFECYCLE_SEEDS) {
    // Insert lifecycle (skip if slug already exists)
    const [inserted] = await db
      .insert(lifecycles)
      .values({
        slug: lc.slug,
        label: lc.label,
        description: lc.description,
        icon: lc.icon,
        isDefault: lc.isDefault,
        sortOrder: lc.sortOrder,
      })
      .onConflictDoNothing()
      .returning();

    // Get lifecycle ID (either just inserted or already existing)
    let lifecycleId: string;
    if (inserted) {
      lifecycleId = inserted.id;
    } else {
      const [existing] = await db
        .select({ id: lifecycles.id })
        .from(lifecycles)
        .where(
          eq(lifecycles.slug, lc.slug),
        );
      if (!existing) continue;
      lifecycleId = existing.id;
    }

    // Insert stages
    for (const stage of lc.stages) {
      await db
        .insert(lifecycleStages)
        .values({
          lifecycleId,
          slug: stage.slug,
          sortOrder: stage.sortOrder,
          label: stage.label,
          abbreviation: stage.abbreviation,
          subtitle: stage.subtitle,
          color: stage.color,
          textColor: stage.textColor,
          dotColor: stage.dotColor,
          borderColor: stage.borderColor,
          hex: stage.hex,
          who: stage.who,
          description: stage.description,
          icon: stage.icon,
          ai: stage.ai,
          output: stage.output,
          docs: stage.docs,
        })
        .onConflictDoNothing();
    }
  }

  console.log(`[seed-lifecycles] Ensured ${LIFECYCLE_SEEDS.length} lifecycles with stages`);
}

// ── CLI entry point ─────────────────────────────────────────────
const isCLI = process.argv[1]?.includes('seed-lifecycles');
if (isCLI) {
  const env = process.env.NODE_ENV || 'development';
  console.log(`[seed-lifecycles] Environment: ${env}`);
  console.log('[seed-lifecycles] Inserting lifecycles and stages (ON CONFLICT DO NOTHING)...\n');

  ensureLifecycles()
    .then(() => {
      console.log('[seed-lifecycles] Done.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed-lifecycles] Failed:', err);
      process.exit(1);
    });
}
