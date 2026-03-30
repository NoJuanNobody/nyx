import { z } from 'zod';

export const githubPushPayload = z.object({
  repository: z.object({
    full_name: z.string().optional(),
  }).optional(),
  ref: z.string().optional(),
  commits: z.array(z.object({
    id: z.string(),
    message: z.string(),
    author: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      username: z.string().optional(),
    }).optional(),
    added: z.array(z.string()).optional(),
    removed: z.array(z.string()).optional(),
    modified: z.array(z.string()).optional(),
  })).optional(),
});

export const githubIssuesPayload = z.object({
  action: z.string().optional(),
  issue: z.object({
    number: z.number(),
    state: z.string(),
  }).optional(),
  repository: z.object({
    full_name: z.string().optional(),
  }).optional(),
});

export const githubIssueCommentPayload = z.object({
  action: z.string().optional(),
  comment: z.object({
    id: z.number(),
    html_url: z.string(),
    body: z.string(),
    created_at: z.string(),
    user: z.object({
      login: z.string(),
      type: z.string(),
    }),
  }).optional(),
  issue: z.object({
    number: z.number(),
  }).optional(),
  repository: z.object({
    owner: z.object({
      login: z.string().optional(),
    }).optional(),
    name: z.string().optional(),
  }).optional(),
});
