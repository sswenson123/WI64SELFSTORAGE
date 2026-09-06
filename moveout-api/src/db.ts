import type { Env, MoveOutRow, PhotoRow, PhotoSlot, RequestStatus } from './types';
import { REQUIRED_SLOTS } from './types';

export function newId(): string {
  return crypto.randomUUID();
}

export async function findByIdempotencyKey(env: Env, key: string): Promise<MoveOutRow | null> {
  return await env.DB.prepare('SELECT * FROM move_out_requests WHERE idempotency_key = ?')
    .bind(key)
    .first<MoveOutRow>();
}

export async function getRequest(env: Env, id: string): Promise<MoveOutRow | null> {
  return await env.DB.prepare('SELECT * FROM move_out_requests WHERE id = ?').bind(id).first<MoveOutRow>();
}

export async function insertPhoto(env: Env, row: PhotoRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO move_out_photos (id, request_id, slot, r2_key, content_type, bytes, width, height, upload_token, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.slot, row.r2_key, row.content_type, row.bytes, row.width, row.height, row.upload_token, row.created_at)
    .run();
}

export async function getPhoto(env: Env, id: string): Promise<PhotoRow | null> {
  return await env.DB.prepare('SELECT * FROM move_out_photos WHERE id = ?').bind(id).first<PhotoRow>();
}

export async function getPhotosForRequest(env: Env, requestId: string): Promise<PhotoRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM move_out_photos WHERE request_id = ?
      ORDER BY CASE slot WHEN 'INSIDE' THEN 0 WHEN 'FLOOR' THEN 1 WHEN 'DOOR' THEN 2 ELSE 3 END, created_at`,
  )
    .bind(requestId)
    .all<PhotoRow>();
  return res.results ?? [];
}

/** Unclaimed photos belonging to this browser session, by id. */
export async function getClaimablePhotos(env: Env, ids: string[], uploadToken: string): Promise<PhotoRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT * FROM move_out_photos
      WHERE id IN (${placeholders}) AND upload_token = ? AND request_id IS NULL`,
  )
    .bind(...ids, uploadToken)
    .all<PhotoRow>();
  return res.results ?? [];
}

export function hasAllRequiredSlots(photos: PhotoRow[]): boolean {
  return REQUIRED_SLOTS.every((slot) => photos.some((p) => p.slot === slot));
}

export interface ScheduledRecord {
  id: string;
  facility: string;
  environment: string;
  name: string;
  phone: string;
  phoneDisplay: string;
  plannedMoveOutDate: string;
  idempotencyKey: string;
  submittedAt: string;
  userAgent: string | null;
}

export async function insertScheduled(env: Env, r: ScheduledRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO move_out_requests
       (id, type, status, facility, phone, phone_display, customer_name, planned_move_out_date,
        idempotency_key, submitted_at, created_at, updated_at, user_agent, environment)
     VALUES (?, 'SCHEDULED_MOVE_OUT', 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      r.id, r.facility, r.phone, r.phoneDisplay, r.name, r.plannedMoveOutDate,
      r.idempotencyKey, r.submittedAt, r.submittedAt, r.submittedAt, r.userAgent, r.environment,
    )
    .run();
}

export interface CompletedRecord {
  id: string;
  facility: string;
  environment: string;
  unitNumber: string;
  phone: string;
  phoneDisplay: string;
  /** Server clock. This IS the move-out moment — never taken from the client. */
  completedAt: string;
  idempotencyKey: string;
  photoIds: string[];
  userAgent: string | null;
}

/**
 * Writes the request and claims its photos in one batch, so a submission can
 * never end up saved without its photos attached (or vice versa).
 */
export async function insertCompleted(env: Env, r: CompletedRecord): Promise<void> {
  const statements = [
    env.DB.prepare(
      `INSERT INTO move_out_requests
         (id, type, status, facility, phone, phone_display, unit_number, completed_at,
          confirmed_empty, confirmed_swept, confirmed_lock_removed,
          idempotency_key, submitted_at, created_at, updated_at, user_agent, environment)
       VALUES (?, 'COMPLETED_MOVE_OUT', 'NEW', ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      r.id, r.facility, r.phone, r.phoneDisplay, r.unitNumber, r.completedAt,
      r.idempotencyKey, r.completedAt, r.completedAt, r.completedAt, r.userAgent, r.environment,
    ),
    ...r.photoIds.map((pid) =>
      env.DB.prepare('UPDATE move_out_photos SET request_id = ? WHERE id = ? AND request_id IS NULL').bind(r.id, pid),
    ),
  ];
  await env.DB.batch(statements);
}

export interface ListFilters { type?: string; status?: string; limit?: number }

export async function listRequests(env: Env, f: ListFilters): Promise<MoveOutRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.type) { where.push('type = ?'); binds.push(f.type); }
  if (f.status) { where.push('status = ?'); binds.push(f.status); }
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
  const sql =
    `SELECT * FROM move_out_requests
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY submitted_at DESC LIMIT ?`;
  const res = await env.DB.prepare(sql).bind(...binds, limit).all<MoveOutRow>();
  return res.results ?? [];
}

export async function countPhotosByRequest(env: Env): Promise<Map<string, number>> {
  const res = await env.DB.prepare(
    'SELECT request_id, COUNT(*) AS n FROM move_out_photos WHERE request_id IS NOT NULL GROUP BY request_id',
  ).all<{ request_id: string; n: number }>();
  const map = new Map<string, number>();
  for (const row of res.results ?? []) map.set(row.request_id, row.n);
  return map;
}

export async function setStatus(env: Env, id: string, status: RequestStatus): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE move_out_requests SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export function photoKey(uploadToken: string, photoId: string, slot: PhotoSlot, ext: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `move-outs/${day}/${uploadToken}/${slot.toLowerCase()}-${photoId}.${ext}`;
}
