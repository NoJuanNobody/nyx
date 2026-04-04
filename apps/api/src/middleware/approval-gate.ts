import type { FastifyRequest, FastifyReply } from 'fastify';
import { approvalService } from '../services/approval.service.js';

export interface ApprovalGateOptions {
  /** The action identifier that requires approval (e.g. 'delete_document', 'disconnect_integration'). */
  action: string;

  /**
   * How to resolve the resource ID from the request.
   * Defaults to `params.id`.
   */
  resolveResourceId?: (request: FastifyRequest) => string | undefined;

  /**
   * How to resolve the team ID from the request.
   * Defaults to params.teamId, query.teamId, or body.teamId.
   */
  resolveTeamId?: (request: FastifyRequest) => string | undefined;
}

function defaultResolveResourceId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string>;
  return params.id ?? params.resourceId;
}

function defaultResolveTeamId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string>;
  const query = request.query as Record<string, string>;
  const body = (request.body ?? {}) as Record<string, unknown>;

  return params.teamId ?? query.teamId ?? (body.teamId as string | undefined);
}

/**
 * Fastify preHandler that blocks destructive actions unless an approved approval exists.
 *
 * If no approval exists, it creates a pending one and returns 202 Accepted.
 * If a pending approval exists, it returns 202 with the approval details.
 * If an approved approval exists, the request proceeds.
 * If the approval is rejected or expired, it returns 403.
 *
 * Usage:
 * ```ts
 * app.delete('/:id', {
 *   preHandler: [requireApproval({ action: 'delete_document' })],
 * }, handler);
 * ```
 */
export function requireApproval(options: ApprovalGateOptions) {
  const {
    action,
    resolveResourceId = defaultResolveResourceId,
    resolveTeamId = defaultResolveTeamId,
  } = options;

  return async function checkApproval(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const userId = request.user?.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    const resourceId = resolveResourceId(request);
    if (!resourceId) {
      return reply.code(400).send({ error: 'Unable to resolve resource for approval check' });
    }

    const teamId = resolveTeamId(request);
    if (!teamId) {
      return reply.code(400).send({ error: 'Unable to determine team context for approval check' });
    }

    const existing = await approvalService.check(action, resourceId, teamId);

    if (existing) {
      switch (existing.status) {
        case 'approved':
          // Approval granted — let the request proceed
          return;
        case 'pending': {
          // Check if it has expired
          if (existing.expiresAt < new Date()) {
            return reply.code(403).send({
              error: 'Approval request has expired. Please create a new one.',
              approval: { id: existing.id, status: 'expired', action },
            });
          }
          return reply.code(202).send({
            message: 'Action is awaiting approval.',
            approval: { id: existing.id, status: 'pending', action, resourceId, expiresAt: existing.expiresAt },
          });
        }
        case 'rejected':
          return reply.code(403).send({
            error: 'This action was rejected.',
            approval: { id: existing.id, status: 'rejected', action, reason: existing.reason },
          });
        case 'expired':
          // Expired — fall through to create a new one
          break;
      }
    }

    // No valid approval exists — create a pending one
    const approval = await approvalService.create({
      action,
      resourceId,
      requestedById: userId,
      teamId,
    });

    return reply.code(202).send({
      message: 'This action requires approval. A request has been created.',
      approval: { id: approval.id, status: 'pending', action, resourceId, expiresAt: approval.expiresAt },
    });
  };
}
