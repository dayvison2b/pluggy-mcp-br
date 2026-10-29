export const SERVER_NAME = 'pluggy-mcp-br';
export const SERVER_VERSION = '0.1.0';
export const READ_SCOPE = 'mcp:read';
export const OWNER_SUBJECT = 'owner';
export const PLUGGY_API_ORIGIN = 'https://api.pluggy.ai';

export const CURSOR_REDIRECT_URIS = [
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'http://localhost:8787/callback',
] as const;

export const MIN_PASSWORD_LENGTH = 16;
const MIN_SECRET_LENGTH = 32;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const MAX_CACHE_TTL_SECONDS = 300;

export type EnvLike = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LiveConfig {
  clientId: string;
  clientSecret: string;
  itemIds: string[];
}

export function readLiveConfig(env: EnvLike = process.env): LiveConfig {
  const clientId = env.PLUGGY_CLIENT_ID?.trim() ?? '';
  const clientSecret = readClientSecret(env);
  const itemIds = (env.PLUGGY_ITEM_IDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!clientId || !clientSecret || itemIds.length === 0) {
    throw new ConfigError(
      'PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET or PLUGGY_CLIENT_SECRET_B64, and PLUGGY_ITEM_IDS are required.',
    );
  }
  if (itemIds.length > 5) {
    throw new ConfigError('Meu Pluggy allows up to 5 connections. Provide at most 5 itemIds.');
  }
  return { clientId, clientSecret, itemIds };
}

function readClientSecret(env: EnvLike): string {
  const raw = env.PLUGGY_CLIENT_SECRET?.trim() ?? '';
  if (raw) return raw;
  const encoded = env.PLUGGY_CLIENT_SECRET_B64?.trim() ?? '';
  if (!encoded) return '';
  const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
  if (!decoded || /\p{Cc}/u.test(decoded)) {
    throw new ConfigError('PLUGGY_CLIENT_SECRET_B64 is not a valid base64 Client Secret.');
  }
  return decoded;
}

export function cacheTtlMs(env: EnvLike = process.env): number {
  const raw = env.CACHE_TTL_SECONDS?.trim();
  if (!raw) return DEFAULT_CACHE_TTL_SECONDS * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError('CACHE_TTL_SECONDS must be a non-negative number; above 300 the value is capped at 300.');
  }
  return Math.min(parsed, MAX_CACHE_TTL_SECONDS) * 1000;
}

export function publicOriginFromEnv(env: EnvLike = process.env): string | null {
  const raw = env.PUBLIC_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('PUBLIC_URL must be an absolute origin, for example https://your-app.vercel.app');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('PUBLIC_URL must use http or https.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new ConfigError('PUBLIC_URL with http only works on localhost.');
  }
  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function resolvePublicOrigin(request: Request, env: EnvLike = process.env): string {
  const configured = publicOriginFromEnv(env);
  if (configured) return configured;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return new URL(request.url).origin;
}

let ephemeralSecret: string | undefined;

export function signingSecret(env: EnvLike = process.env): string {
  const configured = env.OAUTH_SIGNING_SECRET?.trim();
  if (configured) {
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new ConfigError('OAUTH_SIGNING_SECRET must be at least 32 characters long.');
    }
    return configured;
  }
  if (env.VERCEL) {
    throw new ConfigError('Set OAUTH_SIGNING_SECRET in the Vercel environment variables before authenticating.');
  }
  ephemeralSecret ??= randomSecret();
  return ephemeralSecret;
}

export function tokenVersion(env: EnvLike = process.env): string {
  const configured = env.TOKEN_VERSION?.trim();
  return configured ? configured : '1';
}

export function ownerPassword(env: EnvLike = process.env): string | null {
  const configured = env.OWNER_PASSWORD?.trim();
  if (!configured) return null;
  if (configured.length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(`OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  return configured;
}

export function authConfigured(env: EnvLike = process.env): boolean {
  try {
    return ownerPassword(env) !== null && signingSecret(env).length >= MIN_SECRET_LENGTH;
  } catch {
    return false;
  }
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}
