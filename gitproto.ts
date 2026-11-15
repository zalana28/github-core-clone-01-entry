// Pure git plumbing: object model, pkt-lines, packs and reachability.
//
// No I/O, no clock, no randomness. Everything here is a deterministic function
// of its inputs, which is what makes a live run and its replay produce the same
// bytes. The object formats follow git exactly (SHA-1 ids over
// "<type> <size>\0<data>"), so a real git client round-trips against this forge.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflateSync, inflateSync as zlibInflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return OID_RE.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: SHA-1 of "<type> <size>\0<data>". */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// Commits, trees, tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly authorTime: number;
  readonly committer: string;
  readonly committerTime: number;
  readonly message: string;
}

/** Parse a commit's bytes. The author/committer lines keep their full text. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let authorTime = 0;
  let committer = '';
  let committerTime = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      authorTime = Number(author.split(' ').at(-2) ?? '0') || 0;
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      committerTime = Number(committer.split(' ').at(-2) ?? '0') || 0;
    }
  }
  return { tree, parents, author, authorTime, committer, committerTime, message };
}

/** Build a commit's bytes: headers, a blank line, then the message (ending in \n). */
export function buildCommit(commit: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`, `committer ${commit.committer}`, '');
  const message = commit.message.endsWith('\n') ? commit.message : `${commit.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree's binary entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries by name, with directories compared as "name/". */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Build a tree's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(tag: { object: string; type: ObjectType; tag: string; tagger: string; message: string }): Buffer {
  const lines = [`object ${tag.object}`, `type ${tag.type}`, `tag ${tag.tag}`, `tagger ${tag.tagger}`, ''];
  const message = tag.message.endsWith('\n') ? tag.message : `${tag.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

/** One pkt-line: 4 hex digits of the total length (header included) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line too long: ${length} bytes`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** Encode data pkt-lines, then a flush (or a delim, when `end` is 'delim'). */
export function encodePktLines(lines: readonly (string | Buffer)[], end: 'flush' | 'delim' = 'flush'): Buffer {
  const parts = lines.map((line) => pktLine(line));
  parts.push(end === 'delim' ? DELIM_PKT : FLUSH_PKT);
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim';
export interface DecodedPkt {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/**
 * Decode pkt-lines from the front of `buf`. Stops at the first malformed
 * packet and reports how far it got, so a caller can decide whether the input
 * is garbage (a malformed POST must not kill the server).
 */
export function decodePktLines(buf: Buffer): { packets: DecodedPkt[]; consumed: number; ok: boolean } {
  const packets: DecodedPkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = Number.parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length > 65520) return { packets, consumed: offset, ok: false };
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) return { packets, consumed: offset, ok: false };
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset, ok: offset === buf.length };
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a pack (version 2, plain objects, no deltas) with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const object of objects) {
    const typeCode = TYPE_CODES[object.type];
    let size = object.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const header: number[] = [size === 0 ? first : first | 0x80];
    while (size !== 0) {
      const byte = size & 0x7f;
      size >>= 7;
      header.push(size === 0 ? byte : byte | 0x80);
    }
    parts.push(Buffer.from(header));
    parts.push(zlibDeflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Check a pack's trailer against its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  return { ok: expected === actual, expected, actual };
}

/**
 * Inflate a zlib stream that starts at `offset` and find how many bytes it
 * consumed. inflateSync ignores trailing junk but throws on a truncated
 * stream, so the smallest slice that inflates cleanly is the stream itself.
 */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  let low = offset + 1;
  let high = buf.length;
  let found: { data: Buffer; consumed: number } | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const data = zlibInflateSync(buf.subarray(offset, mid));
      found = { data, consumed: mid - offset };
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (found === null) throw new Error('no valid zlib stream at offset ' + offset);
  return found;
}

/** Apply a git delta to its base, producing the result object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint runs past the end');
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) copyOffset = delta[offset]!, offset += 1;
      if ((op & 0x02) !== 0) copyOffset |= delta[offset]! << 8, offset += 1;
      if ((op & 0x04) !== 0) copyOffset |= delta[offset]! << 16, offset += 1;
      if ((op & 0x08) !== 0) copyOffset |= delta[offset]! << 24, offset += 1;
      if ((op & 0x10) !== 0) copySize = delta[offset]!, offset += 1;
      if ((op & 0x20) !== 0) copySize |= delta[offset]! << 8, offset += 1;
      if ((op & 0x40) !== 0) copySize |= delta[offset]! << 16, offset += 1;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert runs past the end');
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta op 0 is invalid');
    }
  }
  if (produced !== resultSize) throw new Error(`delta produced ${produced} bytes, expected ${resultSize}`);
  return Buffer.concat(parts);
}

/**
 * Read a pack (version 2 or 3), resolving OFS and REF deltas. A REF delta
 * whose base is not in the pack is looked up through `resolveBase` (the
 * receiving repo's object store). Returns the objects keyed by their id.
 */
export function readPack(
  pack: Buffer,
  resolveBase: (oid: string) => GitObject | undefined,
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack (bad magic)');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const readTypeSize = (): { type: number; size: number } => {
    let byte = pack[offset]!;
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= pack.length) throw new Error('object header runs past the pack');
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { type, size };
  };
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    const { type, size } = readTypeSize();
    let object: GitObject;
    if (type === 6) {
      // OFS_DELTA: the base is an earlier entry in this pack.
      let byte = pack[offset]!;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseEntryOffset = entryStart - baseOffset;
      const base = byOffset.get(baseEntryOffset);
      if (base === undefined) throw new Error(`ofs-delta base at offset ${baseEntryOffset} is not in the pack`);
      const { data, consumed } = inflateAt(pack, offset);
      offset += consumed;
      const resolved = applyDelta(base.data, data);
      if (resolved.length !== size) throw new Error('ofs-delta resolved to the wrong size');
      object = { type: base.type, data: resolved };
      deltaCount += 1;
    } else if (type === 7) {
      // REF_DELTA: the base is named by id.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid) ?? resolveBase(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      const { data, consumed } = inflateAt(pack, offset);
      offset += consumed;
      const resolved = applyDelta(base.data, data);
      if (resolved.length !== size) throw new Error('ref-delta resolved to the wrong size');
      object = { type: base.type, data: resolved };
      deltaCount += 1;
    } else {
      const objectType = PACK_TYPES[type];
      if (objectType === undefined) throw new Error(`unknown pack object type ${type}`);
      const { data, consumed } = inflateAt(pack, offset);
      offset += consumed;
      if (data.length !== size) throw new Error(`object size ${data.length} does not match header ${size}`);
      object = { type: objectType, data };
    }
    const oid = objectId(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryStart, object);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------
// Reachability (what a fetch sends)
// ---------------------------------------------------------------------------

export interface ObjectStore {
  get(oid: string): GitObject | undefined;
}

/** Follow tag objects to the commit they point at, collecting the tag ids. */
export function peelToCommit(store: ObjectStore, oid: string): { commitOid: string; tagOids: string[] } {
  const tagOids: string[] = [];
  let current = oid;
  for (;;) {
    const object = store.get(current);
    if (object === undefined) return { commitOid: current, tagOids };
    if (object.type !== 'tag') return { commitOid: current, tagOids };
    tagOids.push(current);
    current = parseTag(object.data).object;
  }
}

/** Walk a tree recursively, collecting every tree and blob under it. */
export function collectTreeObjects(store: ObjectStore, treeOid: string, into: Map<string, GitObject>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') continue;
    into.set(oid, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else if (!into.has(entry.oid)) {
        const blob = store.get(entry.oid);
        if (blob !== undefined) into.set(entry.oid, blob);
      }
    }
  }
}

export interface FetchPlan {
  /** The objects to send, in a deterministic order. */
  readonly objects: GitObject[];
  /** The new shallow boundary (commits at the deepest included level). */
  readonly shallow: string[];
  /** Old shallow boundaries that are now included and no longer a boundary. */
  readonly unshallow: string[];
}

/**
 * Compute what a fetch sends. `wants` are the requested ids (commits, tags,
 * or, defensively, trees/blobs). `haves` are the ids the client already
 * holds; `oldShallow` are its shallow boundaries (included in the held set,
 * but their parents are not held). `depth` limits how many generations from
 * each want are included (1 = the tip only).
 *
 * Shallow means the commits at distance depth-1 from a want; unshallow means
 * an old boundary that is now included and is no longer at the boundary.
 */
export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const included = new Map<string, GitObject>();
  const commitDistance = new Map<string, number>();
  const queue: Array<{ oid: string; distance: number }> = [];
  const tagObjects: GitObject[] = [];
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(object);
      const peeled = peelToCommit(store, want);
      queue.push({ oid: peeled.commitOid, distance: 0 });
      continue;
    }
    if (object.type === 'commit') {
      queue.push({ oid: want, distance: 0 });
      continue;
    }
    included.set(want, object);
  }
  // Breadth-first over commits, nearest tip first.
  const ordered: string[] = [];
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (commitDistance.has(oid)) continue;
    if (depth !== null && distance >= depth) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commitDistance.set(oid, distance);
    ordered.push(oid);
    if (depth === null || distance + 1 < depth) {
      for (const parent of parseCommit(object.data).parents) {
        if (!commitDistance.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
      }
    }
  }
  // Held set: everything reachable from the haves, stopping at old boundaries
  // (a boundary commit is held, but its parents are not).
  const held = new Set<string>();
  const heldBoundary = new Set(oldShallow);
  const heldQueue: string[] = [];
  for (const have of haves) {
    const object = store.get(have);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      held.add(have);
      const peeled = peelToCommit(store, have);
      heldQueue.push(peeled.commitOid);
      continue;
    }
    heldQueue.push(have);
  }
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.shift()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = store.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type !== 'commit') continue;
    const treeObjects = new Map<string, GitObject>();
    collectTreeObjects(store, parseCommit(object.data).tree, treeObjects);
    for (const key of treeObjects.keys()) held.add(key);
    if (heldBoundary.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
  }
  // Included trees and blobs for every included commit.
  for (const oid of ordered) {
    const object = store.get(oid);
    if (object === undefined) continue;
    included.set(oid, object);
    const treeOid = parseCommit(object.data).tree;
    collectTreeObjects(store, treeOid, included);
  }
  for (const tag of tagObjects) included.set(objectId(tag.type, tag.data), tag);
  // Send = included minus held.
  const send = new Map<string, GitObject>();
  for (const [oid, object] of included) {
    if (!held.has(oid)) send.set(oid, object);
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of ordered) {
      if (commitDistance.get(oid) === depth - 1) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    if (commitDistance.has(boundary) && !shallow.includes(boundary)) unshallow.push(boundary);
  }
  return { objects: [...send.values()], shallow, unshallow };
}
