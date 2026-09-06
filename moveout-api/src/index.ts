import { verifyAccess } from './access';
import {
  countPhotosByRequest, findByIdempotencyKey, getClaimablePhotos, getPhoto, getPhotosForRequest,
  getRequest, hasAllRequiredSlots, insertCompleted, insertPhoto, insertScheduled, listRequests,
  newId, photoKey, setStatus,
} from './db';
import { adminPage, photoResponseHeaders } from './admin';
import { completedBody, recordNotification, scheduledNoticeBody } from './notifications';
import { MAX_PHOTO_BYTES, MAX_PHOTOS, type Env, type PhotoRow, type RequestStatus } from './types';
import { checkUpload, isValidSlot, isValidToken, sniffImageType, validateCompleted, validateScheduled } from './validation';

const GENERIC_ERROR = "Something went wrong on our end. Please try again, or call us at (651) 327-0146.";

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function errorsResponse(errors: { field: string; message: string }[], cors: Record<string, string>): Response {
  return json({ ok: false, errors }, 400, cors);
}

function extFor(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
}

/** POST /api/photos — one photo at a time, before the final submit. */
async function handlePhotoUpload(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorsResponse([{ field: 'photo', message: "That photo didn't come through. Please try again." }], cors);
  }

  const file = form.get('file');
  const slot = form.get('slot');
  const uploadToken = form.get('uploadToken');

  if (!isValidToken(uploadToken)) {
    return errorsResponse([{ field: 'photo', message: 'Please reload the page and try again.' }], cors);
  }
  if (!isValidSlot(slot)) {
    return errorsResponse([{ field: 'photo', message: 'Please choose which photo this is.' }], cors);
  }
  if (typeof file === 'string' || file === null || typeof (file as Blob).arrayBuffer !== 'function') {
    return errorsResponse([{ field: 'photo', message: "That photo didn't come through. Please try again." }], cors);
  }
  const blob = file as Blob;

  if (blob.size > MAX_PHOTO_BYTES) {
    return errorsResponse([{ field: 'photo', message: 'That photo is too large. Please take it again.' }], cors);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    return errorsResponse([{ field: 'photo', message: "That photo didn't come through. Please try again." }], cors);
  }

  // The real type comes from the bytes, never from what the browser claimed.
  const sniffed = sniffImageType(new Uint8Array(bytes.slice(0, 16)));
  const problem = checkUpload(sniffed ?? 'application/octet-stream', bytes.byteLength);
  if (problem || !sniffed) {
    return errorsResponse([problem ?? { field: 'photo', message: "That file isn't a photo we can read. Please take the photo again." }], cors);
  }
  const contentType: string = sniffed;

  const existing = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM move_out_photos WHERE upload_token = ? AND request_id IS NULL',
  ).bind(uploadToken).first<{ n: number }>();
  if ((existing?.n ?? 0) >= MAX_PHOTOS * 3) {
    return errorsResponse([{ field: 'photo', message: 'Too many photos for one move-out. Please reload and start again.' }], cors);
  }

  const id = newId();
  const key = photoKey(String(uploadToken), id, slot, extFor(contentType));
  const width = Number(form.get('width')) || null;
  const height = Number(form.get('height')) || null;

  try {
    await env.PHOTOS.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: 'private, max-age=31536000' },
      customMetadata: { slot, uploadToken: String(uploadToken) },
    });
    await insertPhoto(env, {
      id, request_id: null, slot, r2_key: key, content_type: contentType,
      bytes: bytes.byteLength, width, height, upload_token: String(uploadToken),
      created_at: new Date().toISOString(),
    } as PhotoRow);
  } catch (err) {
    console.error('photo upload failed', String(err));
    // Best effort: don't leave an object with no row pointing at it.
    try { await env.PHOTOS.delete(key); } catch { /* ignore */ }
    return json({ ok: false, errors: [{ field: 'photo', message: "That photo didn't finish uploading. Please try it again." }] }, 502, cors);
  }

  return json({ ok: true, photoId: id, slot, bytes: blob.size }, 201, cors);
}

/** POST /api/move-outs/scheduled */
async function handleScheduled(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return errorsResponse([{ field: 'form', message: GENERIC_ERROR }], cors); }

  const result = validateScheduled(body, new Date());
  if (!result.ok) return errorsResponse(result.errors, cors);
  const input = result.value;

  const already = await findByIdempotencyKey(env, input.idempotencyKey);
  if (already) {
    return json({ ok: true, id: already.id, type: already.type, plannedMoveOutDate: already.planned_move_out_date, duplicate: true }, 200, cors);
  }

  const id = newId();
  const submittedAt = new Date().toISOString();
  try {
    await insertScheduled(env, {
      id, facility: env.FACILITY_NAME, environment: env.ENVIRONMENT || 'PRODUCTION',
      name: input.name, phone: input.phone,
      phoneDisplay: input.phoneDisplay, plannedMoveOutDate: input.plannedMoveOutDate,
      idempotencyKey: input.idempotencyKey, submittedAt,
      userAgent: request.headers.get('User-Agent'),
    });
  } catch (err) {
    const raced = await findByIdempotencyKey(env, input.idempotencyKey);
    if (raced) {
      return json({ ok: true, id: raced.id, type: raced.type, plannedMoveOutDate: raced.planned_move_out_date, duplicate: true }, 200, cors);
    }
    console.error('scheduled insert failed', String(err));
    return json({ ok: false, errors: [{ field: 'form', message: GENERIC_ERROR }] }, 500, cors);
  }

  await recordNotification(env, {
    requestId: id, channel: 'SMS', recipient: input.phone,
    body: scheduledNoticeBody(input.name, dateLabel(input.plannedMoveOutDate + 'T12:00:00Z'), env.FACILITY_NAME),
  });

  return json({ ok: true, id, type: 'SCHEDULED_MOVE_OUT', plannedMoveOutDate: input.plannedMoveOutDate, submittedAt }, 201, cors);
}

/** POST /api/move-outs/completed */
async function handleCompleted(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return errorsResponse([{ field: 'form', message: GENERIC_ERROR }], cors); }

  const result = validateCompleted(body);
  if (!result.ok) return errorsResponse(result.errors, cors);
  const input = result.value;

  const uploadToken = body.uploadToken;
  if (!isValidToken(uploadToken)) {
    return errorsResponse([{ field: 'photoIds', message: 'Please reload the page and add your photos again.' }], cors);
  }

  const already = await findByIdempotencyKey(env, input.idempotencyKey);
  if (already) {
    return json({ ok: true, id: already.id, type: already.type, unitNumber: already.unit_number, completedAt: already.completed_at, duplicate: true }, 200, cors);
  }

  // Photos must actually exist and cover all three required slots. A submission
  // is never accepted on the client's word that it uploaded them.
  const photos = await getClaimablePhotos(env, input.photoIds, String(uploadToken));
  if (photos.length !== input.photoIds.length) {
    return errorsResponse([{ field: 'photoIds', message: "Some photos didn't finish uploading. Please add them again." }], cors);
  }
  if (!hasAllRequiredSlots(photos)) {
    return errorsResponse([{ field: 'photoIds', message: 'Please add all three required photos before submitting.' }], cors);
  }

  const id = newId();
  // The move-out moment is the server's clock, never the phone's.
  const completedAt = new Date().toISOString();
  try {
    await insertCompleted(env, {
      id, facility: env.FACILITY_NAME, environment: env.ENVIRONMENT || 'PRODUCTION',
      unitNumber: input.unitNumber, phone: input.phone,
      phoneDisplay: input.phoneDisplay, completedAt, idempotencyKey: input.idempotencyKey,
      photoIds: input.photoIds, userAgent: request.headers.get('User-Agent'),
    });
  } catch (err) {
    const raced = await findByIdempotencyKey(env, input.idempotencyKey);
    if (raced) {
      return json({ ok: true, id: raced.id, type: raced.type, unitNumber: raced.unit_number, completedAt: raced.completed_at, duplicate: true }, 200, cors);
    }
    console.error('completed insert failed', String(err));
    return json({ ok: false, errors: [{ field: 'form', message: GENERIC_ERROR }] }, 500, cors);
  }

  const saved = await getPhotosForRequest(env, id);
  if (saved.length === 0) {
    console.error('completed submission saved with no photos attached', { id });
  }

  await recordNotification(env, {
    requestId: id, channel: 'SMS', recipient: input.phone,
    body: completedBody(input.unitNumber, dateLabel(completedAt), env.FACILITY_NAME),
  });

  return json({
    ok: true, id, type: 'COMPLETED_MOVE_OUT', unitNumber: input.unitNumber,
    completedAt, completedAtLabel: dateLabel(completedAt), photoCount: saved.length,
  }, 201, cors);
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const access = await verifyAccess(request, env);
  if (!access.ok) {
    return new Response(access.message, { status: access.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  // GET /admin/photo/:id — stream the original from R2, never public.
  const photoMatch = url.pathname.match(/^\/admin\/photo\/([A-Za-z0-9-]{16,64})$/);
  if (photoMatch) {
    const photo = await getPhoto(env, photoMatch[1] as string);
    if (!photo) return new Response('Not found', { status: 404 });
    const object = await env.PHOTOS.get(photo.r2_key);
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(object.body, { headers: photoResponseHeaders(photo) });
  }

  if (request.method === 'POST' && url.pathname === '/admin/status') {
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const status = String(form.get('status') ?? '') as RequestStatus;
    if (!['NEW', 'REVIEWED', 'COMPLETED'].includes(status)) return new Response('Bad status', { status: 400 });
    const existing = await getRequest(env, id);
    if (!existing) return new Response('Not found', { status: 404 });
    await setStatus(env, id, status);
    const back = url.searchParams.get('back') || '/admin';
    return new Response(null, { status: 303, headers: { Location: back } });
  }

  const type = url.searchParams.get('type') ?? '';
  const status = url.searchParams.get('status') ?? '';
  const rows = await listRequests(env, { type: type || undefined, status: status || undefined });
  const counts = await countPhotosByRequest(env);

  const detailId = url.searchParams.get('id');
  const detailPhotos = detailId ? await getPhotosForRequest(env, detailId) : [];

  return new Response(adminPage({ rows, counts, filterType: type, filterStatus: status, detailId, detailPhotos,
    viewer: access.identity.email, environment: env.ENVIRONMENT || 'PRODUCTION', facility: env.FACILITY_NAME }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/health') return json({ ok: true }, 200, cors);

    if (url.pathname.startsWith('/admin')) {
      try { return await handleAdmin(request, env, url); }
      catch (err) { console.error('admin error', String(err)); return new Response('Something went wrong.', { status: 500 }); }
    }

    if (request.method === 'POST') {
      try {
        if (url.pathname === '/api/photos') return await handlePhotoUpload(request, env, cors);
        if (url.pathname === '/api/move-outs/scheduled') return await handleScheduled(request, env, cors);
        if (url.pathname === '/api/move-outs/completed') return await handleCompleted(request, env, cors);
      } catch (err) {
        console.error('unhandled error', url.pathname, String(err));
        return json({ ok: false, errors: [{ field: 'form', message: GENERIC_ERROR }] }, 500, cors);
      }
    }

    return json({ ok: false, errors: [{ field: 'form', message: 'Not found' }] }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
