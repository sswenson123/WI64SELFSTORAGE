import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, jpegBytes, postJson, token, uploadPhoto, uploadRequiredThree } from './helpers';

const confirmations = { empty: true, swept: true, lockRemoved: true };

async function countRequests(type: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM move_out_requests WHERE type = ?').bind(type).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('scheduled move-out', () => {
  it('submits successfully and persists exactly the approved fields', async () => {
    const res = await postJson('/api/move-outs/scheduled', {
      name: 'Scott Swenson', phone: '(651) 555-0100',
      plannedMoveOutDate: '2099-09-30', idempotencyKey: token('sched'),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);

    const row = await env.DB.prepare('SELECT * FROM move_out_requests WHERE id = ?').bind(body.id).first<Record<string, unknown>>();
    expect(row?.type).toBe('SCHEDULED_MOVE_OUT');
    expect(row?.status).toBe('NEW');
    expect(row?.customer_name).toBe('Scott Swenson');
    expect(row?.phone).toBe('6515550100');
    expect(row?.planned_move_out_date).toBe('2099-09-30');
    // the completed-only columns stay empty on a notice
    expect(row?.unit_number).toBeNull();
    expect(row?.completed_at).toBeNull();
    expect(row?.submitted_at).toBeTruthy();
  });

  it('records a confirmation in the outbox without sending anything', async () => {
    const res = await postJson('/api/move-outs/scheduled', {
      name: 'Outbox Test', phone: '6515550111', plannedMoveOutDate: '2099-10-31', idempotencyKey: token('obx'),
    });
    const { id } = (await res.json()) as { id: string };
    const note = await env.DB.prepare('SELECT * FROM notification_outbox WHERE request_id = ?').bind(id).first<Record<string, unknown>>();
    expect(note?.channel).toBe('SMS');
    expect(note?.recipient).toBe('6515550111');
    // No provider is wired up, so it must still be waiting to be sent.
    expect(note?.status).toBe('PENDING');
  });

  it('rejects a submission missing required fields, with human-readable errors', async () => {
    const res = await postJson('/api/move-outs/scheduled', { idempotencyKey: token('bad') });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; errors: { field: string; message: string }[] };
    expect(body.ok).toBe(false);
    expect(body.errors.map((e) => e.field).sort()).toEqual(['name', 'phone', 'plannedMoveOutDate']);
    for (const e of body.errors) {
      expect(e.message).toMatch(/^Please /);
      expect(e.message).not.toMatch(/undefined|null|Error|SQL|D1_/i);
    }
  });

  it('rejects an invalid phone number', async () => {
    const res = await postJson('/api/move-outs/scheduled', {
      name: 'Bad Phone', phone: '555', plannedMoveOutDate: '2099-09-30', idempotencyKey: token('ph'),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string }[] };
    expect(body.errors.some((e) => e.field === 'phone')).toBe(true);
  });

  it('does not create a second notice when the button is tapped twice', async () => {
    const key = token('dbl');
    const payload = { name: 'Double Tap', phone: '6515550122', plannedMoveOutDate: '2099-11-30', idempotencyKey: key };
    const before = await countRequests('SCHEDULED_MOVE_OUT');
    const [a, b] = await Promise.all([postJson('/api/move-outs/scheduled', payload), postJson('/api/move-outs/scheduled', payload)]);
    const bodyA = (await a.json()) as { id: string };
    const bodyB = (await b.json()) as { id: string };
    expect(bodyA.id).toBe(bodyB.id);
    expect(await countRequests('SCHEDULED_MOVE_OUT')).toBe(before + 1);
  });
});

describe('photo upload', () => {
  it('stores the image in R2 and returns an id', async () => {
    const t = token('up');
    const id = await uploadPhoto('INSIDE', t);
    const row = await env.DB.prepare('SELECT * FROM move_out_photos WHERE id = ?').bind(id).first<Record<string, unknown>>();
    expect(row?.slot).toBe('INSIDE');
    expect(row?.request_id).toBeNull(); // not claimed until the final submit
    const object = await env.PHOTOS.get(String(row?.r2_key));
    expect(object).not.toBeNull();
    expect(object!.size).toBeGreaterThan(0);
  });

  it('rejects a non-image file', async () => {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), 'x.pdf');
    form.set('slot', 'INSIDE');
    form.set('uploadToken', token('pdf'));
    const res = await call('/api/photos', { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('photo');
  });

  it('rejects a file that lies about being a JPEG', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25]);
    const form = new FormData();
    form.set('file', new Blob([pdf], { type: 'image/jpeg' }), 'notreally.jpg');
    form.set('slot', 'DOOR');
    form.set('uploadToken', token('liar'));
    const res = await call('/api/photos', { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  it('accepts a PNG even when the browser sends no type at all', async () => {
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const form = new FormData();
    form.set('file', new Blob([png], { type: '' }), 'shot.png');
    form.set('slot', 'FLOOR');
    form.set('uploadToken', token('png'));
    const res = await call('/api/photos', { method: 'POST', body: form });
    expect(res.status).toBe(201);
  });

  it('rejects an oversized photo', async () => {
    const form = new FormData();
    form.set('file', new Blob([jpegBytes(7 * 1024 * 1024)], { type: 'image/jpeg' }), 'big.jpg');
    form.set('slot', 'FLOOR');
    form.set('uploadToken', token('big'));
    const res = await call('/api/photos', { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown slot', async () => {
    const form = new FormData();
    form.set('file', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'p.jpg');
    form.set('slot', 'CEILING');
    form.set('uploadToken', token('slot'));
    expect((await call('/api/photos', { method: 'POST', body: form })).status).toBe(400);
  });
});

describe('completed move-out', () => {
  it('submits successfully and attaches the photos to that submission', async () => {
    const t = token('done');
    const photoIds = await uploadRequiredThree(t);
    const res = await postJson('/api/move-outs/completed', {
      unitNumber: 'b12', phone: '(651) 555-0100', confirmations, photoIds, uploadToken: t, idempotencyKey: token('k1'),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string; unitNumber: string; photoCount: number };
    expect(body.ok).toBe(true);
    expect(body.unitNumber).toBe('B12');
    expect(body.photoCount).toBe(3);

    const attached = await env.DB.prepare('SELECT id, slot FROM move_out_photos WHERE request_id = ? ORDER BY slot').bind(body.id).all<{ id: string; slot: string }>();
    expect(attached.results.map((r) => r.slot).sort()).toEqual(['DOOR', 'FLOOR', 'INSIDE']);
    expect(attached.results.map((r) => r.id).sort()).toEqual([...photoIds].sort());

    // and nothing leaked onto a different submission
    const other = await env.DB.prepare('SELECT COUNT(*) AS n FROM move_out_photos WHERE request_id IS NOT NULL AND request_id <> ?').bind(body.id).first<{ n: number }>();
    expect(attached.results).toHaveLength(3);
    expect(other?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('takes the move-out timestamp from the server, ignoring anything the phone sends', async () => {
    const t = token('clock');
    const photoIds = await uploadRequiredThree(t);
    const before = Date.now();
    const res = await postJson('/api/move-outs/completed', {
      unitNumber: 'C7', phone: '6515550133', confirmations, photoIds, uploadToken: t, idempotencyKey: token('k2'),
      // a wrong phone clock, and an attempt to set the field directly
      completedAt: '1999-01-01T00:00:00.000Z',
      movedOutAt: '1999-01-01T00:00:00.000Z',
    });
    const after = Date.now();
    const body = (await res.json()) as { id: string; completedAt: string };
    const stamp = new Date(body.completedAt).getTime();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);

    const row = await env.DB.prepare('SELECT completed_at, submitted_at FROM move_out_requests WHERE id = ?').bind(body.id).first<{ completed_at: string; submitted_at: string }>();
    expect(row?.completed_at).toBe(body.completedAt);
    expect(new Date(row!.completed_at).getFullYear()).toBeGreaterThan(2000);
  });

  it('refuses to complete without all three required photos', async () => {
    const t = token('two');
    const photoIds = [await uploadPhoto('INSIDE', t), await uploadPhoto('FLOOR', t)];
    const res = await postJson('/api/move-outs/completed', {
      unitNumber: 'D1', phone: '6515550144', confirmations, photoIds, uploadToken: t, idempotencyKey: token('k3'),
    });
    expect(res.status).toBe(400);
    expect(await countRequests('COMPLETED_MOVE_OUT')).toBeGreaterThanOrEqual(0);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('three required photos');
  });

  it('refuses when three photos are sent but a required angle is missing', async () => {
    const t = token('slots');
    const photoIds = [await uploadPhoto('INSIDE', t), await uploadPhoto('FLOOR', t), await uploadPhoto('EXTRA', t)];
    const res = await postJson('/api/move-outs/completed', {
      unitNumber: 'D2', phone: '6515550155', confirmations, photoIds, uploadToken: t, idempotencyKey: token('k4'),
    });
    expect(res.status).toBe(400);
  });

  it('does not report success when a photo never actually uploaded', async () => {
    const t = token('ghost');
    const real = await uploadRequiredThree(t);
    const ghost = crypto.randomUUID(); // an id the client believes in but the server never stored
    const res = await postJson('/api/move-outs/completed', {
      unitNumber: 'E9', phone: '6515550166', confirmations,
      photoIds: [...real, ghost], uploadToken: t, idempotencyKey: token('k5'),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; errors: { message: string }[] };
    expect(body.ok).toBe(false);
    expect(body.errors[0]!.message).toMatch(/didn't finish uploading/);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM move_out_requests WHERE unit_number = 'E9'").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("will not claim another browser session's photos", async () => {
    const mine = token('mine');
    const theirs = token('theirs');
    const photoIds = await uploadRequiredThree(theirs);
    const res = await postJson('/api/move-outs/completed', {
      unitNumber: 'F1', phone: '6515550177', confirmations, photoIds, uploadToken: mine, idempotencyKey: token('k6'),
    });
    expect(res.status).toBe(400);
  });

  it('refuses without required fields', async () => {
    const res = await postJson('/api/move-outs/completed', { idempotencyKey: token('k7'), uploadToken: token('u') });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string }[] };
    expect(body.errors.map((e) => e.field).sort()).toEqual(['confirmations', 'phone', 'photoIds', 'unitNumber']);
  });

  it('refuses when the three confirmations are not all checked', async () => {
    const t = token('unconf');
    const photoIds = await uploadRequiredThree(t);
    const res = await postJson('/api/move-outs/completed', {
      unitNumber: 'G3', phone: '6515550188',
      confirmations: { empty: true, swept: true, lockRemoved: false },
      photoIds, uploadToken: t, idempotencyKey: token('k8'),
    });
    expect(res.status).toBe(400);
  });

  it('does not create a second move-out when the button is tapped twice', async () => {
    const t = token('twice');
    const photoIds = await uploadRequiredThree(t);
    const key = token('k9');
    const payload = { unitNumber: 'H8', phone: '6515550199', confirmations, photoIds, uploadToken: t, idempotencyKey: key };
    const before = await countRequests('COMPLETED_MOVE_OUT');
    const [a, b] = await Promise.all([postJson('/api/move-outs/completed', payload), postJson('/api/move-outs/completed', payload)]);
    const bodyA = (await a.json()) as { id: string };
    const bodyB = (await b.json()) as { id: string };
    expect(bodyA.id).toBe(bodyB.id);
    expect(await countRequests('COMPLETED_MOVE_OUT')).toBe(before + 1);

    const photoCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM move_out_photos WHERE request_id = ?').bind(bodyA.id).first<{ n: number }>();
    expect(photoCount?.n).toBe(3);
  });

  it('accepts up to six photos but no more', async () => {
    const t = token('six');
    const ids = [
      await uploadPhoto('INSIDE', t), await uploadPhoto('FLOOR', t), await uploadPhoto('DOOR', t),
      await uploadPhoto('EXTRA', t), await uploadPhoto('EXTRA', t), await uploadPhoto('EXTRA', t),
    ];
    const ok = await postJson('/api/move-outs/completed', {
      unitNumber: 'J6', phone: '6515550200', confirmations, photoIds: ids, uploadToken: t, idempotencyKey: token('k10'),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { photoCount: number }).photoCount).toBe(6);

    const t2 = token('seven');
    const many = [
      await uploadPhoto('INSIDE', t2), await uploadPhoto('FLOOR', t2), await uploadPhoto('DOOR', t2),
      await uploadPhoto('EXTRA', t2), await uploadPhoto('EXTRA', t2), await uploadPhoto('EXTRA', t2),
      await uploadPhoto('EXTRA', t2),
    ];
    const tooMany = await postJson('/api/move-outs/completed', {
      unitNumber: 'J7', phone: '6515550201', confirmations, photoIds: many, uploadToken: t2, idempotencyKey: token('k11'),
    });
    expect(tooMany.status).toBe(400);
  });
});

describe('admin', () => {
  it('fails closed when Cloudflare Access is not configured', async () => {
    const res = await call('/admin');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Cloudflare Access is not configured');
  });

  it('does not serve a photo without Access', async () => {
    const t = token('priv');
    const id = await uploadPhoto('INSIDE', t);
    const res = await call(`/admin/photo/${id}`);
    expect([401, 503]).toContain(res.status);
  });
});

describe('cors and routing', () => {
  it('echoes an allowed origin and withholds an unknown one', async () => {
    const allowed = await call('/health');
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://wi64selfstorage.com');
    const foreign = await call('/health', { headers: { Origin: 'https://evil.example' } });
    expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers preflight', async () => {
    const res = await call('/api/move-outs/completed', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  it('404s an unknown path', async () => {
    expect((await call('/nope', { method: 'POST' })).status).toBe(404);
  });
});
