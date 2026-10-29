import { ConfigError, READ_SCOPE, resolvePublicOrigin } from '../config';
import {
  OAuthFlowError,
  assertRouteRate,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  readAuthorizeQuery,
  refreshTokens,
  registerClient,
  type AuthorizeRequest,
} from '../oauth/flow';
import { RedirectError } from '../oauth/redirects';
import { loginHtml } from './html';

export async function handleRegister(request: Request): Promise<Response> {
  try {
    assertRouteRate(clientIp(request), '/register');
  } catch (error) {
    return flowError(error);
  }
  if (request.method !== 'POST') return oauthError('invalid_request', 'Use POST.', 405);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!isJsonObject(parsed)) return oauthError('invalid_client_metadata', 'Invalid JSON.', 400);
    body = parsed;
  } catch {
    return oauthError('invalid_client_metadata', 'Invalid JSON.', 400);
  }
  try {
    const registered = registerClient(asStringArray(body.redirect_uris));
    return Response.json(
      {
        client_id: registered.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: registered.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: READ_SCOPE,
        client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'mcp-client',
      },
      { status: 201 },
    );
  } catch (error) {
    return flowError(error);
  }
}

export async function handleAuthorize(request: Request): Promise<Response> {
  const origin = resolvePublicOrigin(request);
  const resource = new URL('/mcp', origin).href;
  if (request.method === 'GET') {
    try {
      const parsed = readAuthorizeQuery(new URL(request.url).searchParams, resource);
      return html(loginHtml(hiddenFields(parsed)));
    } catch (error) {
      return flowError(error);
    }
  }
  if (request.method !== 'POST') return oauthError('invalid_request', 'Use GET or POST.', 405);
  let form: URLSearchParams;
  try {
    form = await readOAuthForm(request);
  } catch (error) {
    return flowError(error);
  }
  let parsed: AuthorizeRequest;
  try {
    parsed = readAuthorizeQuery(form, resource);
  } catch (error) {
    return flowError(error);
  }
  try {
    const code = issueAuthorizationCode(parsed, form.get('password') ?? '', clientIp(request));
    const target = new URL(parsed.redirectUri);
    target.searchParams.set('code', code);
    if (parsed.state) target.searchParams.set('state', parsed.state);
    return new Response(null, {
      status: 302,
      headers: { Location: target.href, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof OAuthFlowError && error.code === 'access_denied') {
      return html(loginHtml(hiddenFields(parsed), error.message), 401);
    }
    if (error instanceof OAuthFlowError && error.code === 'temporarily_unavailable') {
      return html(loginHtml(hiddenFields(parsed), error.message), 429);
    }
    return flowError(error);
  }
}

export async function handleToken(request: Request): Promise<Response> {
  try {
    assertRouteRate(clientIp(request), '/token');
  } catch (error) {
    return flowError(error);
  }
  if (request.method !== 'POST') return oauthError('invalid_request', 'Use POST.', 405);
  try {
    const form = await readOAuthForm(request);
    const grant = form.get('grant_type');
    const clientId = form.get('client_id') ?? '';
    if (grant === 'authorization_code') {
      const tokens = exchangeAuthorizationCode({
        code: form.get('code') ?? '',
        clientId,
        redirectUri: form.get('redirect_uri') ?? '',
        codeVerifier: form.get('code_verifier') ?? '',
        resource: form.get('resource'),
      });
      return Response.json(tokens);
    }
    if (grant === 'refresh_token') {
      return Response.json(refreshTokens(form.get('refresh_token') ?? '', clientId));
    }
    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.', 400);
  } catch (error) {
    return flowError(error);
  }
}

function hiddenFields(request: AuthorizeRequest): Record<string, string> {
  return {
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    state: request.state,
    scope: request.scope,
    resource: request.resource,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readOAuthForm(request: Request): Promise<URLSearchParams> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new OAuthFlowError('invalid_request', 'Invalid body.');
  }
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    try {
      return new URLSearchParams(text);
    } catch {
      throw new OAuthFlowError('invalid_request', 'Invalid body.');
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OAuthFlowError('invalid_request', 'Invalid JSON.');
  }
  if (!isJsonObject(parsed)) {
    throw new OAuthFlowError('invalid_request', 'The JSON body must be an object.');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') params.set(key, value);
  }
  return params;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return [];
  return value as string[];
}

function clientIp(request: Request): string {
  if (process.env.VERCEL) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  }
  return 'local';
}

function flowError(error: unknown): Response {
  if (error instanceof RedirectError) {
    return oauthError('invalid_redirect_uri', error.message, 400);
  }
  if (error instanceof OAuthFlowError) {
    const status = error.code === 'access_denied' ? 401 : error.code === 'temporarily_unavailable' ? 429 : 400;
    return oauthError(error.code, error.message, status);
  }
  if (error instanceof ConfigError) return oauthError('server_error', error.message, 500);
  console.error('oauth failure', error instanceof Error ? error.name : 'error');
  return oauthError('server_error', 'Internal failure.', 500);
}

function oauthError(code: string, description: string, status: number): Response {
  return Response.json({ error: code, error_description: description }, { status });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
