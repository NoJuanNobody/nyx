/**
 * Centralized selectors for E2E tests.
 * No data-testid attributes in the app — uses text, role, and structure selectors.
 */

export const SEL = {
  // ── Sidebar ──────────────────────────────────────────
  sidebar: {
    logo: 'a:has-text("Nyx")',
    ticketsLink: 'a:has-text("Tickets")',
    settingsLink: 'a:has-text("Settings")',
    teamSwitcher: '[data-testid="team-switcher"]',
    signOutButton: 'aside button[title="Sign out"]',
    themeToggle: 'button[title*="Theme"]',
    userName: '[data-testid="user-name"]',
    explorerHeader: 'text=Explorer',
    newDocButton: 'button[title="New document"]',
    newFolderButton: 'button[title="New folder"]',
    mobileToggle: 'button[aria-label="Toggle sidebar"]',
    adminDocsLink: '[data-testid="admin-documents-link"]',
  },

  // ── File Tree ────────────────────────────────────────
  fileTree: {
    docLink: (id: string) => `a[href="/app/documents/${id}"]`,
  },

  // ── Dashboard ────────────────────────────────────────
  dashboard: {
    title: 'h1:has-text("Dashboard")',
    newDocButton: 'button:has-text("New Document")',
    docRow: 'a[href*="/app/documents/"]',
    aiPrompt: {
      textarea: 'main textarea[placeholder*="Ask AI"]',
      generateButton: 'main button:has-text("Generate")',
      chip: (text: string) => `main button:has-text("${text}")`,
      result: 'main .rounded-xl h3.mb-1',
      createDocButton: 'main button:has-text("Create doc from this")',
      loading: 'main button:has-text("Generating")',
    },
    phases: {
      card: (stage: string) => `main .grid > div:has(h3:has-text("${stage}"))`,
      createButton: (stage: string) => `main .grid > div:has(h3:has-text("${stage}")) button:has-text("Create")`,
    },
    recentDocs: {
      section: 'main h2:has-text("Recent Documents")',
      viewAllLink: 'main a:has-text("View all")',
      docItem: 'main ul a[href*="/app/documents/"]',
    },
  },

  // ── Document Editor ──────────────────────────────────
  editor: {
    titleInput: 'input[type="text"]',
    textarea: 'textarea',
    saveVersionButton: 'button[title="Save Version"]',
    saveStateIndicator: 'text=/Saved|Saving|Unsaved/',
    // Layout tabs
    markdownTab: 'button:has-text("Markdown")',
    splitTab: 'button:has-text("Split")',
    previewTab: 'button:text-is("Preview")',
    // Preview pane
    previewPane: '.prose',
    // Toolbar buttons
    toolbarBold: 'button[title*="Bold"]',
    toolbarItalic: 'button[title*="Italic"]',
    toolbarHeading: 'button:has-text("H")',
    toolbarCode: 'button[title*="Inline code"]',
    toolbarCodeBlock: 'button:has-text("{}")',
    toolbarLink: 'button[title*="Link"]',
    // Version modal
    versionModal: '.fixed.inset-0 > div',
    versionMessageInput: 'input[placeholder*="Version message"]',
    // Drawer
    drawerClose: 'button[aria-label="Close panel"]',
    // Version viewing banner
    versionBanner: 'text=Viewing version',
    restoreButton: 'button:has-text("Restore this version")',
    backToCurrentButton: 'button:has-text("Back to current")',
  },

  // ── Drawer Tabs (icon buttons in the editor header) ──
  drawer: {
    historyTab: 'button[title="History"]',
    timelineTab: 'button[title="Timeline"]',
    proposalsTab: 'button[title="Proposals"]',
    auditTab: 'button[title="Audit"]',
    aiEditTab: 'button[title="AI Edit"]',
    agentTab: 'button[title="Agent"]',
    impactTab: 'button[title="Impact"]',
  },

  // ── Settings ─────────────────────────────────────────
  settings: {
    teamTab: 'main nav button:has-text("Team")',
    integrationsTab: 'main nav button:has-text("Integrations")',
    apiKeysTab: 'main nav button:has-text("API Keys")',
    accountTab: 'main nav button:has-text("Account")',
    // Team panel — scope to main to avoid sidebar collisions
    inviteEmailInput: 'main input[placeholder*="@"]',
    inviteRoleSelect: 'main div:has(> input[placeholder*="@"]) > select',
    inviteButton: 'main button:has-text("Invite")',
    // Account panel
    displayNameInput: 'main input[type="text"]',
    emailInput: 'main input[type="email"]',
    saveChangesButton: 'main button:has-text("Save changes")',
    deleteAccountButton: 'main button:has-text("Delete")',
    // API Keys
    keyNameInput: 'main input[placeholder*="Key name"]',
    createKeyButton: 'main button:has-text("Create")',
    copyKeyButton: 'main [data-testid="copy-api-key"]',
    revokeButton: 'main button:has-text("Revoke")',
  },

  // ── Tickets ────────────────────────────────────────────
  tickets: {
    title: '[data-testid="tickets-title"]',
    tabGenerated: '[data-testid="tickets-tab-generated"]',
    tabPosted: '[data-testid="tickets-tab-posted"]',
    generatedTab: '[data-testid="tickets-generated-tab"]',
    postedTab: '[data-testid="tickets-posted-tab"]',
    destinationSelector: '[data-testid="tickets-destination-selector"]',
    postButton: '[data-testid="tickets-post-button"]',
    providerFilter: '[data-testid="tickets-provider-filter"]',
    statusFilter: '[data-testid="tickets-status-filter"]',
    syncAllButton: '[data-testid="tickets-sync-button"]',
  },

  // ── Claude Insights ───────────────────────────────────
  claudeInsight: {
    panel: 'div.rounded.border.border-purple-100',
    toggleButton: 'div.rounded.border.border-purple-100 > button',
    title: 'div.rounded.border.border-purple-100 span.font-semibold',
    summaryItems: 'div.rounded.border.border-purple-100 ul li',
    viewCommentLink: 'a:has-text("View comment")',
    refreshButton: 'button:has-text("Refresh")',
    fetchButton: 'button:has-text("Fetch")',
    noInsightLabel: 'text=No Claude insight',
    filesSection: 'p:has-text("Files")',
  },

  // ── Repositories ────────────────────────────────────────
  repositories: {
    title: 'h1:has-text("Repositories")',
    repoRow: 'ul li',
    removeButton: 'button:has-text("Remove")',
    confirmYes: 'button:has-text("Yes")',
    confirmNo: 'button:has-text("No")',
    manageReposButton: '[data-testid="manage-repos-button"]',
  },

  // ── Feedback ──────────────────────────────────────────
  feedback: {
    sidebarButton: 'button[data-testid="feedback-button"]',
    input: '[data-testid="feedback-input"]',
    formatButton: '[data-testid="feedback-format-btn"]',
    titleInput: '[data-testid="feedback-title"]',
    bodyInput: '[data-testid="feedback-body"]',
    submitButton: '[data-testid="feedback-submit-btn"]',
    githubLink: '[data-testid="feedback-github-link"]',
    successMessage: 'text=Thank you for your feedback',
    formattingSpinner: 'text=Formatting your feedback',
    submittingSpinner: 'text=Submitting your feedback',
  },

  // ── Invite Accept ──────────────────────────────────────
  invite: {
    teamName: '[data-testid="invite-team-name"]',
    role: '[data-testid="invite-role"]',
    acceptButton: '[data-testid="invite-accept-button"]',
    signUpButton: '[data-testid="invite-signup-button"]',
    status: '[data-testid="invite-status"]',
    error: '[data-testid="invite-error"]',
  },

  // ── Notifications ──────────────────────────────────────
  notifications: {
    bell: '[data-testid="notification-bell"]',
    badge: '[data-testid="notification-badge"]',
    panel: '[data-testid="notification-panel"]',
    item: '[data-testid="notification-item"]',
    markAllRead: '[data-testid="mark-all-read"]',
    filterAll: '[data-testid="filter-all"]',
    filterUnread: '[data-testid="filter-unread"]',
  },

  // ── Landing ──────────────────────────────────────────
  landing: {
    heroTitle: 'h1',
    signInLink: 'a[href="/sign-in"]',
    emailInput: 'input[placeholder*="@"]',
    ctaButton: 'button:has-text("Get Early Access")',
    submittedMessage: "text=You're on the list",
  },
} as const;
