import { env } from 'cloudflare:test';
import worker from '../src/index';

export const ORIGIN = 'https://wi64selfstorage.com';

export function token(prefix = 'tok'): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 40);
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://api.example.com${path}`, {
    ...init,
    headers: { Origin: ORIGIN, ...(init.headers ?? {}) },
  });
  return worker.fetch(request, env) as Promise<Response>;
}

export function postJson(path: string, body: unknown): Promise<Response> {
  return call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

/** A minimal but real JPEG payload. */
export function jpegBytes(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  for (let i = 4; i < size - 2; i++) bytes[i] = i % 251;
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

export async function uploadPhoto(slot: string, uploadToken: string, bytes = jpegBytes()): Promise<string> {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
  form.set('slot', slot);
  form.set('uploadToken', uploadToken);
  const res = await call('/api/photos', { method: 'POST', body: form });
  const json = (await res.json()) as { ok: boolean; photoId: string };
  if (!json.ok) throw new Error('upload failed in helper');
  return json.photoId;
}

export async function uploadRequiredThree(uploadToken: string): Promise<string[]> {
  return [
    await uploadPhoto('INSIDE', uploadToken),
    await uploadPhoto('FLOOR', uploadToken),
    await uploadPhoto('DOOR', uploadToken),
  ];
}
