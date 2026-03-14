import Anthropic from '@anthropic-ai/sdk';
import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { feedbackSubmissions } from '../db/schema.js';
import { config } from '../lib/config.js';

const MODEL = 'claude-sonnet-4-20250514';

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

function requireClient(): Anthropic {
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is not configured. AI features require a valid API key.');
  }
  return client;
}

const GITHUB_API = 'https://api.github.com';

export interface FormattedFeedback {
  title: string;
  body: string;
  category: string;
}

export const feedbackService = {
  async formatFeedback(rawMessage: string): Promise<FormattedFeedback> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `You are a product feedback formatter for SyncDocs, a documentation versioning platform. Given raw user feedback, create a well-structured GitHub issue. Respond ONLY with valid JSON in this exact format: {"title": "<concise descriptive title>", "body": "<structured markdown body with sections: Description, Current Behavior (if applicable), Suggested Improvement, Impact>", "category": "<one of: bug, feature-request, ux-improvement, documentation, other>"}

Rules:
- Keep the title under 80 characters
- Preserve the user's original intent without embellishing
- Use professional but approachable language
- Add appropriate context sections based on the feedback type
- The body should be markdown formatted`,
      messages: [
        {
          role: 'user',
          content: `Format this user feedback into a GitHub issue:\n\n${rawMessage}`,
        },
      ],
    });

    let text = response.content[0].type === 'text' ? response.content[0].text : '';
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as FormattedFeedback;
      return {
        title: parsed.title || 'User Feedback',
        body: parsed.body || rawMessage,
        category: parsed.category || 'other',
      };
    } catch {
      return {
        title: 'User Feedback',
        body: rawMessage,
        category: 'other',
      };
    }
  },

  async checkRateLimit(userId: string): Promise<{ allowed: boolean; remaining: number }> {
    const MAX_PER_DAY = 5;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(feedbackSubmissions)
      .where(
        and(
          eq(feedbackSubmissions.userId, userId),
          gte(feedbackSubmissions.createdAt, oneDayAgo),
        ),
      );

    const count = result[0]?.count ?? 0;
    return {
      allowed: count < MAX_PER_DAY,
      remaining: Math.max(0, MAX_PER_DAY - count),
    };
  },

  async submitToGitHub(
    title: string,
    body: string,
    category: string,
    userName: string,
    userEmail: string,
  ): Promise<{ issueUrl: string; issueNumber: number }> {
    const token = config.GITHUB_FEEDBACK_PAT;
    if (!token) {
      throw new Error('GITHUB_FEEDBACK_PAT is not configured. Feedback submission requires a GitHub PAT.');
    }

    const fullBody = `${body}\n\n---\n_Submitted by: ${userName} (${userEmail})_\n_Category: ${category}_\n_Submitted via SyncDocs feedback_`;

    const res = await fetch(`${GITHUB_API}/repos/NoJuanNobody/syncdocs/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title,
        body: fullBody,
        labels: ['feedback', category],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${errBody}`);
    }

    const issue = (await res.json()) as { html_url: string; number: number };
    return { issueUrl: issue.html_url, issueNumber: issue.number };
  },

  async saveFeedback(
    userId: string,
    rawMessage: string,
    formattedTitle: string,
    formattedBody: string,
    category: string,
    githubIssueUrl?: string,
    githubIssueNumber?: number,
  ) {
    const [record] = await db
      .insert(feedbackSubmissions)
      .values({
        userId,
        rawMessage,
        formattedTitle,
        formattedBody,
        category,
        githubIssueUrl: githubIssueUrl ?? null,
        githubIssueNumber: githubIssueNumber ?? null,
      })
      .returning();

    return record;
  },
};
