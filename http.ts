// Shared HTTP plumbing for the forge's handlers: the request context, JSON
// replies, and body reading. The app router (app.ts) builds a Ctx per request
// and hands it to the surface handler; handlers never touch the raw socket.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export interface Ctx {
  readonly forge: Forge;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** The whole request body (empty for GET/DELETE without one). */
  readonly body: Buffer;
  readonly query: URLSearchParams;
  /** Route parameters, already URL-decoded. */
  readonly params: Record<string, string>;
}

/** The bearer token this process was given (empty when run outside a trial). */
export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function sendJson(res: ServerResponse, status: number, value: unknown, requestId: string, extra?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string, requestId: string): void {
  sendJson(res, status, { message }, requestId);
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  requestId: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId,
  });
  res.end(body);
}

/** Read a whole request body (capped; a pack is at most a few hundred KiB). */
export function readBody(req: IncomingMessage, limitBytes = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > limitBytes) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Parse a JSON body; an empty body is valid (it means "no fields given"). */
export function parseJsonBody(body: Buffer): JsonParseResult {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false, error: 'Invalid JSON in request body' };
  }
}

/** A JSON object body, or null when the body is not a JSON object. */
export function bodyObject(body: Buffer): Record<string, unknown> | null {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
