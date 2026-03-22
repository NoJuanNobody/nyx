export const NotificationEvents = {
  DRIFT_DETECTED: 'drift.detected',
  TICKET_CREATED: 'ticket.created',
  TICKET_UPDATED: 'ticket.updated',
  CHANGE_PROPOSAL_SUBMITTED: 'change_proposal.submitted',
  CHANGE_PROPOSAL_APPROVED: 'change_proposal.approved',
  CHANGE_PROPOSAL_REJECTED: 'change_proposal.rejected',
  APPROVAL_REQUESTED: 'approval.requested',
  DOCUMENT_SHARED: 'document.shared',
  TEAM_INVITE: 'team.invite',
  SNAPSHOT_CREATED: 'snapshot.created',
  COMMENT_MENTION: 'comment.mention',
} as const;

export type NotificationEvent = (typeof NotificationEvents)[keyof typeof NotificationEvents];
