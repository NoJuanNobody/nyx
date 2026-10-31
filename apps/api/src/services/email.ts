import { config } from '../lib/config.js';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  inviteRedirectUrl?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (config.RESEND_API_KEY) {
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

      if (res.ok) {
        return true;
      }

      const err = await res.text();
      console.error(`[email] Resend failed (${res.status}): ${err}`);
    } catch (err) {
      console.error('[email] Error sending email via Resend:', err);
    }
  } else {
    console.log(`[email] No RESEND_API_KEY configured for to=${options.to}`);
  }

  // Fallback for team invitations: send via Clerk Backend Invitations API
  if (options.inviteRedirectUrl && config.CLERK_SECRET_KEY) {
    try {
      const clerkRes = await fetch('https://api.clerk.com/v1/invitations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.CLERK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email_address: options.to.trim().toLowerCase(),
          redirect_url: options.inviteRedirectUrl,
          ignore_existing: true,
        }),
      });

      if (clerkRes.ok) {
        return true;
      }

      const clerkErr = await clerkRes.text();
      console.error(`[email] Clerk invitation fallback failed (${clerkRes.status}): ${clerkErr}`);
    } catch (err) {
      console.error('[email] Error sending invite via Clerk fallback:', err);
    }
  }

  return false;
}

export function buildInviteEmail(
  teamName: string,
  inviterName: string,
  token: string,
): { subject: string; html: string; acceptUrl: string } {
  const baseUrl = (config.FRONTEND_URL || config.APP_URL || 'https://nyx-creative.com').replace(/\/$/, '');
  const acceptUrl = `${baseUrl}/invite/${token}`;

  return {
    acceptUrl,
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
