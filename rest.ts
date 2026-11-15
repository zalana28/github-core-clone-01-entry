// REST v3: repositories, branches, commits, contents, labels, issues, pulls.
//
// The shapes follow what the suite's rest client reads: repos carry name,
// private, default_branch and description; issues carry number, title, body,
// state and labels; pulls carry head/base with ref and sha, plus merged,
// merged_at and merge_commit_sha after a merge. Every list is paginated with
// per_page/page and a Link rel="next" when there is another page. Unknown
// owners or missing resources are 404 (never 403); a stale content sha is
// 409; a label that does not exist or a duplicate create is 422.

import { parseCommit, parseTree, peelToCommit } from './gitproto.ts';
import { bodyObject, parseJsonBody, sendError, sendJson, type Ctx } from './http.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

const OWNER_LOGIN = (forge: Forge): string => forge.viewerLogin();

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${OWNER_LOGIN(forge)}/${repo.name}`,
    owner: { login: OWNER_LOGIN(forge), id: forge.viewer.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.commitForRef(repo, `refs/heads/${pull.headRef}`);
  const baseSha = forge.commitForRef(repo, `refs/heads/${pull.baseRef}`);
  return {
    id: repo.dbId * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(ctx: Ctx): PageParams {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], { page, perPage }: PageParams): { items: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

function linkHeader(ctx: Ctx, { page, perPage }: PageParams, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const url = new URL(ctx.req.url ?? '/', 'http://localhost');
  url.searchParams.set('page', String(page + 1));
  url.searchParams.set('per_page', String(perPage));
  // The Link must be absolute and stay on the entry's own origin: the
  // client follows it only when it starts with the entry's base URL.
  const host = ctx.req.headers.host ?? 'localhost';
  return { link: `<http://${host}${url.pathname}${url.search}>; rel="next"` };
}

function repoOr404(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === null) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return null;
  }
  return repo;
}

/** Resolve a ?ref= (branch name or commit id) to a commit, or null. */
function commitForRefParam(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return forge.commitForRef(repo, `refs/heads/${repo.defaultBranch}`);
  }
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return peelToCommit(repo.objects, branchTip).commitOid;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

// ---------------------------------------------------------------------------
// Root, meta, user
// ---------------------------------------------------------------------------

function handleRoot(ctx: Ctx): void {
  sendJson(
    ctx.res,
    200,
    {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
    },
    ctx.forge.nextRequestId(),
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleMeta(ctx: Ctx): void {
  sendJson(ctx.res, 200, { installed_version: '1.0.0' }, ctx.forge.nextRequestId());
}

function handleUser(ctx: Ctx): void {
  const viewer = ctx.forge.viewer;
  sendJson(
    ctx.res,
    200,
    { login: OWNER_LOGIN(ctx.forge), id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' },
    ctx.forge.nextRequestId(),
  );
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function handleCreateRepo(ctx: Ctx): void {
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') {
    sendError(ctx.res, 422, 'name is required', ctx.forge.nextRequestId());
    return;
  }
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  const repo = ctx.forge.createRepo(name, description, isPrivate);
  if (repo === null) {
    sendError(ctx.res, 422, 'Repository already exists', ctx.forge.nextRequestId());
    return;
  }
  sendJson(ctx.res, 201, repoJson(ctx.forge, repo), ctx.forge.nextRequestId());
}

function handleListUserRepos(ctx: Ctx): void {
  const params = pageParams(ctx);
  const { items, hasNext } = paginate(ctx.forge.listRepos(), params);
  sendJson(
    ctx.res,
    200,
    items.map((repo) => repoJson(ctx.forge, repo)),
    ctx.forge.nextRequestId(),
    linkHeader(ctx, params, hasNext),
  );
}

function handleGetRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  sendJson(ctx.res, 200, repoJson(ctx.forge, repo), ctx.forge.nextRequestId());
}

function handlePatchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  if (typeof body.description === 'string') repo.description = body.description;
  sendJson(ctx.res, 200, repoJson(ctx.forge, repo), ctx.forge.nextRequestId());
}

function handleDeleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  ctx.forge.deleteRepo(repo.name);
  ctx.res.writeHead(204, { 'x-github-request-id': ctx.forge.nextRequestId() });
  ctx.res.end();
}

// ---------------------------------------------------------------------------
// Branches, commits, refs
// ---------------------------------------------------------------------------

function handleListBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .sort()
    .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
  sendJson(ctx.res, 200, branches, ctx.forge.nextRequestId());
}

function handleGetBranch(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  sendJson(ctx.res, 200, { name: branch, commit: { sha } }, ctx.forge.nextRequestId());
}

function handleListCommits(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const branch = ctx.query.get('sha') ?? repo.defaultBranch;
  const commits = ctx.forge.branchCommits(repo, branch).map((sha) => {
    const object = repo.objects.get(sha)!;
    const parsed = parseCommit(object.data);
    return {
      sha,
      commit: {
        // The stored message ends in a newline (git convention); the REST
        // API reports it without that trailing newline.
        message: parsed.message.replace(/\n$/, ''),
        author: { name: parsed.author, date: new Date(parsed.authorTime * 1000).toISOString() },
        committer: { name: parsed.committer, date: new Date(parsed.committerTime * 1000).toISOString() },
      },
    };
  });
  const params = pageParams(ctx);
  const { items, hasNext } = paginate(commits, params);
  sendJson(ctx.res, 200, items, ctx.forge.nextRequestId(), linkHeader(ctx, params, hasNext));
}

function handleListRefs(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const refs = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
  sendJson(ctx.res, 200, refs, ctx.forge.nextRequestId());
}

function handleCreateRef(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || sha === '') {
    sendError(ctx.res, 422, 'ref and sha are required', ctx.forge.nextRequestId());
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Reference already exists', ctx.forge.nextRequestId());
    return;
  }
  if (repo.objects.get(sha) === undefined) {
    sendError(ctx.res, 422, 'Object does not exist', ctx.forge.nextRequestId());
    return;
  }
  ctx.forge.setRef(repo, ref, sha);
  sendJson(ctx.res, 201, { ref, object: { sha, type: 'commit' } }, ctx.forge.nextRequestId());
}

function handleGetRef(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  sendJson(ctx.res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }, ctx.forge.nextRequestId());
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

/** The tree id of a directory: build its subtree from the files under it. */
function dirTreeOid(forge: Forge, repo: Repo, files: Map<string, { oid: string; mode: string }>, dirPath: string): string {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const sub = new Map<string, { oid: string; mode: string }>();
  for (const [path, entry] of files) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), entry);
  }
  return forge.treeFromFileMap(repo, sub);
}

function handleGetContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const commitOid = commitForRefParam(ctx.forge, repo, ctx.query.get('ref'));
  if (commitOid === null) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  const files = ctx.forge.fileMap(repo, parseCommit(repo.objects.get(commitOid)!.data).tree);
  if (path === '') {
    // The root listing: one entry per top-level file and directory.
    const top = new Map<string, { type: string; oid: string; size: number }>();
    for (const [filePath, entry] of files) {
      const slash = filePath.indexOf('/');
      if (slash < 0) {
        top.set(filePath, { type: 'file', oid: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
      } else {
        const dir = filePath.slice(0, slash);
        if (!top.has(dir)) top.set(dir, { type: 'dir', oid: dirTreeOid(ctx.forge, repo, files, dir), size: 0 });
      }
    }
    const listing = [...top.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([entryName, entry]) => ({ type: entry.type, name: entryName, path: entryName, sha: entry.oid, size: entry.size }));
    sendJson(ctx.res, 200, listing, ctx.forge.nextRequestId());
    return;
  }
  const file = files.get(path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    const content = blob?.data.toString('base64') ?? '';
    sendJson(
      ctx.res,
      200,
      {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: blob?.data.length ?? 0,
        content,
      },
      ctx.forge.nextRequestId(),
    );
    return;
  }
  const prefix = `${path}/`;
  const children = new Map<string, { type: string; oid: string; size: number }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { type: 'file', oid: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        children.set(dir, { type: 'dir', oid: dirTreeOid(ctx.forge, repo, files, `${path}/${dir}`), size: 0 });
      }
    }
  }
  if (children.size === 0) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  const listing = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([entryName, entry]) => ({
      type: entry.type,
      name: entryName,
      path: `${path}/${entryName}`,
      sha: entry.oid,
      size: entry.size,
    }));
  sendJson(ctx.res, 200, listing, ctx.forge.nextRequestId());
}

function handlePutContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
  const content = typeof body.content === 'string' ? body.content : '';
  let decoded: Buffer;
  try {
    decoded = Buffer.from(content, 'base64');
    if (content !== '' && decoded.length === 0 && !/^=*$/.test(content)) throw new Error('bad base64');
  } catch {
    sendError(ctx.res, 400, 'content is not valid base64', ctx.forge.nextRequestId());
    return;
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  if (!repo.refs.has(`refs/heads/${branch}`)) {
    // A contents write on a branch that does not exist yet creates it from
    // the default branch tip (the MCP fallback relies on this).
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) ctx.forge.setRef(repo, `refs/heads/${branch}`, defaultTip);
  }
  const files = ctx.forge.fileMapAtBranch(repo, branch);
  const existing = files.get(path);
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (existing !== undefined) {
    if (sha === '' || sha !== existing.oid) {
      sendError(ctx.res, 409, 'sha does not match the current file', ctx.forge.nextRequestId());
      return;
    }
    const blobOid = ctx.forge.putObject(repo, 'blob', decoded);
    files.set(path, { oid: blobOid, mode: existing.mode });
    const commitSha = ctx.forge.commitOnBranch(repo, branch, files, message);
    sendJson(
      ctx.res,
      200,
      { content: { type: 'file', encoding: 'base64', name: path.split('/').pop(), path, sha: blobOid, size: decoded.length }, commit: { sha: commitSha } },
      ctx.forge.nextRequestId(),
    );
    return;
  }
  const blobOid = ctx.forge.putObject(repo, 'blob', decoded);
  files.set(path, { oid: blobOid, mode: '100644' });
  const commitSha = ctx.forge.commitOnBranch(repo, branch, files, message);
  sendJson(
    ctx.res,
    201,
    { content: { type: 'file', encoding: 'base64', name: path.split('/').pop(), path, sha: blobOid, size: decoded.length }, commit: { sha: commitSha } },
    ctx.forge.nextRequestId(),
  );
}

function handleDeleteContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
  const sha = typeof body.sha === 'string' ? body.sha : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const files = ctx.forge.fileMapAtBranch(repo, branch);
  const existing = files.get(path);
  if (existing === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  if (sha === '' || sha !== existing.oid) {
    sendError(ctx.res, 409, 'sha does not match the current file', ctx.forge.nextRequestId());
    return;
  }
  files.delete(path);
  const commitSha = ctx.forge.commitOnBranch(repo, branch, files, message);
  sendJson(ctx.res, 200, { commit: { sha: commitSha } }, ctx.forge.nextRequestId());
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function handleCreateLabel(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const labelName = typeof body.name === 'string' ? body.name : '';
  if (labelName === '') {
    sendError(ctx.res, 422, 'name is required', ctx.forge.nextRequestId());
    return;
  }
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  const existing = repo.labels.get(labelName);
  if (existing !== undefined) {
    sendJson(ctx.res, 201, { name: existing.name, color: existing.color }, ctx.forge.nextRequestId());
    return;
  }
  repo.labels.set(labelName, { name: labelName, color });
  sendJson(ctx.res, 201, { name: labelName, color }, ctx.forge.nextRequestId());
}

function handleListLabels(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const labels = [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color }));
  sendJson(ctx.res, 200, labels, ctx.forge.nextRequestId());
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleCreateIssue(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendError(ctx.res, 422, 'title is required', ctx.forge.nextRequestId());
    return;
  }
  const labels: string[] = Array.isArray(body.labels)
    ? body.labels.filter((label): label is string => typeof label === 'string')
    : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      sendError(ctx.res, 422, `Label does not exist: ${label}`, ctx.forge.nextRequestId());
      return;
    }
  }
  const { iso } = ctx.forge.tick();
  repo.counter += 1;
  const issue: Issue = {
    id: repo.dbId * 1_000_000 + repo.counter,
    number: repo.counter,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    createdAt: iso,
    updatedAt: iso,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  sendJson(ctx.res, 201, issueJson(issue), ctx.forge.nextRequestId());
}

function handleListIssues(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return direction === 'asc' ? (a.createdAt < b.createdAt ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1;
      return direction === 'asc' ? a.number - b.number : b.number - a.number;
    });
  }
  const params = pageParams(ctx);
  const { items, hasNext } = paginate(issues, params);
  sendJson(ctx.res, 200, items.map(issueJson), ctx.forge.nextRequestId(), linkHeader(ctx, params, hasNext));
}

function handleGetIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  sendJson(ctx.res, 200, issueJson(issue), ctx.forge.nextRequestId());
}

function handlePatchIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  issue.updatedAt = ctx.forge.tick().iso;
  sendJson(ctx.res, 200, issueJson(issue), ctx.forge.nextRequestId());
}

function handleCreateComment(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') {
    sendError(ctx.res, 422, 'body is required', ctx.forge.nextRequestId());
    return;
  }
  const { iso } = ctx.forge.tick();
  const comment = { id: ctx.forge.nextCommentIdValue(), body: text, createdAt: iso, updatedAt: iso };
  issue.comments.push(comment);
  sendJson(ctx.res, 201, comment, ctx.forge.nextRequestId());
}

function handleListComments(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  const params = pageParams(ctx);
  const { items, hasNext } = paginate(issue.comments, params);
  sendJson(ctx.res, 200, items, ctx.forge.nextRequestId(), linkHeader(ctx, params, hasNext));
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function handleCreatePull(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '' || base === '') {
    sendError(ctx.res, 422, 'title, head and base are required', ctx.forge.nextRequestId());
    return;
  }
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) {
    sendError(ctx.res, 422, 'head or base branch does not exist', ctx.forge.nextRequestId());
    return;
  }
  const headCommit = peelToCommit(repo.objects, headTip).commitOid;
  const baseCommit = peelToCommit(repo.objects, baseTip).commitOid;
  if (headCommit === baseCommit) {
    sendError(ctx.res, 422, 'No commits between head and base', ctx.forge.nextRequestId());
    return;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      sendError(ctx.res, 422, 'A pull request already exists for this head and base', ctx.forge.nextRequestId());
      return;
    }
  }
  const { iso } = ctx.forge.tick();
  repo.counter += 1;
  const pull: Pull = {
    number: repo.counter,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: iso,
    updatedAt: iso,
  };
  repo.pulls.set(pull.number, pull);
  sendJson(ctx.res, 201, pullJson(ctx.forge, repo, pull), ctx.forge.nextRequestId());
}

function handleListPulls(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const params = pageParams(ctx);
  const { items, hasNext } = paginate(pulls, params);
  sendJson(
    ctx.res,
    200,
    items.map((pull) => pullJson(ctx.forge, repo, pull)),
    ctx.forge.nextRequestId(),
    linkHeader(ctx, params, hasNext),
  );
}

function handleGetPull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  sendJson(ctx.res, 200, pullJson(ctx.forge, repo, pull), ctx.forge.nextRequestId());
}

function handleListPullFiles(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  sendJson(ctx.res, 200, ctx.forge.pullRequestFiles(repo, pull), ctx.forge.nextRequestId());
}

function handleMergePull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
    return;
  }
  if (pull.merged || pull.state !== 'open') {
    sendError(ctx.res, 405, 'Pull request is already closed', ctx.forge.nextRequestId());
    return;
  }
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Invalid JSON in request body', ctx.forge.nextRequestId());
    return;
  }
  if (ctx.forge.pullRequestConflicts(repo, pull)) {
    sendError(ctx.res, 405, 'Merge conflict', ctx.forge.nextRequestId());
    return;
  }
  const merged = ctx.forge.mergePullRequest(repo, pull);
  if (merged === null) {
    sendError(ctx.res, 405, 'Merge conflict', ctx.forge.nextRequestId());
    return;
  }
  sendJson(ctx.res, 200, { sha: merged.sha, merged: true, message: `Pull request #${number} merged` }, ctx.forge.nextRequestId());
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Dispatch a REST request. Returns true when a route matched. */
export function handleRest(ctx: Ctx): boolean {
  const { req } = ctx;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  const owner = rest[1] !== undefined ? decodeURIComponent(rest[1]) : '';
  const repoName = rest[2] !== undefined ? decodeURIComponent(rest[2]) : '';

  if (rest.length === 0) {
    if (method === 'GET') handleRoot(ctx);
    else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
    return true;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') handleMeta(ctx);
    else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
    return true;
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') handleUser(ctx);
    else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
    return true;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') handleCreateRepo(ctx);
    else if (method === 'GET') handleListUserRepos(ctx);
    else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
    return true;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    ctx.forge.observeOwner(owner);
    if (rest.length === 3) {
      if (method === 'GET') handleGetRepo(ctx, owner, repoName);
      else if (method === 'PATCH') handlePatchRepo(ctx, owner, repoName);
      else if (method === 'DELETE') handleDeleteRepo(ctx, owner, repoName);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    const section = rest[3];
    if (section === 'branches' && rest.length === 4) {
      if (method === 'GET') handleListBranches(ctx, owner, repoName);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'branches' && rest.length === 5) {
      if (method === 'GET') handleGetBranch(ctx, owner, repoName, decodeURIComponent(rest[4]!));
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'commits' && rest.length === 4) {
      if (method === 'GET') handleListCommits(ctx, owner, repoName);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'git' && rest[4] === 'refs' && rest.length === 5) {
      if (method === 'GET') handleListRefs(ctx, owner, repoName);
      else if (method === 'POST') handleCreateRef(ctx, owner, repoName);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'git' && rest[4] === 'refs' && rest[5] === 'heads' && rest.length === 7) {
      if (method === 'GET') handleGetRef(ctx, owner, repoName, decodeURIComponent(rest[6]!));
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'contents' && rest.length >= 4) {
      const path = rest.slice(4).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'GET') handleGetContents(ctx, owner, repoName, path);
      else if (method === 'PUT') handlePutContents(ctx, owner, repoName, path);
      else if (method === 'DELETE') handleDeleteContents(ctx, owner, repoName, path);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'labels' && rest.length === 4) {
      if (method === 'POST') handleCreateLabel(ctx, owner, repoName);
      else if (method === 'GET') handleListLabels(ctx, owner, repoName);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'issues' && rest.length === 4) {
      if (method === 'POST') handleCreateIssue(ctx, owner, repoName);
      else if (method === 'GET') handleListIssues(ctx, owner, repoName);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'issues' && rest.length === 5) {
      const number = Number(rest[4]);
      if (!Number.isInteger(number)) {
        sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
        return true;
      }
      if (method === 'GET') handleGetIssue(ctx, owner, repoName, number);
      else if (method === 'PATCH') handlePatchIssue(ctx, owner, repoName, number);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'issues' && rest[5] === 'comments' && rest.length === 6) {
      const number = Number(rest[4]);
      if (!Number.isInteger(number)) {
        sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
        return true;
      }
      if (method === 'POST') handleCreateComment(ctx, owner, repoName, number);
      else if (method === 'GET') handleListComments(ctx, owner, repoName, number);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'pulls' && rest.length === 4) {
      if (method === 'POST') handleCreatePull(ctx, owner, repoName);
      else if (method === 'GET') handleListPulls(ctx, owner, repoName);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'pulls' && rest.length === 5) {
      const number = Number(rest[4]);
      if (!Number.isInteger(number)) {
        sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
        return true;
      }
      if (method === 'GET') handleGetPull(ctx, owner, repoName, number);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'pulls' && rest[5] === 'files' && rest.length === 6) {
      const number = Number(rest[4]);
      if (!Number.isInteger(number)) {
        sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
        return true;
      }
      if (method === 'GET') handleListPullFiles(ctx, owner, repoName, number);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
    if (section === 'pulls' && rest[5] === 'merge' && rest.length === 6) {
      const number = Number(rest[4]);
      if (!Number.isInteger(number)) {
        sendError(ctx.res, 404, 'Not Found', ctx.forge.nextRequestId());
        return true;
      }
      if (method === 'PUT') handleMergePull(ctx, owner, repoName, number);
      else sendError(ctx.res, 405, 'Method Not Allowed', ctx.forge.nextRequestId());
      return true;
    }
  }
  return false;
}
