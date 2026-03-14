import { createHmac, timingSafeEqual } from 'node:crypto';

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
 * Process a Slack message through intake. Returns a structured summary.
 * This is a placeholder that formats the message for processing.
 * A real implementation would route through the Chaos Ingestion pipeline.
 */
export async function processSlackMessage(
  text: string,
  teamId: string,
  userId: string,
  channelId: string,
): Promise<{ summary: string; source: string }> {
  return {
    summary: `Received from Slack user ${userId} in channel ${channelId}: ${text}`,
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

export const slackService = {
  verifySlackSignature,
  processSlackMessage,
  sendSlackResponse,
};
