import { describe, expect, it } from 'vitest';
import {
  checkPlannedDate, cleanUnit, isIsoDate, isValidPhone, isValidUnit, normalisePhone,
  sniffImageType, validateCompleted, validateScheduled,
} from '../src/validation';

describe('phone', () => {
  it('accepts a formatted 10-digit number', () => {
    expect(isValidPhone('(651) 555-0100')).toBe(true);
    expect(normalisePhone('(651) 555-0100')).toBe('6515550100');
  });
  it('strips a leading US country code', () => {
    expect(normalisePhone('+1 651 555 0100')).toBe('6515550100');
    expect(isValidPhone('+1 651 555 0100')).toBe(true);
  });
  it('rejects short, long and impossible numbers', () => {
    expect(isValidPhone('555-0100')).toBe(false);
    expect(isValidPhone('')).toBe(false);
    expect(isValidPhone('0651555010')).toBe(false); // area code cannot start with 0
    expect(isValidPhone('1651555010')).toBe(false); // area code cannot start with 1
  });
});

describe('unit number', () => {
  it('normalises case and spacing', () => {
    expect(cleanUnit(' b12 ')).toBe('B12');
    expect(isValidUnit('b12')).toBe(true);
    expect(isValidUnit('A-1')).toBe(true);
  });
  it('rejects empty or unsafe values', () => {
    expect(isValidUnit('')).toBe(false);
    expect(isValidUnit('<script>')).toBe(false);
  });
});

describe('iso dates', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isIsoDate('2026-09-30')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('09/30/2026')).toBe(false);
  });
});

describe('planned date policy', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  it('rejects a date in the past', () => {
    expect(checkPlannedDate('2026-09-04', now)).toHaveLength(1);
  });

  it('allows today and any future date under the current empty policy', () => {
    expect(checkPlannedDate('2026-09-05', now)).toHaveLength(0);
    expect(checkPlannedDate('2026-09-06', now)).toHaveLength(0);
    expect(checkPlannedDate('2026-12-31', now)).toHaveLength(0);
  });

  it('does NOT enforce a notice period yet — the lease question is unresolved', () => {
    expect(checkPlannedDate('2026-09-06', now)).toHaveLength(0);
  });

  it('enforces a notice period once a policy supplies one', () => {
    const errs = checkPlannedDate('2026-09-06', now, { minNoticeDays: 10 });
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('10 days');
  });

  it('enforces month-end once a policy asks for it', () => {
    expect(checkPlannedDate('2026-09-15', now, { allowedDays: 'MONTH_END_ONLY' })).toHaveLength(1);
    expect(checkPlannedDate('2026-09-30', now, { allowedDays: 'MONTH_END_ONLY' })).toHaveLength(0);
  });
});

describe('scheduled payload', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const good = { name: 'Scott Swenson', phone: '(651) 555-0100', plannedMoveOutDate: '2026-09-30', idempotencyKey: 'a'.repeat(24) };

  it('accepts the three approved fields', () => {
    const r = validateScheduled({ ...good }, now);
    expect(r.ok).toBe(true);
  });

  it('names each missing field in plain language', () => {
    const r = validateScheduled({ idempotencyKey: 'a'.repeat(24) }, now);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field).sort()).toEqual(['name', 'phone', 'plannedMoveOutDate']);
    for (const e of r.errors) expect(e.message).toMatch(/^Please /);
  });
});

describe('completed payload', () => {
  const key = 'b'.repeat(24);
  const ids = ['p'.repeat(20), 'q'.repeat(20), 'r'.repeat(20)];
  const confirmations = { empty: true, swept: true, lockRemoved: true };

  it('accepts unit, phone, confirmations and three photos', () => {
    expect(validateCompleted({ unitNumber: 'B12', phone: '6515550100', confirmations, photoIds: ids, idempotencyKey: key }).ok).toBe(true);
  });

  it('rejects fewer than three photos', () => {
    const r = validateCompleted({ unitNumber: 'B12', phone: '6515550100', confirmations, photoIds: ids.slice(0, 2), idempotencyKey: key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === 'photoIds')).toBe(true);
  });

  it('rejects a partially confirmed submission', () => {
    const r = validateCompleted({ unitNumber: 'B12', phone: '6515550100', confirmations: { empty: true, swept: true, lockRemoved: false }, photoIds: ids, idempotencyKey: key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === 'confirmations')).toBe(true);
  });

  it('rejects duplicate photo ids', () => {
    const r = validateCompleted({ unitNumber: 'B12', phone: '6515550100', confirmations, photoIds: [ids[0]!, ids[0]!, ids[1]!], idempotencyKey: key });
    expect(r.ok).toBe(false);
  });

  it('never asks for a name, email or a customer-supplied date', () => {
    const r = validateCompleted({ unitNumber: 'B12', phone: '6515550100', confirmations, photoIds: ids, idempotencyKey: key });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(['idempotencyKey', 'phone', 'phoneDisplay', 'photoIds', 'unitNumber']);
  });
});

describe('image sniffing', () => {
  it('identifies real image formats from their leading bytes', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  it('returns null for anything else, whatever it claims to be', () => {
    expect(sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // PDF
    expect(sniffImageType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // zip
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});
