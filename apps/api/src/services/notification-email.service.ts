import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { emailDeliveryLog, notifications } from '../db/schema.js';
import { sendEmail } from './email.js';

// ── HTML Builders ────────────────────────────────────────────────

export function buildNotificationEmail(
  title: string,
  body: string,
  ctaUrl?: string,
  ctaText?: string,
): string {
  const ctaBlock = ctaUrl
    ? `<a href="${ctaUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:24px 0;">${ctaText ?? 'View in Nyx'}</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="background:#1a1a2e;padding:20px 24px;border-radius:12px 12px 0 0;">
      <span style="color:#a78bfa;font-weight:700;font-size:18px;">Nyx</span>
    </div>
    <div style="background:#16162a;padding:24px;border-radius:0 0 12px 12px;">
      <h2 style="color:#e2e8f0;margin:0 0 12px;">${title}</h2>
      <p style="color:#94a3b8;line-height:1.6;margin:0 0 16px;">${body}</p>
      ${ctaBlock}
      <p style="color:#475569;font-size:12px;margin-top:32px;">You received this because of your notification settings in Nyx.</p>
    </div>
  </div>
</body>
</html>`;
}

export function buildDigestEmail(
  items: { title: string; body: string; eventType: string }[],
): string {
  const grouped = new Map<string, typeof items>();
  for (const item of items) {
    const list = grouped.get(item.eventType) ?? [];
    list.push(item);
    grouped.set(item.eventType, list);
  }

  let sections = '';
  for (const [eventType, group] of grouped) {
    const label = eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    let rows = '';
    for (const item of group) {
      rows += `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #1e293b;">
            <strong style="color:#e2e8f0;">${item.title}</strong>
            <br/><span style="color:#94a3b8;font-size:13px;">${item.body}</span>
          </td>
        </tr>`;
    }
    sections += `
      <h3 style="color:#a78bfa;margin:24px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;">${label} (${group.length})</h3>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="background:#1a1a2e;padding:20px 24px;border-radius:12px 12px 0 0;">
      <span style="color:#a78bfa;font-weight:700;font-size:18px;">Nyx</span>
      <span style="color:#64748b;margin-left:8px;font-size:14px;">Notification Digest</span>
    </div>
    <div style="background:#16162a;padding:24px;border-radius:0 0 12px 12px;">
      <p style="color:#94a3b8;margin:0 0 8px;">Here's a summary of what happened since your last digest:</p>
      ${sections}
      <p style="color:#475569;font-size:12px;margin-top:32px;">You received this because of your notification settings in Nyx.</p>
    </div>
  </div>
</body>
</html>`;
}

// ── Types ────────────────────────────────────────────────────────

interface NotificationRow {
  id: string;
  userId: string;
  title: string;
  body: string | null;
  eventType: string;
}

interface PreferenceRow {
  emailEnabled: boolean;
  emailMode: 'instant' | 'daily' | 'weekly' | 'off';
}

// ── Service ─────────────────────────────────────────────────────

class NotificationEmailService {
  /**
   * Decide whether to send immediately, queue for digest, or skip.
   */
  async queueOrSend(
    notification: NotificationRow,
    userEmail: string,
    preference: PreferenceRow,
  ): Promise<void> {
    // Skip if email is off
    if (preference.emailMode === 'off' || !preference.emailEnabled) {
      return;
    }

    if (preference.emailMode === 'instant') {
      await this.sendImmediate(notification, userEmail);
    } else {
      // daily or weekly → queue
      await this.queueForDigest(notification);
    }
  }

  /**
   * Fetch all queued entries for a user, build a digest, send, and mark sent.
   */
  async sendDigest(userId: string, userEmail: string): Promise<void> {
    // Fetch queued log entries joined with notifications
    const queued = await db
      .select({
        logId: emailDeliveryLog.id,
        notificationId: emailDeliveryLog.notificationId,
        title: notifications.title,
        body: notifications.body,
        eventType: notifications.eventType,
      })
      .from(emailDeliveryLog)
      .innerJoin(notifications, eq(emailDeliveryLog.notificationId, notifications.id))
      .where(
        and(
          eq(emailDeliveryLog.userId, userId),
          eq(emailDeliveryLog.status, 'queued'),
        ),
      );

    if (!queued.length) return;

    const items = queued.map((row) => ({
      title: row.title,
      body: row.body ?? '',
      eventType: row.eventType,
    }));

    const html = buildDigestEmail(items);
    const success = await sendEmail({
      to: userEmail,
      subject: `Nyx digest — ${items.length} notification${items.length > 1 ? 's' : ''}`,
      html,
    });

    const newStatus = success ? 'sent' as const : 'failed' as const;
    const logIds = queued.map((r) => r.logId);

    for (const logId of logIds) {
      await db
        .update(emailDeliveryLog)
        .set({ status: newStatus, sentAt: new Date() })
        .where(eq(emailDeliveryLog.id, logId));
    }
  }

  // ── Internal helpers ────────────────────────────────────────────

  private async sendImmediate(
    notification: NotificationRow,
    userEmail: string,
  ): Promise<void> {
    const html = buildNotificationEmail(
      notification.title,
      notification.body ?? '',
    );

    const success = await sendEmail({
      to: userEmail,
      subject: notification.title,
      html,
    });

    await db.insert(emailDeliveryLog).values({
      notificationId: notification.id,
      userId: notification.userId,
      status: success ? 'sent' : 'failed',
      sentAt: success ? new Date() : null,
    });
  }

  private async queueForDigest(notification: NotificationRow): Promise<void> {
    await db.insert(emailDeliveryLog).values({
      notificationId: notification.id,
      userId: notification.userId,
      status: 'queued',
    });
  }
}

export const notificationEmailService = new NotificationEmailService();
