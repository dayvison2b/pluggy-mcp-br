import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { OWNER_SUBJECT, signingSecret, tokenVersion } from '../config';
import { verifyJwt } from './jwt';

export async function verifyOwnerToken(token: string): Promise<AuthInfo> {
  try {
    const claims = verifyJwt(token, signingSecret());
    if (claims.typ !== 'access' || claims.sub !== OWNER_SUBJECT || claims.ver !== tokenVersion()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token refused.');
    }
    const audience = typeof claims.aud === 'string' ? claims.aud : '';
    return {
      token,
      clientId: String(claims.client_id ?? OWNER_SUBJECT),
      scopes: String(claims.scope ?? '').split(' ').filter(Boolean),
      expiresAt: Number(claims.exp),
      resource: audience ? new URL(audience) : undefined,
      extra: { sub: OWNER_SUBJECT },
    };
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid token.');
  }
}
