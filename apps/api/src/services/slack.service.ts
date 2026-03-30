import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { slackConnections } from '../db/schema.js';
import { decrypt } from '../lib/encryption.js';

/**
 * Verify a Slack request signature using the signing secret.
 * See: https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signature: string,
  timestamp: string,
  body: string,
  signingSecret: string,
): boolean {
  // Prevent replay attacks — reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Process a Slack message through intake. Logs the message, creates a
 * structured summary, and returns a result that callers can relay back
 * to Slack or store for auditing.
 */
export async function processSlackMessage(
  text: string,
  teamId: string,
  userId: string,
  channelId: string,
): Promise<{ summary: string; source: string; documentId?: string }> {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      summary: 'Empty message — nothing to process.',
      source: 'slack',
    };
  }

  // Log the inbound message for observability
  console.info('[slack-intake]', {
    teamId,
    userId,
    channelId,
    textLength: trimmed.length,
    preview: trimmed.substring(0, 80),
  });

  // Build a structured summary from the Slack message.
  // Future enhancement: route through intakeService.processRawInput() to
  // generate a full structured spec via AI when the Anthropic key is available.
  const summary = `Slack message from user ${userId} in channel ${channelId}: "${trimmed.substring(0, 120)}"`;

  return {
    summary,
    source: 'slack',
  };
}

/**
 * Send a response back to Slack via a response_url.
 */
export async function sendSlackResponse(
  responseUrl: string,
  message: { text?: string; blocks?: unknown[]; response_type?: string },
): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
}

/**
 * Send a message to a Slack channel using the Bot token stored for a team.
 * Decrypts the stored token before calling the Slack API.
 */
export async function sendSlackChannelMessage(
  teamId: string,
  channel: string,
  text: string,
): Promise<boolean> {
  const connections = await db
    .select()
    .from(slackConnections)
    .where(eq(slackConnections.teamId, teamId));

  if (connections.length === 0) {
    return false;
  }

  const connection = connections[0];

  let botToken: string;
  try {
    botToken = decrypt(connection.slackBotToken);
  } catch {
    console.error('[slack] Failed to decrypt bot token for team', teamId);
    return false;
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text }),
  });

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    console.error('[slack] chat.postMessage failed:', data.error);
    return false;
  }

  return true;
}

export const slackService = {
  verifySlackSignature,
  processSlackMessage,
  sendSlackResponse,
  sendSlackChannelMessage,
};
