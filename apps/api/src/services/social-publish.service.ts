import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { socialPosts } from '../db/schema.js';

export type SocialPlatform = 'twitter' | 'linkedin';
export type SocialPostStatus = 'draft' | 'published' | 'failed';

const TWITTER_MAX_LENGTH = 280;
const LINKEDIN_MAX_LENGTH = 3000;

export interface PublishResult {
  postUrl: string;
  platform: SocialPlatform;
  status: SocialPostStatus;
}

function validateContent(content: string, maxLength: number, platformName: string): void {
  if (!content || !content.trim()) {
    throw new Error('Content is required');
  }
  if (content.length > maxLength) {
    throw new Error(
      `Content exceeds ${platformName} character limit of ${maxLength} (got ${content.length})`,
    );
  }
}

export const socialPublishService = {
  /**
   * Publish content to Twitter (stub).
   * Validates the 280-character limit and returns a mock post URL.
   */
  async publishToTwitter(content: string, accessToken: string): Promise<PublishResult> {
    validateContent(content, TWITTER_MAX_LENGTH, 'Twitter');

    if (!accessToken) {
      throw new Error('Access token is required for Twitter publishing');
    }

    // Stub: in production this would call the Twitter/X API
    const mockId = Math.random().toString(36).substring(2, 15);
    return {
      postUrl: `https://twitter.com/i/status/${mockId}`,
      platform: 'twitter',
      status: 'published',
    };
  },

  /**
   * Publish content to LinkedIn (stub).
   * Validates the 3000-character limit and returns a mock post URL.
   */
  async publishToLinkedIn(content: string, accessToken: string): Promise<PublishResult> {
    validateContent(content, LINKEDIN_MAX_LENGTH, 'LinkedIn');

    if (!accessToken) {
      throw new Error('Access token is required for LinkedIn publishing');
    }

    // Stub: in production this would call the LinkedIn API
    const mockId = Math.random().toString(36).substring(2, 15);
    return {
      postUrl: `https://www.linkedin.com/feed/update/urn:li:share:${mockId}`,
      platform: 'linkedin',
      status: 'published',
    };
  },

  /**
   * Dispatch publishing to the correct platform handler.
   */
  async publish(
    platform: SocialPlatform,
    content: string,
    accessToken: string,
  ): Promise<PublishResult> {
    switch (platform) {
      case 'twitter':
        return this.publishToTwitter(content, accessToken);
      case 'linkedin':
        return this.publishToLinkedIn(content, accessToken);
      default:
        throw new Error(`Unsupported platform: ${platform as string}`);
    }
  },

  /**
   * Persist a social post record to the database.
   */
  async savePost(
    documentId: string,
    platform: SocialPlatform,
    content: string,
    status: SocialPostStatus,
    postUrl?: string | null,
  ) {
    const [record] = await db
      .insert(socialPosts)
      .values({
        documentId,
        platform,
        content,
        status,
        postUrl: postUrl ?? null,
        publishedAt: status === 'published' ? new Date() : null,
      })
      .returning();

    return record;
  },

  /**
   * Return publish history for a given document, newest first.
   */
  async getPublishHistory(documentId: string) {
    return db
      .select()
      .from(socialPosts)
      .where(eq(socialPosts.documentId, documentId))
      .orderBy(desc(socialPosts.createdAt));
  },
};
