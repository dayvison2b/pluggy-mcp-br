import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtClaims {
  typ: 'client' | 'code' | 'access' | 'refresh';
  exp: number;
  [key: string]: unknown;
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  const data = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(data).digest();
  return `${data}.${base64url(signature)}`;
}

export function verifyJwt(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');
  const [header, body, signature] = parts;
  if (!header || !body || !signature) throw new Error('Malformed token.');
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid signature.');
  }
  const headerJson = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
  if (headerJson.alg !== 'HS256') throw new Error('Algorithm refused.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtClaims;
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) throw new Error('Expired token.');
  return claims;
}

function base64url(value: string | Buffer): string {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  return buffer.toString('base64url');
}
