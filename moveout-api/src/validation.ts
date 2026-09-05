import { ALLOWED_IMAGE_TYPES, MAX_PHOTO_BYTES, MAX_PHOTOS, type PhotoSlot } from './types';

export interface Invalid {
  field: string;
  /** Shown to the customer verbatim. Plain language, never technical. */
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: Invalid[] };

/** Digits only, dropping a US country code. Used for storage and future rent-roll matching. */
export function normalisePhone(input: unknown): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function isValidPhone(input: unknown): boolean {
  const d = normalisePhone(input);
  // North American numbering plan: 10 digits, area and exchange codes start 2-9.
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d);
}

export function cleanName(input: unknown): string {
  return String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function cleanUnit(input: unknown): string {
  return String(input ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 24);
}

export function isValidUnit(input: unknown): boolean {
  const u = cleanUnit(input);
  return u.length >= 1 && u.length <= 24 && /^[A-Z0-9][A-Z0-9\-_.#/]*$/.test(u);
}

export function isIsoDate(input: unknown): boolean {
  const s = String(input ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Lease rules (notice period, permitted move-out days) are NOT decided yet, so
 * nothing here rejects a date for being too soon. The hook exists so those rules
 * can be added in one place without touching the wizard or the routes.
 *
 * `policy` is intentionally empty today. When the WI 64 lease is settled, fill in
 * minNoticeDays / allowedDays and the checks below start applying — the API
 * contract (errors[] with a field + human message) does not change.
 */
export interface NoticePolicy {
  minNoticeDays?: number;
  /** e.g. 'MONTH_END_ONLY' once the lease says so. */
  allowedDays?: 'ANY' | 'MONTH_END_ONLY';
}

export const CURRENT_NOTICE_POLICY: NoticePolicy = {};

export function checkPlannedDate(
  isoDate: string,
  now: Date,
  policy: NoticePolicy = CURRENT_NOTICE_POLICY,
): Invalid[] {
  const errors: Invalid[] = [];
  const target = new Date(isoDate + 'T00:00:00Z');
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');

  if (target.getTime() < today.getTime()) {
    errors.push({ field: 'plannedMoveOutDate', message: 'That date has already passed. Please choose a date from today onward.' });
    return errors;
  }

  if (policy.minNoticeDays != null) {
    const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    if (days < policy.minNoticeDays) {
      errors.push({
        field: 'plannedMoveOutDate',
        message: `We need at least ${policy.minNoticeDays} days' notice. Please choose a later date or give us a call.`,
      });
    }
  }

  if (policy.allowedDays === 'MONTH_END_ONLY') {
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
    if (target.getUTCDate() !== lastDay.getUTCDate()) {
      errors.push({ field: 'plannedMoveOutDate', message: 'Move-outs are scheduled for the last day of the month. Please pick a month end.' });
    }
  }

  return errors;
}

export interface ScheduledInput { name: string; phone: string; phoneDisplay: string; plannedMoveOutDate: string; idempotencyKey: string }

export function validateScheduled(body: Record<string, unknown>, now: Date): Validated<ScheduledInput> {
  const errors: Invalid[] = [];
  const name = cleanName(body.name);
  if (name.length < 2) errors.push({ field: 'name', message: 'Please enter your name.' });

  if (!isValidPhone(body.phone)) {
    errors.push({ field: 'phone', message: 'Please enter a 10-digit phone number we can text.' });
  }

  const date = String(body.plannedMoveOutDate ?? '');
  if (!isIsoDate(date)) {
    errors.push({ field: 'plannedMoveOutDate', message: 'Please choose your planned move-out date.' });
  } else {
    errors.push(...checkPlannedDate(date, now));
  }

  if (!isValidToken(body.idempotencyKey)) {
    errors.push({ field: 'idempotencyKey', message: 'Something went wrong sending your notice. Please try again.' });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      phone: normalisePhone(body.phone),
      phoneDisplay: String(body.phone ?? '').trim().slice(0, 40),
      plannedMoveOutDate: date,
      idempotencyKey: String(body.idempotencyKey),
    },
  };
}

export interface CompletedInput { unitNumber: string; phone: string; phoneDisplay: string; photoIds: string[]; idempotencyKey: string }

export function validateCompleted(body: Record<string, unknown>): Validated<CompletedInput> {
  const errors: Invalid[] = [];

  if (!isValidUnit(body.unitNumber)) {
    errors.push({ field: 'unitNumber', message: 'Please enter your unit number.' });
  }
  if (!isValidPhone(body.phone)) {
    errors.push({ field: 'phone', message: 'Please enter a 10-digit phone number we can text.' });
  }

  const c = (body.confirmations ?? {}) as Record<string, unknown>;
  if (c.empty !== true || c.swept !== true || c.lockRemoved !== true) {
    errors.push({ field: 'confirmations', message: 'Please confirm all three statements about your unit.' });
  }

  const ids = Array.isArray(body.photoIds) ? body.photoIds.map(String) : [];
  if (ids.length < 3) {
    errors.push({ field: 'photoIds', message: 'Please add all three required photos before submitting.' });
  }
  if (ids.length > MAX_PHOTOS) {
    errors.push({ field: 'photoIds', message: `Please send at most ${MAX_PHOTOS} photos.` });
  }
  if (new Set(ids).size !== ids.length) {
    errors.push({ field: 'photoIds', message: 'Please re-add your photos and try again.' });
  }
  if (ids.some((id) => !isValidToken(id))) {
    errors.push({ field: 'photoIds', message: 'Please re-add your photos and try again.' });
  }

  if (!isValidToken(body.idempotencyKey)) {
    errors.push({ field: 'idempotencyKey', message: 'Something went wrong submitting your move-out. Please try again.' });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      unitNumber: cleanUnit(body.unitNumber),
      phone: normalisePhone(body.phone),
      phoneDisplay: String(body.phone ?? '').trim().slice(0, 40),
      photoIds: ids,
      idempotencyKey: String(body.idempotencyKey),
    },
  };
}

export function isValidToken(input: unknown): boolean {
  return typeof input === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(input);
}

export function isValidSlot(input: unknown): input is PhotoSlot {
  return input === 'INSIDE' || input === 'FLOOR' || input === 'DOOR' || input === 'EXTRA';
}

export function checkUpload(contentType: string, bytes: number): Invalid | null {
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    return { field: 'photo', message: "That file isn't a photo we can read. Please take the photo again." };
  }
  if (bytes <= 0) {
    return { field: 'photo', message: "That photo didn't come through. Please try again." };
  }
  if (bytes > MAX_PHOTO_BYTES) {
    return { field: 'photo', message: 'That photo is too large. Please take it again.' };
  }
  return null;
}

/**
 * Identifies an image from its leading bytes. The browser-supplied MIME type is
 * a claim, not evidence — an earlier version trusted it and accepted a PDF
 * renamed as a photo. This is the authority; the claimed type is only a hint.
 */
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return null;
}
