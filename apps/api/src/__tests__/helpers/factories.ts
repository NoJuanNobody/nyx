/**
 * Data factories for test fixtures.
 */
import { randomUUID } from 'node:crypto';

export function makeUser(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    clerkId: `clerk_${randomUUID().slice(0, 8)}`,
    email: `user-${randomUUID().slice(0, 6)}@test.com`,
    name: 'Test User',
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeTeam(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    name: 'Test Team',
    slug: `team-${randomUUID().slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeDocument(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    title: 'Test Document',
    content: '# Test\n\nSome content',
    path: '/',
    status: 'draft' as const,
    teamId: randomUUID(),
    createdById: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeIntegration(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    teamId: randomUUID(),
    type: 'github' as const,
    config: {
      accessToken: 'ghp_test_token',
      selectedRepos: [{ owner: 'testorg', name: 'testrepo', fullName: 'testorg/testrepo' }],
    },
    createdAt: new Date(),
    ...overrides,
  };
}

export function makeTicket(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    documentId: randomUUID(),
    provider: 'github' as const,
    externalId: '42',
    externalUrl: 'https://github.com/testorg/testrepo/issues/42',
    title: 'Test Ticket',
    status: 'open' as const,
    createdById: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeTeamMember(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    teamId: randomUUID(),
    userId: randomUUID(),
    role: 'developer' as const,
    joinedAt: new Date(),
    ...overrides,
  };
}

export function makeVersion(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    documentId: randomUUID(),
    version: 1,
    content: '# Test\n\nVersion content',
    message: null as string | null,
    createdById: randomUUID(),
    createdAt: new Date(),
    ...overrides,
  };
}

export function makeChangeProposal(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    documentId: randomUUID(),
    teamId: randomUUID(),
    createdById: randomUUID(),
    title: 'Test Proposal',
    description: 'A test change proposal',
    status: 'pending' as const,
    suggestedTickets: [
      { title: 'Ticket 1', description: 'Desc 1', priority: 'high', labels: ['bug'] },
    ],
    sourceVersions: [randomUUID()],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeTemplate(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    stage: 'definition' as const,
    name: 'Test Template',
    description: 'A test template',
    content: '# Template\n\nContent here',
    sortOrder: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

export function makeInvitation(overrides?: Record<string, unknown>) {
  const future = new Date();
  future.setDate(future.getDate() + 7);
  return {
    id: randomUUID(),
    teamId: randomUUID(),
    email: `invite-${randomUUID().slice(0, 6)}@test.com`,
    role: 'viewer' as const,
    invitedById: randomUUID(),
    status: 'pending' as const,
    createdAt: new Date(),
    expiresAt: future,
    ...overrides,
  };
}
