/**
 * Centralized selectors for E2E tests.
 * No data-testid attributes in the app — uses text, role, and structure selectors.
 */

export const SEL = {
  // ── Sidebar ──────────────────────────────────────────
  sidebar: {
    logo: 'a:has-text("SyncDocs")',
    boardLink: 'a:has-text("Board")',
    settingsLink: 'a:has-text("Settings")',
    teamSwitcher: 'aside select',
    signOutButton: 'aside button[title="Sign out"]',
    themeToggle: 'button[title*="Theme"]',
    userName: 'aside .text-xs.font-medium',
    explorerHeader: 'text=Explorer',
    newDocButton: 'button[title="New document"]',
    newFolderButton: 'button[title="New folder"]',
    mobileToggle: 'button[aria-label="Toggle sidebar"]',
  },

  // ── File Tree ────────────────────────────────────────
  fileTree: {
    docLink: (id: string) => `a[href="/documents/${id}"]`,
    trashToggle: 'button:has-text("Trash")',
  },

  // ── Dashboard ────────────────────────────────────────
  dashboard: {
    title: 'h1:has-text("Dashboard")',
    newDocButton: 'button:has-text("New Document")',
    docRow: 'a[href*="/documents/"]',
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
      docItem: 'main ul a[href*="/documents/"]',
    },
  },

  // ── Document Editor ──────────────────────────────────
  editor: {
    titleInput: 'input[type="text"]',
    textarea: 'textarea',
    saveVersionButton: 'button:has-text("Save Version")',
    saveStateIndicator: 'text=/Saved|Saving|Unsaved/',
    // Layout tabs
    markdownTab: 'button:has-text("Markdown")',
    splitTab: 'button:has-text("Split")',
    previewTab: 'button:has-text("Preview")',
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
    aiTab: 'button[title="AI"]',
    aiEditTab: 'button[title="AI Edit"]',
    agentTab: 'button[title="Agent"]',
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
    revokeButton: 'main button:has-text("Revoke")',
  },

  // ── Board ────────────────────────────────────────────
  board: {
    title: 'h1:has-text("Board")',
    providerFilter: 'main select',
    syncAllButton: 'button:has-text("Sync All")',
    columnOpen: 'text=Open',
    columnInProgress: 'text=In Progress',
    columnClosed: 'text=Closed',
    ticketCard: 'div.rounded-lg.border',
  },

  // ── Repositories ────────────────────────────────────────
  repositories: {
    title: 'h1:has-text("Repositories")',
    repoRow: 'ul li',
    removeButton: 'button:has-text("Remove")',
    confirmYes: 'button:has-text("Yes")',
    confirmNo: 'button:has-text("No")',
  },

  // ── JSX Preview ───────────────────────────────────────
  jsxPreview: {
    tab: 'button:has-text("JSX Preview")',
    allStatesToggle: 'button:has-text("All States")',
    promptInput: 'textarea[placeholder*="Describe a UI"]',
    generateButton: 'button[title="Generate"]',
    previewPane: '.flex.min-h-0.flex-1 > div:last-child',
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

  // ── Landing ──────────────────────────────────────────
  landing: {
    heroTitle: 'h1',
    signInLink: 'a[href="/sign-in"]',
    emailInput: 'input[placeholder*="@"]',
    ctaButton: 'button:has-text("Get Early Access")',
    submittedMessage: "text=You're on the list",
  },
} as const;
