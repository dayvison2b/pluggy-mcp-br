import { CURSOR_REDIRECT_URIS } from '../config';

export function allowedRedirects(_env: NodeJS.ProcessEnv = process.env): string[] {
  return [...CURSOR_REDIRECT_URIS];
}

export function canonicalizeRedirect(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RedirectError('invalid redirect_uri.');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new RedirectError('redirect_uri cannot carry a user, a password, a query or a fragment.');
  }
  const scheme = url.protocol;
  if (scheme === 'cursor:') {
    if (url.href !== 'cursor://anysphere.cursor-mcp/oauth/callback') {
      throw new RedirectError('The only accepted cursor:// redirect is the one for the Cursor/Grok Bot.');
    }
    return url.href;
  }
  if (scheme === 'https:') return url.href;
  if (scheme === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href;
  throw new RedirectError('redirect_uri must be https, the Grok Bot cursor:// one, or http on localhost.');
}

export function assertAllowedRedirect(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const canonical = canonicalizeRedirect(value);
  if (!allowedRedirects(env).includes(canonical)) {
    throw new RedirectError('redirect_uri is not in the list this connector accepts.');
  }
  return canonical;
}

export class RedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectError';
  }
}
