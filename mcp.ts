// MCP over streamable HTTP: the six tools the suite needs, plus the handshake.
//
// Two protocol eras are served from the same endpoint. The modern era
// (2026-07-28) needs no handshake: every request declares its revision in
// _meta and answers server/discover. The legacy era (2025-11-25 and earlier)
// negotiates through initialize + notifications/initialized. Both eras share
// tools/list and tools/call, and every answer is plain JSON (the client
// accepts that; no SSE stream is needed). A request without the bearer token
// is 401 before any of this is read.
//
// The tools are one constant, so two tools/list answers hold the same tools
// array byte for byte. Their input schemas use the canonical property names
// the suite maps its documented arguments onto, with only the required
// arguments marked required — a tool whose schema has a required property the
// suite cannot fill fails its check.

import { parseJsonBody, sendJson, type Ctx } from './http.ts';
import type { Forge, Repo } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch onto another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The branch the changes are on.' },
        base: { type: 'string', description: 'The branch the changes go onto.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx.res, 200, { jsonrpc: '2.0', id: id ?? null, result }, ctx.forge.nextRequestId());
}

function rpcError(ctx: Ctx, id: unknown, code: number, message: string, status = 200): void {
  sendJson(ctx.res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, ctx.forge.nextRequestId());
}

function toolTextResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Read a repo argument, accepting the canonical names and their synonyms. */
function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner === '' ? parts[0]! : owner;
      repo = repo === '' ? parts[1]! : repo;
    }
  }
  return { owner, repo };
}

function findRepo(forge: Forge, owner: string, repo: string): Repo | null {
  if (owner === '' || repo === '') return null;
  return forge.getRepo(owner, repo);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return toolErrorResult(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolErrorResult(`Missing required argument: ${required}`);
    }
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    let repo = forge.repos.get(repoName);
    if (repo === undefined) {
      repo = forge.createRepo(repoName, description, isPrivate) ?? undefined;
      if (repo === undefined) return toolErrorResult(`Repository already exists: ${repoName}`);
    }
    return toolTextResult({
      name: repo.name,
      full_name: `${forge.viewerLogin()}/${repo.name}`,
      private: repo.private,
      default_branch: repo.defaultBranch,
      description: repo.description,
    });
  }

  if (name === 'get_repo') {
    const { owner, repo: repoName } = repoArgs(args);
    const repo = findRepo(forge, owner, repoName);
    if (repo === null) return toolErrorResult(`Repository not found: ${owner}/${repoName}`);
    return toolTextResult({
      name: repo.name,
      full_name: `${forge.viewerLogin()}/${repo.name}`,
      owner: { login: forge.viewerLogin() },
      private: repo.private,
      default_branch: repo.defaultBranch,
      description: repo.description,
    });
  }

  if (name === 'create_issue') {
    const { owner, repo: repoName } = repoArgs(args);
    const repo = findRepo(forge, owner, repoName);
    if (repo === null) return toolErrorResult(`Repository not found: ${owner}/${repoName}`);
    const title = String(args.title);
    const { iso } = forge.tick();
    repo.counter += 1;
    const issue = {
      id: repo.dbId * 1_000_000 + repo.counter,
      number: repo.counter,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels: [] as string[],
      createdAt: iso,
      updatedAt: iso,
      comments: [] as never[],
    };
    repo.issues.set(issue.number, issue);
    return toolTextResult({ number: issue.number, title: issue.title, state: issue.state, body: issue.body });
  }

  if (name === 'list_issues') {
    const { owner, repo: repoName } = repoArgs(args);
    const repo = findRepo(forge, owner, repoName);
    if (repo === null) return toolErrorResult(`Repository not found: ${owner}/${repoName}`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => a.number - b.number);
    return toolTextResult({
      issues: issues.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, body: issue.body })),
    });
  }

  if (name === 'create_pull_request') {
    const { owner, repo: repoName } = repoArgs(args);
    const repo = findRepo(forge, owner, repoName);
    if (repo === null) return toolErrorResult(`Repository not found: ${owner}/${repoName}`);
    const title = String(args.title);
    const head = typeof args.head === 'string' ? args.head : typeof args.head_ref === 'string' ? args.head_ref : '';
    const base = typeof args.base === 'string' ? args.base : typeof args.base_ref === 'string' ? args.base_ref : '';
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined || baseTip === undefined) {
      return toolErrorResult('The head or base branch does not exist');
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return toolErrorResult('A pull request already exists for this head and base');
      }
    }
    const { iso } = forge.tick();
    repo.counter += 1;
    const pull = {
      number: repo.counter,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      headRef: head,
      baseRef: base,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      createdAt: iso,
      updatedAt: iso,
    };
    repo.pulls.set(pull.number, pull);
    return toolTextResult({
      number: pull.number,
      title: pull.title,
      state: pull.state,
      head: { ref: pull.headRef, sha: forge.commitForRef(repo, `refs/heads/${head}`) },
      base: { ref: pull.baseRef, sha: forge.commitForRef(repo, `refs/heads/${base}`) },
    });
  }

  if (name === 'merge_pull_request') {
    const { owner, repo: repoName } = repoArgs(args);
    const repo = findRepo(forge, owner, repoName);
    if (repo === null) return toolErrorResult(`Repository not found: ${owner}/${repoName}`);
    const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : -1;
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolErrorResult(`Pull request not found: ${number}`);
    if (pull.merged || pull.state !== 'open') return toolErrorResult('Pull request is already closed');
    if (forge.pullRequestConflicts(repo, pull)) return toolErrorResult('Merge conflict');
    const merged = forge.mergePullRequest(repo, pull);
    if (merged === null) return toolErrorResult('Merge conflict');
    return toolTextResult({ number: pull.number, merged: true, sha: merged.sha });
  }

  return toolErrorResult(`Unknown tool: ${name}`);
}

export function handleMcp(ctx: Ctx): void {
  const { forge } = ctx;
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    // A non-JSON body is a JSON-RPC parse error: HTTP 400, code -32700.
    sendJson(
      ctx.res,
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      forge.nextRequestId(),
    );
    return;
  }
  const request = parsed.value as RpcRequest;
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    rpcError(ctx, null, -32600, 'Invalid Request', 400);
    return;
  }
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;

  if (method === 'server/discover') {
    rpcResult(ctx, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    rpcResult(ctx, id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method.startsWith('notifications/')) {
    // A notification is fire-and-forget: 202, no body.
    ctx.res.writeHead(202, { 'x-github-request-id': forge.nextRequestId() });
    ctx.res.end();
    return;
  }
  if (isNotification) {
    ctx.res.writeHead(202, { 'x-github-request-id': forge.nextRequestId() });
    ctx.res.end();
    return;
  }
  if (method === 'ping') {
    rpcResult(ctx, id, {});
    return;
  }
  if (method === 'tools/list') {
    rpcResult(ctx, id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const params = request.params as Record<string, unknown> | undefined;
    if (params === undefined || typeof params !== 'object' || Array.isArray(params)) {
      rpcError(ctx, id, -32602, 'Invalid params: tools/call needs an object with name and arguments');
      return;
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '' || typeof args !== 'object' || args === null || Array.isArray(args)) {
      rpcError(ctx, id, -32602, 'Invalid params: tools/call needs a tool name and an arguments object');
      return;
    }
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) {
      rpcError(ctx, id, -32602, `Unknown tool: ${name}`);
      return;
    }
    rpcResult(ctx, id, callTool(forge, name, args));
    return;
  }
  rpcError(ctx, id, -32601, `Method not found: ${method}`);
}
