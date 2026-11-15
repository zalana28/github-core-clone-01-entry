// The forge's state: repositories, git objects, issues, pull requests, labels.
//
// Everything is in memory (the trial gives the entry a fresh server per run
// and the suite creates what it needs through the API), and everything is
// deterministic: the clock advances one second per event from the trial's
// fixed now (MAKEFUN_TRIAL_NOW), never from the wall clock; ids are counters;
// there is no randomness anywhere. A live run and its replay therefore write
// the same bytes.

import {
  buildCommit,
  buildTree,
  collectTreeObjects,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type ObjectType,
} from './gitproto.ts';
import { VIEWER, type ScenarioUser } from './scenario.ts';

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  /** A stable numeric id (repo database id x 1,000,000 + number). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  dbId: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  counter: number;
  commentCounter: number;
  /**
   * Bumped on every object or ref mutation. Fetch responses are cached
   * against it, so a bump is what keeps a cached pack from going stale.
   */
  version: number;
}

export interface FileEntry {
  oid: string;
  mode: string;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Parse the trial's fixed now (RFC 3339 or epoch milliseconds) into seconds. */
function parseTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return Math.floor(asNumber / 1000);
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) return Math.floor(asDate / 1000);
  }
  return Math.floor(Date.parse('2026-11-14T10:00:00Z') / 1000);
}

/** Count line additions/deletions between two blob contents (multiset diff). */
function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const lines = new Map<string, number>();
    for (const line of text.split('\n')) lines.set(line, (lines.get(line) ?? 0) + 1);
    return lines;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) {
    const inOld = oldLines.get(line) ?? 0;
    if (n > inOld) additions += n - inOld;
  }
  for (const [line, n] of oldLines) {
    const inNew = newLines.get(line) ?? 0;
    if (n > inNew) deletions += n - inNew;
  }
  return { additions, deletions };
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly viewer: ScenarioUser = VIEWER;
  /** The login first seen in a request path; the suite always names the viewer first. */
  private observedLogin: string | null = null;
  private nextRepoDbId = 5000;
  private nextCommentId = 1;
  private requestSeq = 0;
  private clockSeconds: number;

  constructor() {
    this.clockSeconds = parseTrialNow();
  }

  // -- identity -------------------------------------------------------------

  /** The viewer login: the one observed in a request, else the seeded one. */
  viewerLogin(): string {
    return this.observedLogin ?? this.viewer.login;
  }

  /** Learn the login from an owner named in a request (first sight wins). */
  observeOwner(login: string): void {
    if (this.observedLogin === null) this.observedLogin = login;
  }

  /** A repository belongs to the token's login; any other owner is not found. */
  isOwner(login: string): boolean {
    return login === this.viewer.login || login === this.observedLogin;
  }

  /** A fresh request id (X-GitHub-Request-Id), one per reply, in order. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  // -- the logical clock ----------------------------------------------------

  /** Advance the clock one second and return the new instant. */
  tick(): { iso: string; unix: number } {
    this.clockSeconds += 1;
    return { iso: new Date(this.clockSeconds * 1000).toISOString(), unix: this.clockSeconds };
  }

  /** The current instant without advancing (for timestamps read, not written). */
  nowIso(): string {
    return new Date(this.clockSeconds * 1000).toISOString();
  }

  /** The author/committer line for a commit made by the viewer at `unix`. */
  identityLine(unix: number): string {
    return `${this.viewer.name} <${this.viewer.email}> ${unix} +0000`;
  }

  // -- global ids -----------------------------------------------------------

  /** An opaque, stable GraphQL node id (never a plain database id or number). */
  nodeId(kind: string, ...parts: (string | number)[]): string {
    const raw = `${kind}:${parts.join(':')}`;
    return Buffer.from(raw, 'utf8').toString('base64url');
  }

  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  // -- repositories ---------------------------------------------------------

  getRepo(owner: string, name: string): Repo | null {
    if (!this.isOwner(owner)) return null;
    return this.repos.get(name) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const { iso } = this.tick();
    const repo: Repo = {
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: iso,
      dbId: this.nextRepoDbId,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      counter: 0,
      commentCounter: 0,
      version: 0,
    };
    this.nextRepoDbId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  // -- git objects and refs -------------------------------------------------

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  /** Set a ref (bumping the repo version, so cached fetch packs go stale). */
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
  }

  /** Delete a ref (bumping the repo version, so cached fetch packs go stale). */
  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.version += 1;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The commit a ref points at (tags peeled), or null if it does not resolve. */
  commitForRef(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    return peelToCommit(repo.objects, oid).commitOid;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /**
   * The merge base of two commits: the common ancestor closest to both
   * (smallest sum of distances). Linear and simple-fork histories, which is
   * everything the suite builds, resolve exactly.
   */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const distances = (start: string): Map<string, number> => {
      const dist = new Map<string, number>([[start, 0]]);
      const queue = [start];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          if (!dist.has(parent)) {
            dist.set(parent, dist.get(oid)! + 1);
            queue.push(parent);
          }
        }
      }
      return dist;
    };
    const distA = distances(a);
    const distB = distances(b);
    let best: string | null = null;
    let bestSum = Number.POSITIVE_INFINITY;
    for (const [oid, dA] of distA) {
      const dB = distB.get(oid);
      if (dB === undefined) continue;
      if (dA + dB < bestSum) {
        bestSum = dA + dB;
        best = oid;
      }
    }
    return best;
  }

  // -- file maps ------------------------------------------------------------

  /** The full path -> blob map of a tree, walking it recursively. */
  fileMap(repo: Repo, treeOid: string): Map<string, FileEntry> {
    const files = new Map<string, FileEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /** The file map at a branch tip (empty when the branch is unborn). */
  fileMapAtBranch(repo: Repo, branch: string): Map<string, FileEntry> {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return new Map();
    const commit = repo.objects.get(peelToCommit(repo.objects, tip).commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return this.fileMap(repo, parseCommit(commit.data).tree);
  }

  /** Build (and store) the tree for a file map, bottom-up. */
  treeFromFileMap(repo: Repo, files: Map<string, FileEntry>): string {
    const buildDir = (paths: Array<{ parts: string[]; entry: FileEntry }>): string => {
      const children = new Map<string, Array<{ parts: string[]; entry: FileEntry }>>();
      const direct: Array<{ mode: string; name: string; oid: string }> = [];
      for (const item of paths) {
        if (item.parts.length === 1) {
          direct.push({ mode: item.entry.mode, name: item.parts[0]!, oid: item.entry.oid });
        } else {
          const dir = item.parts[0]!;
          const rest = children.get(dir) ?? [];
          rest.push({ parts: item.parts.slice(1), entry: item.entry });
          children.set(dir, rest);
        }
      }
      for (const [dir, items] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        direct.push({ mode: '40000', name: dir, oid: buildDir(items) });
      }
      return this.putObject(repo, 'tree', buildTree(direct));
    };
    const items = [...files.entries()]
      .map(([path, entry]) => ({ parts: path.split('/'), entry }))
      .sort((a, b) => (a.parts.join('/') < b.parts.join('/') ? -1 : 1));
    return buildDir(items);
  }

  /** Create a commit on a branch from a file map, advancing the ref. */
  commitOnBranch(repo: Repo, branch: string, files: Map<string, FileEntry>, message: string): string {
    const { unix } = this.tick();
    const treeOid = this.treeFromFileMap(repo, files);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const parents = tip === undefined ? [] : [peelToCommit(repo.objects, tip).commitOid];
    const identity = this.identityLine(unix);
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message }),
    );
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** The commits on a branch, newest first, following first parents. */
  branchCommits(repo: Repo, branch: string): string[] {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return [];
    const commits: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = peelToCommit(repo.objects, tip).commitOid;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      commits.push(current);
      current = parseCommit(object.data).parents[0];
    }
    return commits;
  }

  // -- pull requests --------------------------------------------------------

  /** The file diff between two file maps, with line counts. */
  diffFileMaps(base: Map<string, FileEntry>, head: Map<string, FileEntry>, repo: Repo): FileDiff[] {
    const diffs: FileDiff[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const baseEntry = base.get(path);
      const headEntry = head.get(path);
      if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid === headEntry.oid) continue;
      if (baseEntry === undefined && headEntry !== undefined) {
        const blob = repo.objects.get(headEntry.oid);
        const lines = blob === undefined ? 0 : blob.data.toString('utf8').split('\n').length - (blob.data.length === 0 ? 1 : 0);
        diffs.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
        continue;
      }
      if (baseEntry !== undefined && headEntry === undefined) {
        const blob = repo.objects.get(baseEntry.oid);
        const lines = blob === undefined ? 0 : blob.data.toString('utf8').split('\n').length - (blob.data.length === 0 ? 1 : 0);
        diffs.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
        continue;
      }
      const oldBlob = repo.objects.get(baseEntry!.oid);
      const newBlob = repo.objects.get(headEntry!.oid);
      const { additions, deletions } = countLineDiff(
        oldBlob?.data.toString('utf8') ?? '',
        newBlob?.data.toString('utf8') ?? '',
      );
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
    return diffs;
  }

  /** The files a pull request would change (merge base vs head). */
  pullRequestFiles(repo: Repo, pull: Pull): FileDiff[] {
    const headTip = this.commitForRef(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.commitForRef(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === null || baseTip === null) return [];
    const mergeBase = this.mergeBase(repo, headTip, baseTip);
    const baseFiles =
      mergeBase === null
        ? new Map<string, FileEntry>()
        : this.fileMap(repo, parseCommit(repo.objects.get(mergeBase)!.data).tree);
    const headFiles = this.fileMap(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
    return this.diffFileMaps(baseFiles, headFiles, repo);
  }

  /**
   * Would merging this pull request conflict? A path conflicts when it
   * changed on both sides of the merge base with different results (or was
   * deleted on one side and changed on the other).
   */
  pullRequestConflicts(repo: Repo, pull: Pull): boolean {
    const headTip = this.commitForRef(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.commitForRef(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === null || baseTip === null) return false;
    const mergeBase = this.mergeBase(repo, headTip, baseTip);
    if (mergeBase === null) return false;
    const baseFiles = this.fileMap(repo, parseCommit(repo.objects.get(mergeBase)!.data).tree);
    const headFiles = this.fileMap(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
    const baseTipFiles = this.fileMap(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const atBase = baseFiles.get(path)?.oid;
      const atHead = headFiles.get(path)?.oid;
      const atBaseTip = baseTipFiles.get(path)?.oid;
      const headChanged = atHead !== atBase;
      const baseChanged = atBaseTip !== atBase;
      if (headChanged && baseChanged && atHead !== atBaseTip) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns null on conflict. */
  mergePullRequest(repo: Repo, pull: Pull): { sha: string } | null {
    if (pull.merged || pull.state !== 'open') return null;
    if (this.pullRequestConflicts(repo, pull)) return null;
    const headTip = this.commitForRef(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.commitForRef(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === null || baseTip === null) return null;
    const mergeBase = this.mergeBase(repo, headTip, baseTip);
    const baseFiles =
      mergeBase === null
        ? new Map<string, FileEntry>()
        : this.fileMap(repo, parseCommit(repo.objects.get(mergeBase)!.data).tree);
    const headFiles = this.fileMap(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
    const baseTipFiles = this.fileMap(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
    // The merged tree is the base tip's files with the head's changes applied.
    const merged = new Map<string, FileEntry>(baseTipFiles);
    for (const [path, entry] of headFiles) merged.set(path, entry);
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path) && baseTipFiles.get(path)?.oid === baseFiles.get(path)?.oid) {
        merged.delete(path);
      }
    }
    const { iso, unix } = this.tick();
    const treeOid = this.treeFromFileMap(repo, merged);
    const identity = this.identityLine(unix);
    const mergeCommit = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [baseTip],
        author: identity,
        committer: identity,
        message: `Merge pull request #${pull.number} from ${pull.headRef}`,
      }),
    );
    this.setRef(repo, `refs/heads/${pull.baseRef}`, mergeCommit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso;
    pull.mergeCommitSha = mergeCommit;
    pull.updatedAt = iso;
    return { sha: mergeCommit };
  }

  /** All objects reachable from a commit (for the clone benchmark's setup). */
  reachableObjects(repo: Repo, tip: string): Map<string, GitObject> {
    const objects = new Map<string, GitObject>();
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      objects.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        collectTreeObjects(repo.objects, commit.tree, objects);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return objects;
  }
}
