import {
  McpServer,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { OWNER_SUBJECT, READ_SCOPE, SERVER_NAME, SERVER_VERSION, resolvePublicOrigin } from '../config';
import { buildMcpServer } from '../mcp/tools';
import { verifyOwnerToken } from '../oauth/verify';

const handler = createMcpHandler((ctx) => {
  if (ctx.authInfo?.extra?.sub !== OWNER_SUBJECT) {
    return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  }
  return buildMcpServer();
});

export async function handleMcp(request: Request): Promise<Response> {
  const origin = resolvePublicOrigin(request);
  const mcpUrl = new URL('/mcp', origin);
  const gate = requireBearerAuth({
    verifier: { verifyAccessToken: (token: string) => verifyOwnerToken(token) },
    requiredScopes: [READ_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });
  const auth = await gate(request);
  if (auth instanceof Response) return auth;
  return handler.fetch(request, { authInfo: auth satisfies AuthInfo });
}
