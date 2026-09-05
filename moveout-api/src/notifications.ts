import type { Env } from './types';

/**
 * Notification layer.
 *
 * No SMS provider is chosen yet, and this build deliberately adds no paid
 * dependency. Every confirmation that should go out is written to
 * `notification_outbox` with status PENDING. When a provider is picked, add a
 * NotificationSender that drains that table (a Worker cron, or a call at the end
 * of submit) — nothing else in the codebase has to change.
 *
 * Rule that must survive any future change: a notification failure must never
 * fail the submission. Callers use `recordNotification`, which swallows its own
 * errors; the customer's move-out is already saved by the time it runs.
 */
export interface OutgoingMessage {
  requestId: string;
  channel: 'SMS' | 'EMAIL';
  recipient: string;
  body: string;
}

export interface SendResult {
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  provider?: string;
  providerRef?: string;
  error?: string;
}

export interface NotificationSender {
  readonly name: string;
  send(message: OutgoingMessage): Promise<SendResult>;
}

/**
 * The only sender wired up today. It sends nothing and says so, which leaves the
 * outbox row PENDING for a real provider to pick up later.
 */
export class OutboxOnlySender implements NotificationSender {
  readonly name = 'outbox-only';
  async send(_message: OutgoingMessage): Promise<SendResult> {
    return { status: 'SKIPPED', provider: this.name, error: 'No SMS provider configured yet' };
  }
}

export function getSender(_env: Env): NotificationSender {
  // When a provider is chosen, select it here from env (e.g. env.SMS_PROVIDER).
  return new OutboxOnlySender();
}

export function scheduledNoticeBody(name: string, dateLabel: string, facility: string): string {
  return `${facility}: thanks ${name} — we have your move-out notice for ${dateLabel}. When the unit is empty, swept and your lock is off, go back to the Move Out page and choose "I've Already Moved Out" to send photos.`;
}

export function completedBody(unit: string, dateLabel: string, facility: string): string {
  return `${facility}: we received your move-out for Unit ${unit} on ${dateLabel}. We'll review your photos and be in touch if anything else is needed. Please leave the door unlocked with your padlock off.`;
}

/**
 * Records that a confirmation should be sent, and attempts a send if a real
 * provider is configured. Never throws — the submission has already succeeded.
 */
export async function recordNotification(env: Env, message: OutgoingMessage): Promise<void> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO notification_outbox (id, request_id, channel, recipient, body, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
    ).bind(id, message.requestId, message.channel, message.recipient, message.body, now, now).run();
  } catch (err) {
    console.error('notification_outbox insert failed', { requestId: message.requestId, err: String(err) });
    return;
  }

  const sender = getSender(env);
  try {
    const result = await sender.send(message);
    await env.DB.prepare(
      `UPDATE notification_outbox
          SET status = ?, attempts = attempts + 1, provider = ?, provider_ref = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(
      result.status === 'SENT' ? 'SENT' : result.status === 'FAILED' ? 'FAILED' : 'PENDING',
      result.provider ?? null,
      result.providerRef ?? null,
      result.error ?? null,
      new Date().toISOString(),
      id,
    ).run();
  } catch (err) {
    console.error('notification send failed', { requestId: message.requestId, err: String(err) });
  }
}
