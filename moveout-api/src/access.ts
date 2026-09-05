import type { Env } from './types';

/**
 * Cloudflare Access (Zero Trust) guards /admin. Staff sign in with their own
 * email against the allowlist configured on the Access application; Cloudflare
 * puts a signed JWT on every request, which we verify here against the team's
 * public keys.
 *
 * Fails CLOSED: if CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are not configured the
 * admin is unavailable rather than open. Customer photos and phone numbers are
 * behind this.
 */
interface Jwk { kid: string; kty: string; alg?: string; use?: string; n?: string; e?: string }

let cachedKeys: { fetchedAt: number; keys: Jwk[] } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
}

async function getKeys(teamDomain: string): Promise<Jwk[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_TTL_MS) return cachedKeys.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  cachedKeys = { fetchedAt: Date.now(), keys };
  return keys;
}

export interface AccessIdentity { email: string }

export type AccessResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; status: 503 | 401; message: string };

export async function verifyAccess(request: Request, env: Env): Promise<AccessResult> {
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN || '').trim();
  const aud = (env.CF_ACCESS_AUD || '').trim();

  if (!teamDomain || !aud) {
    return {
      ok: false,
      status: 503,
      message:
        'Admin is not available yet: Cloudflare Access is not configured. Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, then redeploy.',
    };
  }

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] ||
    '';

  if (!token) return { ok: false, status: 401, message: 'Please sign in.' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, message: 'Please sign in again.' };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  try {
    const header = decodeJson(headerB64) as { kid?: string; alg?: string };
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, status: 401, message: 'Please sign in again.' };

    const jwk = (await getKeys(teamDomain)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, status: 401, message: 'Please sign in again.' };

    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return { ok: false, status: 401, message: 'Please sign in again.' };

    const payload = decodeJson(payloadB64) as { aud?: string | string[]; exp?: number; iss?: string; email?: string };
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(aud)) return { ok: false, status: 401, message: 'Please sign in again.' };
    if (payload.iss !== `https://${teamDomain}`) return { ok: false, status: 401, message: 'Please sign in again.' };
    if (!payload.exp || payload.exp * 1000 < Date.now()) return { ok: false, status: 401, message: 'Your session expired. Please sign in again.' };

    return { ok: true, identity: { email: payload.email ?? 'unknown' } };
  } catch (err) {
    console.error('Access verification error', String(err));
    return { ok: false, status: 401, message: 'Please sign in again.' };
  }
}
