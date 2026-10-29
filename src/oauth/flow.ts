import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { OWNER_SUBJECT, READ_SCOPE, ownerPassword, signingSecret, tokenVersion } from '../config';
import { signJwt, verifyJwt, type JwtClaims } from './jwt';
import { RedirectError, assertAllowedRedirect } from './redirects';
import { passwordsMatch } from './passwords';

const CODE_TTL_SECONDS = 60;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 365;

const loginFailures = new Map<string, { count: number; resetAt: number }>();
const usedCodes = new Set<string>();
const routeHits = new Map<string, { count: number; resetAt: number }>();

export const ROUTE_RATE_LIMIT = 20;
const ROUTE_WINDOW_MS = 60_000;

export function clearAuthMemory(): void {
  loginFailures.clear();
  usedCodes.clear();
  routeHits.clear();
}

export function assertRouteRate(ip: string, route: string): void {
  const key = `${route}\n${ip}`;
  const now = Date.now();
  const current = routeHits.get(key);
  if (!current || current.resetAt <= now) {
    routeHits.set(key, { count: 1, resetAt: now + ROUTE_WINDOW_MS });
    return;
  }
  current.count += 1;
  if (current.count > ROUTE_RATE_LIMIT) {
    throw new OAuthFlowError('temporarily_unavailable', 'Too many requests. Wait a moment.');
  }
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
}

export function registerClient(redirectUris: string[], env: NodeJS.ProcessEnv = process.env): { clientId: string; redirectUris: string[] } {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new OAuthFlowError('invalid_client_metadata', 'redirect_uris is required.');
  }
  const canonical: string[] = [];
  for (const uri of redirectUris) {
    if (typeof uri !== 'string') throw new OAuthFlowError('invalid_redirect_uri', 'invalid redirect_uri.');
    try {
      canonical.push(assertAllowedRedirect(uri, env));
    } catch (error) {
      const message = error instanceof RedirectError ? error.message : 'redirect_uri refused.';
      throw new OAuthFlowError('invalid_redirect_uri', message);
    }
  }
  const now = nowSeconds();
  const clientId = signJwt({
    typ: 'client',
    exp: now + CLIENT_TTL_SECONDS,
    redirect_uris: canonical,
  }, signingSecret(env));
  return { clientId, redirectUris: canonical };
}

export function readAuthorizeQuery(params: URLSearchParams, resourceFallback: string, env: NodeJS.ProcessEnv = process.env): AuthorizeRequest {
  const responseType = params.get('response_type');
  if (responseType !== 'code') throw new OAuthFlowError('unsupported_response_type', 'Only the authorization code is accepted.');
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? '';
  const state = params.get('state') ?? '';
  const scope = grantedScope(params.get('scope'));
  const resource = params.get('resource') || resourceFallback;
  assertClientAllows(clientId, redirectUri, env);
  if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new OAuthFlowError('invalid_request', 'PKCE S256 is required.');
  }
  if (state && !/^[A-Za-z0-9._~-]{1,256}$/.test(state)) {
    throw new OAuthFlowError('invalid_request', 'invalid state.');
  }
  if (normalizeResource(resource) !== normalizeResource(resourceFallback)) {
    throw new OAuthFlowError('invalid_target', 'The resource must be the /mcp URL of this connector.');
  }
  return {
    clientId,
    redirectUri: assertAllowedRedirect(redirectUri, env),
    codeChallenge,
    codeChallengeMethod,
    state,
    scope,
    resource: normalizeResource(resourceFallback),
  };
}

export function issueAuthorizationCode(request: AuthorizeRequest, password: string, ip: string, env: NodeJS.ProcessEnv = process.env): string {
  assertLoginAllowed(ip);
  const expected = ownerPassword(env);
  if (!expected) {
    throw new OAuthFlowError('access_denied', 'Set OWNER_PASSWORD in the server environment variables.');
  }
  if (!passwordsMatch(password, expected)) {
    recordLoginFailure(ip);
    throw new OAuthFlowError('access_denied', 'Incorrect password.');
  }
  loginFailures.delete(ip);
  const now = nowSeconds();
  return signJwt({
    typ: 'code',
    exp: now + CODE_TTL_SECONDS,
    jti: randomUUID(),
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
    sub: OWNER_SUBJECT,
  }, signingSecret(env));
}

export function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
}, env: NodeJS.ProcessEnv = process.env): TokenResult {
  const claims = readSigned(input.code, 'code', env);
  if (claims.client_id !== input.clientId) throw new OAuthFlowError('invalid_grant', 'client_id does not match.');
  if (claims.redirect_uri !== input.redirectUri) throw new OAuthFlowError('invalid_grant', 'redirect_uri does not match.');
  if (claims.sub !== OWNER_SUBJECT) throw new OAuthFlowError('invalid_grant', 'Holder refused.');
  const jti = String(claims.jti ?? '');
  if (!jti || usedCodes.has(jti)) throw new OAuthFlowError('invalid_grant', 'Code already used or invalid.');
  if (!pkceMatches(input.codeVerifier, String(claims.code_challenge ?? ''))) {
    throw new OAuthFlowError('invalid_grant', 'PKCE does not match.');
  }
  usedCodes.add(jti);
  const resource = normalizeResource(input.resource || String(claims.resource ?? ''));
  if (resource !== String(claims.resource)) throw new OAuthFlowError('invalid_target', 'resource does not match.');
  return issueTokens({
    clientId: input.clientId,
    scope: String(claims.scope ?? READ_SCOPE),
    resource,
    env,
  });
}

export function refreshTokens(refreshToken: string, clientId: string, env: NodeJS.ProcessEnv = process.env): TokenResult {
  const claims = readSigned(refreshToken, 'refresh', env);
  if (claims.client_id !== clientId) throw new OAuthFlowError('invalid_grant', 'client_id does not match.');
  if (claims.sub !== OWNER_SUBJECT) throw new OAuthFlowError('invalid_grant', 'Holder refused.');
  return issueTokens({
    clientId,
    scope: String(claims.scope ?? READ_SCOPE),
    resource: String(claims.resource ?? ''),
    env,
  });
}

export interface TokenResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function issueTokens(input: { clientId: string; scope: string; resource: string; env: NodeJS.ProcessEnv }): TokenResult {
  const now = nowSeconds();
  const secret = signingSecret(input.env);
  const ver = tokenVersion(input.env);
  const access = signJwt({
    typ: 'access',
    exp: now + ACCESS_TTL_SECONDS,
    sub: OWNER_SUBJECT,
    client_id: input.clientId,
    scope: input.scope,
    aud: input.resource,
    ver,
  }, secret);
  const refresh = signJwt({
    typ: 'refresh',
    exp: now + REFRESH_TTL_SECONDS,
    sub: OWNER_SUBJECT,
    client_id: input.clientId,
    scope: input.scope,
    resource: input.resource,
    ver,
  }, secret);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope: input.scope,
  };
}

function assertClientAllows(clientId: string, redirectUri: string, env: NodeJS.ProcessEnv): void {
  let claims: JwtClaims;
  try {
    claims = verifyJwt(clientId, signingSecret(env));
  } catch {
    throw new OAuthFlowError('invalid_client', 'client_id was not issued by this connector. Register again.');
  }
  if (claims.typ !== 'client' || !Array.isArray(claims.redirect_uris)) {
    throw new OAuthFlowError('invalid_client', 'invalid client_id.');
  }
  let canonical: string;
  try {
    canonical = assertAllowedRedirect(redirectUri, env);
  } catch (error) {
    const message = error instanceof RedirectError ? error.message : 'redirect_uri refused.';
    throw new OAuthFlowError('invalid_redirect_uri', message);
  }
  if (!claims.redirect_uris.includes(canonical)) {
    throw new OAuthFlowError('invalid_redirect_uri', 'redirect_uri was not registered for this client.');
  }
}

function readSigned(token: string, typ: JwtClaims['typ'], env: NodeJS.ProcessEnv): JwtClaims {
  try {
    const claims = verifyJwt(token, signingSecret(env));
    if (claims.typ !== typ) throw new Error('type');
    if (typ === 'refresh' && claims.ver !== tokenVersion(env)) {
      throw new Error('version');
    }
    return claims;
  } catch {
    throw new OAuthFlowError('invalid_grant', 'Invalid or expired grant.');
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash('sha256').update(verifier).digest('base64url');
  const left = Buffer.from(actual);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

function grantedScope(requested: string | null): string {
  if (!requested || requested.trim() === '') return READ_SCOPE;
  const scopes = requested.split(/[\s+]+/).filter(Boolean);
  if (!scopes.includes(READ_SCOPE)) {
    throw new OAuthFlowError('invalid_scope', `The only scope of this connector is ${READ_SCOPE}.`);
  }
  return READ_SCOPE;
}

function normalizeResource(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  if (url.pathname.endsWith('/') && url.pathname !== '/') url.pathname = url.pathname.slice(0, -1);
  return url.href;
}

function assertLoginAllowed(ip: string): void {
  const entry = loginFailures.get(ip);
  if (!entry) return;
  if (entry.resetAt <= Date.now()) {
    loginFailures.delete(ip);
    return;
  }
  if (entry.count >= 8) {
    throw new OAuthFlowError('temporarily_unavailable', 'Too many attempts. Wait a few minutes.');
  }
}

function recordLoginFailure(ip: string): void {
  const current = loginFailures.get(ip);
  const now = Date.now();
  if (!current || current.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  current.count += 1;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class OAuthFlowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}
