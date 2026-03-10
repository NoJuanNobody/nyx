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
    title: 'h1:has-text("Documents")',
    newDocButton: 'button:has-text("New Document")',
    docRow: 'a[href*="/documents/"]',
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

  // ── Landing ──────────────────────────────────────────
  landing: {
    heroTitle: 'h1',
    signInLink: 'a[href="/sign-in"]',
    emailInput: 'input[placeholder*="@"]',
    ctaButton: 'button:has-text("Get Early Access")',
    submittedMessage: "text=You're on the list",
  },
} as const;
