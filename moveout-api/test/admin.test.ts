import { describe, expect, it } from 'vitest';
import { adminPage } from '../src/admin';
import type { MoveOutRow, PhotoRow } from '../src/types';

function row(over: Partial<MoveOutRow> = {}): MoveOutRow {
  return {
    id: 'r1', type: 'COMPLETED_MOVE_OUT', status: 'NEW', facility: 'Pleasant Lake Storage',
    phone: '2185550123', phone_display: '(218) 555-0123', customer_name: null,
    planned_move_out_date: null, unit_number: 'A14', completed_at: '2026-09-06T15:00:00.000Z',
    confirmed_empty: 1, confirmed_swept: 1, confirmed_lock_removed: 1,
    idempotency_key: 'k1', submitted_at: '2026-09-06T15:00:00.000Z',
    created_at: '2026-09-06T15:00:00.000Z', updated_at: '2026-09-06T15:00:00.000Z',
    staff_note: null, user_agent: null, environment: 'PREVIEW', ...over,
  };
}

const base = { counts: new Map<string, number>([['r1', 3]]), filterType: '', filterStatus: '',
  detailId: null, detailPhotos: [] as PhotoRow[], viewer: 'scott@example.com' };

describe('admin page', () => {
  it('paints the whole page as a test environment in preview', () => {
    const html = adminPage({ ...base, rows: [row()], environment: 'PREVIEW', facility: 'Pleasant Lake Storage (PREVIEW)' });
    expect(html).toContain('TEST / PREVIEW');
    expect(html).toContain('This is the PREVIEW environment');
    expect(html).toContain('do not close an account or issue a refund');
    expect(html).toContain('<title>TEST · Move-Out Requests</title>');
    expect(html).toContain('<span class="envtag">test</span>');
  });

  it('shows no test marking in production', () => {
    const html = adminPage({ ...base, rows: [row({ environment: 'PRODUCTION' })], environment: 'PRODUCTION', facility: 'WI 64 Self Storage' });
    expect(html).not.toContain('TEST / PREVIEW');
    expect(html).not.toContain('This is the PREVIEW environment');
    expect(html).not.toContain('<span class="envtag">test</span>');
    expect(html).toContain('WI 64 Self Storage');
  });

  it('lists both queues with the fields staff need', () => {
    const html = adminPage({
      ...base,
      rows: [row(), row({ id: 'r2', type: 'SCHEDULED_MOVE_OUT', unit_number: null,
        customer_name: 'Preview Tester', planned_move_out_date: '2026-09-30', completed_at: null })],
      environment: 'PREVIEW', facility: 'Pleasant Lake Storage',
    });
    expect(html).toContain('Completed move-outs');
    expect(html).toContain('Scheduled move-out notices');
    expect(html).toContain('A14');
    expect(html).toContain('Preview Tester');
    expect(html).toContain('(218) 555-0123');
    expect(html).toContain('✅ all three');
    expect(html).toContain('View photos');
  });

  it('escapes values rather than trusting what a customer typed', () => {
    const html = adminPage({ ...base, rows: [row({ unit_number: '<img src=x onerror=alert(1)>' })],
      environment: 'PREVIEW', facility: 'F' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
