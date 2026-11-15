// The server: one Forge, one HTTP handler, four surfaces.
//
//   GET  /healthz                       -> 200 {"ok": true} (no token)
//   /{owner}/{repo}.git/...             -> git smart HTTP (info/refs,
//                                          upload-pack, receive-pack)
//   POST /api/graphql                   -> GraphQL v4
//   POST /mcp                           -> MCP over streamable HTTP
//   /api/v3/...                         -> REST v3
//   anything else                       -> 404 {"message": "Not Found"}
//
// Every API call carries Authorization: Bearer <token>, the token in this
// process's MAKEFUN_SHOP_TOKEN; a request without it (or with the wrong one)
// is 401, and a repository under another owner is 404, never 403. /healthz
// takes no token. Every reply is JSON (or a git content type for the git
// surfaces) and carries a non-empty X-GitHub-Request-Id. A handler that
// throws is answered 500 and the server stays up — a malformed request must
// never kill the forge.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { readBody, sendError, sendJson, shopToken, type Ctx } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

function isAuthorized(req: IncomingMessage): boolean {
  const token = shopToken();
  if (token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    void handleRequest(forge, req, res);
  });
  return server;
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, forge.nextRequestId());
      return;
    }

    if (!isAuthorized(req)) {
      sendError(res, 401, 'Unauthorized', forge.nextRequestId());
      return;
    }

    const body = await readBody(req);
    const ctx: Ctx = { forge, req, res, body, query: url.searchParams, params: {} };

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
    if (gitMatch !== null) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const suffix = gitMatch[3]!;
      if (req.method === 'GET' && suffix.startsWith('info/refs')) {
        handleInfoRefs(ctx, owner, repoName, url.searchParams.get('service') ?? '');
        return;
      }
      if (req.method === 'POST' && suffix === 'git-upload-pack') {
        handleUploadPack(ctx, owner, repoName);
        return;
      }
      if (req.method === 'POST' && suffix === 'git-receive-pack') {
        handleReceivePack(ctx, owner, repoName);
        return;
      }
      sendError(res, 404, 'Not Found', forge.nextRequestId());
      return;
    }

    if (pathname === '/api/graphql') {
      if (req.method === 'POST') handleGraphql(ctx);
      else sendError(res, 405, 'Method Not Allowed', forge.nextRequestId());
      return;
    }

    if (pathname === '/mcp') {
      if (req.method === 'POST') handleMcp(ctx);
      else sendError(res, 405, 'Method Not Allowed', forge.nextRequestId());
      return;
    }

    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      if (!handleRest(ctx)) sendError(res, 404, 'Not Found', forge.nextRequestId());
      return;
    }

    sendError(res, 404, 'Not Found', forge.nextRequestId());
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error', forge.nextRequestId());
    } else {
      res.end();
    }
  }
}
