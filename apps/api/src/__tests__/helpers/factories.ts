/**
 * Data factories for test fixtures.
 */
import { randomUUID } from 'node:crypto';

export function makeUser(overrides?: Partial<ReturnType<typeof makeUser>>) {
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

export function makeTeam(overrides?: Partial<ReturnType<typeof makeTeam>>) {
  return {
    id: randomUUID(),
    name: 'Test Team',
    slug: `team-${randomUUID().slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeDocument(overrides?: Partial<ReturnType<typeof makeDocument>>) {
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

export function makeIntegration(overrides?: Partial<ReturnType<typeof makeIntegration>>) {
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

export function makeTicket(overrides?: Partial<ReturnType<typeof makeTicket>>) {
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

export function makeTeamMember(overrides?: Partial<ReturnType<typeof makeTeamMember>>) {
  return {
    id: randomUUID(),
    teamId: randomUUID(),
    userId: randomUUID(),
    role: 'developer' as const,
    joinedAt: new Date(),
    ...overrides,
  };
}

export function makeVersion(overrides?: Partial<ReturnType<typeof makeVersion>>) {
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

export function makeChangeProposal(overrides?: Partial<ReturnType<typeof makeChangeProposal>>) {
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

export function makeInvitation(overrides?: Partial<ReturnType<typeof makeInvitation>>) {
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
