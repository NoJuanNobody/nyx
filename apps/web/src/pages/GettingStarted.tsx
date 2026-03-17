import { useState } from 'react';
import { Link } from 'react-router-dom';

type Tab = 'tutorial' | 'help' | 'examples';

interface TutorialStep {
  title: string;
  description: string;
  link?: { to: string; label: string };
}

const tutorialSteps: TutorialStep[] = [
  {
    title: '1. Connect your repository',
    description:
      'Link your GitHub repositories so Nyx can detect code changes and keep your documentation in sync.',
    link: { to: '/repositories', label: 'Go to Repositories' },
  },
  {
    title: '2. Create your first spec',
    description:
      'Use the dashboard to create a new document. The AI-assisted editor helps you write structured specs quickly.',
    link: { to: '/dashboard', label: 'Go to Dashboard' },
  },
  {
    title: '3. Explore the product lifecycle',
    description:
      'Understand how Nyx guides ideas through five phases: Ideation, Specification, Implementation, Review, and Maintenance.',
    link: { to: '/lifecycle', label: 'View Lifecycle' },
  },
  {
    title: '4. Generate tickets from specs',
    description:
      'Once your spec is ready, Nyx can generate GitHub Issues or Jira tickets directly from your documentation.',
    link: { to: '/board', label: 'View Board' },
  },
  {
    title: '5. Monitor drift',
    description:
      'As your codebase evolves, Nyx detects when documentation falls out of sync and suggests updates.',
    link: { to: '/observability', label: 'View Observability' },
  },
];

interface HelpTopic {
  title: string;
  content: string;
}

const helpTopics: HelpTopic[] = [
  {
    title: 'What is Nyx?',
    content:
      'Nyx is a product versioning platform that keeps technical documentation in sync with your code. It bridges the gap between product stakeholders who write specs and developers who implement them.',
  },
  {
    title: 'How does drift detection work?',
    content:
      'Nyx connects to your GitHub repositories via webhooks. When code changes are pushed, it analyzes the diff against your existing documentation and flags any specs that may be outdated or inconsistent with the codebase.',
  },
  {
    title: 'Can non-technical users create specs?',
    content:
      'Yes. The AI-assisted editor supports natural language input and structured templates. Non-technical stakeholders can describe features in plain language, and Nyx helps structure them into proper specifications.',
  },
  {
    title: 'How do I integrate with my AI coding agent?',
    content:
      'Nyx provides an MCP server that works with Cursor, GitHub Copilot, Claude Code, and other AI coding tools. Connect via the Agents page to let your AI assistant consume Nyx specs as context while coding.',
  },
  {
    title: 'What export formats are supported?',
    content:
      'Nyx supports Markdown and PDF exports for all documentation. You can export individual documents or entire collections. There is no vendor lock-in — your documentation is always portable.',
  },
  {
    title: 'How does team access work?',
    content:
      'Nyx supports role-based access with developer and non-developer roles. Team admins can invite members, manage permissions, and configure integration settings from the Settings page.',
  },
];

interface ExampleProject {
  title: string;
  description: string;
  tags: string[];
  specSnippet: string;
}

const exampleProjects: ExampleProject[] = [
  {
    title: 'User Authentication Flow',
    description:
      'A complete spec for implementing OAuth-based authentication with email/password fallback.',
    tags: ['Auth', 'Backend', 'Security'],
    specSnippet: `## User Authentication

### Overview
Implement a multi-provider authentication system supporting OAuth 2.0 (Google, GitHub) and email/password credentials.

### Requirements
- Users can sign up and log in via Google or GitHub OAuth
- Email/password registration with email verification
- JWT-based session management with refresh tokens
- Rate limiting on login endpoints (5 attempts per minute)`,
  },
  {
    title: 'REST API Endpoint Design',
    description: 'Spec for a CRUD API covering resources, pagination, filtering, and error handling.',
    tags: ['API', 'Backend', 'REST'],
    specSnippet: `## Products API

### Endpoints
- GET /api/products — List products (paginated)
- GET /api/products/:id — Get single product
- POST /api/products — Create product
- PATCH /api/products/:id — Update product
- DELETE /api/products/:id — Soft-delete product

### Pagination
All list endpoints return \`{ data, meta: { page, perPage, total } }\`.`,
  },
  {
    title: 'Dashboard UI Component',
    description: 'A frontend spec for a real-time dashboard with charts, filters, and data export.',
    tags: ['Frontend', 'UI', 'Data Viz'],
    specSnippet: `## Analytics Dashboard

### Components
- **MetricCards**: Display KPIs (revenue, users, conversion rate)
- **TimeSeriesChart**: Line chart with date range selector
- **FilterBar**: Filter by date range, product, and region
- **ExportButton**: Download data as CSV or PDF

### Behavior
- Auto-refresh every 30 seconds
- Loading skeleton while data fetches
- Graceful error state with retry button`,
  },
];

function TutorialTab() {
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

  const toggleStep = (index: number) => {
    setCompletedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const progress = Math.round((completedSteps.size / tutorialSteps.length) * 100);

  return (
    <div data-testid="tutorial-tab">
      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-slate-700">Getting started progress</span>
          <span className="text-sm text-slate-500" data-testid="tutorial-progress">
            {completedSteps.size}/{tutorialSteps.length} steps
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-slate-100">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-4">
        {tutorialSteps.map((step, i) => (
          <div
            key={i}
            className={`rounded-lg border p-4 transition-colors ${
              completedSteps.has(i)
                ? 'border-green-200 bg-green-50/50'
                : 'border-slate-200 bg-white'
            }`}
            data-testid={`tutorial-step-${i}`}
          >
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => toggleStep(i)}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                  completedSteps.has(i)
                    ? 'border-green-500 bg-green-500 text-white'
                    : 'border-slate-300 bg-white hover:border-blue-400'
                }`}
                aria-label={completedSteps.has(i) ? `Mark "${step.title}" incomplete` : `Mark "${step.title}" complete`}
              >
                {completedSteps.has(i) && (
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>
              <div className="flex-1">
                <h3
                  className={`text-sm font-semibold ${
                    completedSteps.has(i) ? 'text-green-700 line-through' : 'text-slate-900'
                  }`}
                >
                  {step.title}
                </h3>
                <p className="mt-1 text-sm text-slate-500">{step.description}</p>
                {step.link && !completedSteps.has(i) && (
                  <Link
                    to={step.link.to}
                    className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-800"
                  >
                    {step.link.label}
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  </Link>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HelpTab() {
  const [expandedTopic, setExpandedTopic] = useState<number | null>(null);

  return (
    <div className="space-y-3" data-testid="help-tab">
      {helpTopics.map((topic, i) => (
        <div key={i} className="rounded-lg border border-slate-200 bg-white" data-testid={`help-topic-${i}`}>
          <button
            type="button"
            onClick={() => setExpandedTopic(expandedTopic === i ? null : i)}
            className="flex w-full items-center justify-between p-4 text-left"
            aria-expanded={expandedTopic === i}
          >
            <span className="text-sm font-semibold text-slate-900">{topic.title}</span>
            <svg
              className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
                expandedTopic === i ? 'rotate-180' : ''
              }`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
          {expandedTopic === i && (
            <div className="border-t border-slate-100 px-4 pb-4 pt-3">
              <p className="text-sm text-slate-600 leading-relaxed">{topic.content}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ExamplesTab() {
  return (
    <div className="space-y-6" data-testid="examples-tab">
      {exampleProjects.map((example, i) => (
        <div key={i} className="rounded-lg border border-slate-200 bg-white p-5" data-testid={`example-${i}`}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">{example.title}</h3>
              <p className="mt-1 text-sm text-slate-500">{example.description}</p>
            </div>
            <div className="flex gap-1.5 shrink-0">
              {example.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md bg-slate-50 border border-slate-100 p-3">
            <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono leading-relaxed">
              {example.specSnippet}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}

export function GettingStarted() {
  const [activeTab, setActiveTab] = useState<Tab>('tutorial');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'tutorial', label: 'Tutorial' },
    { id: 'help', label: 'Help & FAQ' },
    { id: 'examples', label: 'Examples' },
  ];

  return (
    <div data-testid="getting-started-page">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Getting Started</h1>
        <p className="mt-1 text-sm text-slate-500">
          Learn how to use Nyx to keep your specs and code in sync.
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-slate-200">
        <nav className="flex gap-6" aria-label="Getting started tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`relative pb-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-blue-600'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              data-testid={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              role="tab"
            >
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="max-w-3xl">
        {activeTab === 'tutorial' && <TutorialTab />}
        {activeTab === 'help' && <HelpTab />}
        {activeTab === 'examples' && <ExamplesTab />}
      </div>
    </div>
  );
}
