import { config } from '../lib/config.js';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (!config.RESEND_API_KEY) {
    console.log(`[email] Skipping email (no RESEND_API_KEY): to=${options.to}, subject=${options.subject}`);
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.EMAIL_FROM || 'Nyx <noreply@nyx.dev>',
        to: options.to,
        subject: options.subject,
        html: options.html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[email] Failed to send: ${err}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[email] Error sending email:', err);
    return false;
  }
}

export function buildInviteEmail(teamName: string, inviterName: string, token: string): { subject: string; html: string } {
  const appUrl = config.APP_URL || 'http://localhost:5173';
  const acceptUrl = `${appUrl}/invite/${token}`;

  return {
    subject: `You've been invited to join ${teamName} on Nyx`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1a1a2e; margin-bottom: 8px;">You're invited to join ${teamName}</h2>
        <p style="color: #555; line-height: 1.6;">
          ${inviterName} has invited you to collaborate on <strong>${teamName}</strong> in Nyx.
        </p>
        <a href="${acceptUrl}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; margin: 24px 0;">
          Accept Invitation
        </a>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
        </p>
      </div>
    `,
  };
}
