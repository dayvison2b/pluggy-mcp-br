import {
  buildOAuthProtectedResourceMetadata,
  oauthMetadataResponse,
  type AuthMetadataOptions,
  type OAuthMetadata,
} from '@modelcontextprotocol/server';
import { ConfigError, READ_SCOPE, SERVER_NAME, authConfigured, resolvePublicOrigin } from '../config';
import { handleMcp } from './mcp-http';
import { handleAuthorize, handleRegister, handleToken } from './oauth-http';

export async function handleRequest(request: Request): Promise<Response> {
  try {
    return withSecurity(await route(request));
  } catch (error) {
    console.error('request failed', error instanceof Error ? error.name : 'error');
    const description = error instanceof ConfigError ? error.message : 'Internal failure.';
    return withSecurity(Response.json({ error: 'server_error', error_description: description }, { status: 500 }));
  }
}

async function route(request: Request): Promise<Response> {
  const pathname = normalizePath(new URL(request.url).pathname);
  if (pathname.startsWith('/.well-known/')) {
    if (request.method === 'OPTIONS') return withDiscoveryCors(new Response(null, { status: 204 }));
    const metadata = metadataResponse(request, pathname);
    if (metadata) return withDiscoveryCors(metadata);
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    const payload = {
      name: SERVER_NAME,
      mcp: '/mcp',
      health: '/health',
      readme: 'https://github.com/dayvison2b/pluggy-mcp-br',
    };
    if (request.method === 'HEAD') {
      return new Response(null, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    return Response.json(payload);
  }
  if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
    const payload = {
      ok: true,
      name: SERVER_NAME,
      mode: 'live',
      readOnly: true,
      authConfigured: authConfigured(),
      publicOrigin: resolvePublicOrigin(request),
    };
    return Response.json(payload);
  }
  if (pathname === '/register') return handleRegister(request);
  if (pathname === '/authorize') return handleAuthorize(request);
  if (pathname === '/token') return handleToken(request);
  if (pathname === '/mcp') return handleMcp(request);
  return Response.json({ error: 'not_found' }, { status: 404 });
}

function metadataResponse(request: Request, pathname: string): Response | undefined {
  const origin = resolvePublicOrigin(request);
  const options = oauthOptions(origin);
  const synthetic = new Request(new URL(pathname, origin), { method: request.method, headers: request.headers });
  const discovered = oauthMetadataResponse(synthetic, options);
  if (discovered) return discovered;
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  if (pathname === '/.well-known/oauth-protected-resource') {
    return Response.json(buildOAuthProtectedResourceMetadata(options));
  }
  if (pathname === '/.well-known/oauth-authorization-server/mcp') {
    return Response.json(options.oauthMetadata);
  }
  return undefined;
}

export function oauthOptions(origin: string): AuthMetadataOptions {
  const oauthMetadata: OAuthMetadata = {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: [READ_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
  return {
    oauthMetadata,
    resourceServerUrl: new URL('/mcp', origin),
    scopesSupported: [READ_SCOPE],
    resourceName: SERVER_NAME,
    serviceDocumentationUrl: new URL('https://github.com/dayvison2b/pluggy-mcp-br'),
  };
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (trimmed.startsWith('/api/well-known/')) {
    return `/.well-known/${trimmed.slice('/api/well-known/'.length)}`;
  }
  return trimmed;
}

function withSecurity(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withDiscoveryCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
