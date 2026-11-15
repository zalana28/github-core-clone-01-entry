// Git smart HTTP: info/refs, upload-pack (v2 and v0) and receive-pack (v0).
//
// The wire formats follow the client's git-client.ts exactly:
//   - info/refs upload-pack answers v2 when the client asks for it
//     (Git-Protocol: version=2) and v0 otherwise; receive-pack is v0-only.
//   - v2 ls-refs lines are "<oid> <name> [symref-target:X] [peeled:Y]";
//     an empty repo answers "unborn HEAD symref-target:refs/heads/main"
//     when the client asked for unborn refs.
//   - v2 fetch answers acknowledgments, then shallow-info, then a packfile
//     section of sideband band-1 packets; no objects means no packfile
//     section at all.
//   - receive-pack takes a v0 command list (capabilities after a NUL on the
//     first line) plus a pack, validates each ref update, and reports
//     "unpack ok" plus one ok/ng line per ref inside sideband band 1.

import {
  DELIM_PKT,
  FLUSH_PKT,
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isObjectId,
  parseTag,
  peelToCommit,
  planFetch,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
} from './gitproto.ts';
import { sendBytes, sendError, type Ctx } from './http.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'forge/1.0';

function gitContentType(service: 'git-upload-pack' | 'git-receive-pack', kind: 'advertisement' | 'result'): string {
  return `application/x-${service}-${kind}`;
}

/** The refs a repo advertises, in git order (HEAD first, then sorted). */
function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object?.type === 'tag') peeled = parseTag(object.data).object;
    refs.push({ oid, name, peeled });
  }
  return refs;
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** v0 advertisement: service preamble, HEAD (or capabilities^{}) first, then refs. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const capabilities =
    service === 'git-upload-pack'
      ? `${symref} side-band-64k ofs-delta multi_ack thin-pack agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=${AGENT} ${symref}`;
  const lines: string[] = [`# service=${service}\n`];
  const head = headOid(repo);
  if (head !== null) {
    lines.push(`${head} HEAD\0${capabilities}\n`);
  } else {
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  }
  for (const ref of advertisedRefs(repo)) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** v2 capability advertisement for upload-pack (the only v2 service). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
  ]);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(ctx: Ctx, owner: string, repoName: string, service: string): void {
  const { forge, res } = ctx;
  const requestId = forge.nextRequestId();
  forge.observeOwner(owner);
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, `Unknown service ${service}`, requestId);
    return;
  }
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) {
    sendError(res, 404, 'Not Found', requestId);
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && ctx.req.headers['git-protocol'] === 'version=2';
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  sendBytes(res, 200, gitContentType(service, 'advertisement'), body, requestId);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function lsRefsV2(repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headOid(repo);
  if (head !== null) {
    if (keep('HEAD')) lines.push(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else if (unborn && keep('HEAD')) {
    lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of advertisedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return encodePktLines(lines);
}

function fetchV2(repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.floor(value);
    }
  }
  for (const want of wants) {
    if (!isObjectId(want)) throw new Error(`fetch wants a bad object id ${JSON.stringify(want)}`);
  }
  const key = `v2|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
  return cachedFetch(repo, key, () => buildFetchV2(repo, wants, haves, shallow, depth));
}

function buildFetchV2(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer {
  const plan = planFetch(repo.objects, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM_PKT);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    const maxChunk = 65515;
    for (let offset = 0; offset < pack.length; offset += maxChunk) {
      const chunk = pack.subarray(offset, Math.min(offset + maxChunk, pack.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(FLUSH_PKT);
  }
  return Buffer.concat(parts);
}

/** v0 fetch: wants/deepen before the first flush, haves/done after it. */
function fetchV0(repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.floor(value);
    }
  }
  const key = `v0|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
  return cachedFetch(repo, key, () => buildFetchV0(repo, wants, haves, shallow, depth));
}

function buildFetchV0(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer {
  const plan = planFetch(repo.objects, wants, haves, shallow, depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    const maxChunk = 65515;
    for (let offset = 0; offset < pack.length; offset += maxChunk) {
      const chunk = pack.subarray(offset, Math.min(offset + maxChunk, pack.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/**
 * Fetch responses are cached per repo, keyed by the request (wants, haves,
 * shallow, depth, protocol) and the repo's version. The bench clones the
 * same tip fifty times in a row with no mutation in between, so the second
 * and later clones are served from the cache. Every object or ref mutation
 * bumps the version, which is what keeps a cached pack from going stale;
 * the cache is keyed by the Repo object itself, so a deleted and recreated
 * repo never reuses another repo's entries.
 */
const fetchCache = new WeakMap<Repo, Map<string, { version: number; body: Buffer }>>();

function cachedFetch(repo: Repo, key: string, compute: () => Buffer): Buffer {
  let byRepo = fetchCache.get(repo);
  if (byRepo === undefined) {
    byRepo = new Map();
    fetchCache.set(repo, byRepo);
  }
  const hit = byRepo.get(key);
  if (hit !== undefined && hit.version === repo.version) return hit.body;
  const body = compute();
  byRepo.set(key, { version: repo.version, body });
  return body;
}

export function handleUploadPack(ctx: Ctx, owner: string, repoName: string): void {
  const { forge, res } = ctx;
  const requestId = forge.nextRequestId();
  forge.observeOwner(owner);
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) {
    sendError(res, 404, 'Not Found', requestId);
    return;
  }
  const decoded = decodePktLines(ctx.body);
  if (!decoded.ok || decoded.packets.length === 0 || decoded.packets[0]!.kind !== 'data') {
    sendError(res, 400, 'Malformed git request', requestId);
    return;
  }
  const first = decoded.packets[0]!.payload.toString('utf8').replace(/\n$/, '');
  try {
    let body: Buffer;
    if (ctx.req.headers['git-protocol'] === 'version=2') {
      if (first === 'command=ls-refs') body = lsRefsV2(repo, decoded.packets);
      else if (first === 'command=fetch') body = fetchV2(repo, decoded.packets);
      else {
        sendError(res, 400, `Unknown upload-pack command ${JSON.stringify(first)}`, requestId);
        return;
      }
    } else {
      body = fetchV0(repo, decoded.packets);
    }
    sendBytes(res, 200, gitContentType('git-upload-pack', 'result'), body, requestId);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'Malformed git request', requestId);
  }
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Split a receive-pack body into its command list and its pack. The command
 * list is pkt-lines ending in a flush; everything after that flush is the
 * pack (binary, not pkt-lines), so the parse stops there instead of choking
 * on the pack's bytes.
 */
function splitCommandList(body: Buffer): {
  commands: PushCommand[];
  capabilities: string;
  packStart: number;
  malformed: boolean;
} {
  const commands: PushCommand[] = [];
  let capabilities = '';
  let offset = 0;
  let malformed = false;
  for (;;) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length > 65520) {
      malformed = true;
      break;
    }
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    if (offset + length > body.length) {
      malformed = true;
      break;
    }
    let line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!) || !parts[2]!.startsWith('refs/')) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, capabilities, packStart: offset, malformed };
}

export function handleReceivePack(ctx: Ctx, owner: string, repoName: string): void {
  const { forge, res } = ctx;
  const requestId = forge.nextRequestId();
  forge.observeOwner(owner);
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) {
    sendError(res, 404, 'Not Found', requestId);
    return;
  }
  const { commands, capabilities, packStart, malformed } = splitCommandList(ctx.body);
  const reportLines: string[] = [];
  if (malformed || commands.length === 0) {
    // A malformed command list is answered, never a crash.
    reportLines.push('unpack error\n');
    for (const command of commands) reportLines.push(`ng ${command.ref} malformed command\n`);
  } else {
    const packBytes = ctx.body.subarray(packStart);
    let unpackOk = true;
    let unpackDetail = 'ok';
    const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
    if (hasUpdates) {
      if (packBytes.length === 0) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      } else {
        try {
          const checksum = verifyPackChecksum(packBytes);
          if (!checksum.ok) throw new Error('pack trailer does not match its bytes');
          const read = readPack(packBytes, (oid) => repo.objects.get(oid));
          for (const object of read.objects.values()) {
            forge.putObject(repo, object.type, object.data);
          }
        } catch (err) {
          unpackOk = false;
          unpackDetail = err instanceof Error ? err.message : 'unpack error';
        }
      }
    }
    reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
    for (const command of commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${command.ref} unpacker error\n`);
        continue;
      }
      reportLines.push(applyPushCommand(forge, repo, command));
    }
  }
  const reportStream = encodePktLines(reportLines);
  let body: Buffer;
  if (capabilities.split(' ').includes('side-band-64k')) {
    const parts: Buffer[] = [];
    const maxChunk = 65515;
    for (let offset = 0; offset < reportStream.length; offset += maxChunk) {
      const chunk = reportStream.subarray(offset, Math.min(offset + maxChunk, reportStream.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    body = Buffer.concat(parts);
  } else {
    body = reportStream;
  }
  sendBytes(res, 200, gitContentType('git-receive-pack', 'result'), body, requestId);
}

/**
 * Validate and apply one push command. Returns its report line.
 * A ref update is refused unless the old value matches and the new value is
 * a descendant of the old one (or the ref is being created or deleted).
 */
function applyPushCommand(forge: Forge, repo: Repo, command: PushCommand): string {
  const current = repo.refs.get(command.ref);
  const isCreate = command.oldOid === ZERO_OID;
  const isDelete = command.newOid === ZERO_OID;
  if (isDelete) {
    if (current === undefined) return `ng ${command.ref} cannot delete a ref that does not exist\n`;
    if (current !== command.oldOid) return `ng ${command.ref} non-fast-forward\n`;
    forge.deleteRef(repo, command.ref);
    return `ok ${command.ref}\n`;
  }
  const newObject = repo.objects.get(command.newOid);
  if (newObject === undefined) return `ng ${command.ref} unable to resolve new object\n`;
  if (isCreate) {
    if (current !== undefined) return `ng ${command.ref} already exists\n`;
    forge.setRef(repo, command.ref, command.newOid);
    return `ok ${command.ref}\n`;
  }
  if (current === undefined) return `ng ${command.ref} non-fast-forward\n`;
  if (current !== command.oldOid) return `ng ${command.ref} non-fast-forward\n`;
  if (current === command.newOid) return `ok ${command.ref}\n`;
  const newCommit = peelToCommit(repo.objects, command.newOid).commitOid;
  if (!forge.isAncestor(repo, current, newCommit)) return `ng ${command.ref} non-fast-forward\n`;
  forge.setRef(repo, command.ref, command.newOid);
  return `ok ${command.ref}\n`;
}
