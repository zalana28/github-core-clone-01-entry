// GraphQL v4: a small parser for the query documents the suite actually sends,
// plus an executor over the forge's store.
//
// The parser covers the GraphQL subset those documents use: operations with
// variable definitions, aliases, arguments (variables, literals, enums, input
// objects, lists, null), and inline fragments. The executor resolves against
// the store with a schema table per type, so an unknown field is an error
// that names the field (the suite checks for that), while a missing
// repository is a null (also what GitHub returns).

import { parseCommit } from './gitproto.ts';
import { parseJsonBody, sendError, sendJson, type Ctx } from './http.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') {
        while (i < source.length && source[i] !== '\n') i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      let isFloat = false;
      while (i < source.length && /[0-9.eE+-]/.test(source[i]!)) {
        if (source[i] === '.' || source[i] === 'e' || source[i] === 'E') isFloat = true;
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${token.value}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name in GraphQL document, got ${token.value}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
    }
    if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipVariableDefinitions();
    const selection = this.parseSelectionSet();
    return { operation, name, selection };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('Unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        let typeCondition = '';
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        const selection = this.parseSelectionSet();
        selections.push({ kind: 'fragment', typeCondition, selection });
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    // Skip directives (@name or @name(...)) — none are used by the suite.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        let depth = 1;
        this.next();
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    const selection =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value in GraphQL document: ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema tables (what each type's fields are, for introspection and errors)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Viewer: ['login', 'id', 'name', 'email'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Comment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  CommentEdge: ['node', 'cursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['DISCUSSION', 'ISSUE', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'PULL_REQUEST', 'REPOSITORY', 'USER'];

const ISSUE_STATE: Record<string, string> = { open: 'OPEN', closed: 'CLOSED' };

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecutorContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

interface TypedValue {
  type: string;
  value: unknown;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function executeSelection(
  selections: SelectionNode[],
  parent: TypedValue,
  ctx: ExecutorContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === '' || selection.typeCondition === parent.type) {
        Object.assign(out, executeSelection(selection.selection, parent, ctx));
      }
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    const resolved = resolveField(parent, field, ctx);
    if (resolved === undefined) continue;
    out[key] = resolved;
  }
  return out;
}

function fieldError(ctx: ExecutorContext, type: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
}

function resolveField(parent: TypedValue, field: FieldNode, ctx: ExecutorContext): unknown {
  const { forge } = ctx;
  const type = parent.type;
  const fields = TYPE_FIELDS[type];
  if (fields === undefined || !fields.includes(field.name)) {
    fieldError(ctx, type, field.name);
    return undefined;
  }
  const args = argsMap(field, ctx.variables);
  const value = parent.value;

  if (type === 'Query') {
    if (field.name === 'viewer') {
      return executeSelection(field.selection, { type: 'Viewer', value: forge.viewer }, ctx);
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = forge.getRepo(owner, name);
      if (repo === null) return null;
      return executeSelection(field.selection, { type: 'Repository', value: repo }, ctx);
    }
    if (field.name === 'node') {
      return resolveNode(String(args.id ?? ''), field, ctx);
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] === undefined && name !== 'SearchType') return null;
      return executeSelection(field.selection, { type: '__Type', value: name }, ctx);
    }
    if (field.name === '__schema') return null;
  }

  if (type === 'Viewer' || type === 'User') {
    const user = value as { login: string; id: number; name: string; email: string };
    if (field.name === 'login') return user.login === forge.viewer.login ? forge.viewerLogin() : user.login;
    if (field.name === 'id') return forge.nodeId('User', user.id);
    if (field.name === 'name') return user.name;
    if (field.name === 'email') return user.email;
  }

  if (type === 'Repository') {
    const repo = value as Repo;
    if (field.name === 'id') return forge.nodeId('Repository', repo.dbId);
    if (field.name === 'databaseId') return repo.dbId;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${forge.viewerLogin()}/${repo.name}`;
    if (field.name === 'owner') {
      return executeSelection(field.selection, { type: 'User', value: forge.viewer }, ctx);
    }
    if (field.name === 'defaultBranchRef') {
      return executeSelection(field.selection, { type: 'Ref', value: { name: repo.defaultBranch } }, ctx);
    }
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'description') return repo.description;
    if (field.name === 'private') return repo.private;
    if (field.name === 'createdAt') return repo.createdAt;
    if (field.name === 'updatedAt') return repo.createdAt;
    if (field.name === 'issue') {
      const issue = repo.issues.get(Number(args.number ?? -1));
      if (issue === undefined) return null;
      return executeSelection(field.selection, { type: 'Issue', value: { repo, issue } }, ctx);
    }
    if (field.name === 'issues') return resolveIssues(repo, args, field, ctx);
    if (field.name === 'pullRequests') return resolvePulls(repo, args, field, ctx);
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number ?? -1));
      if (pull === undefined) return null;
      return executeSelection(field.selection, { type: 'PullRequest', value: { repo, pull } }, ctx);
    }
  }

  if (type === 'Issue') {
    const { repo, issue } = value as { repo: Repo; issue: Issue };
    if (field.name === 'id') return forge.nodeId('Issue', repo.dbId, issue.number);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'body') return issue.body;
    if (field.name === 'state') return ISSUE_STATE[issue.state] ?? 'OPEN';
    if (field.name === 'createdAt') return issue.createdAt;
    if (field.name === 'updatedAt') return issue.updatedAt;
    if (field.name === 'author') {
      return executeSelection(field.selection, { type: 'User', value: forge.viewer }, ctx);
    }
    if (field.name === 'labels') {
      return { nodes: issue.labels.map((name) => ({ name })) };
    }
    if (field.name === 'comments') {
      return { nodes: issue.comments.map((comment) => ({ id: forge.nodeId('IssueComment', repo.dbId, issue.number, comment.id), body: comment.body })) };
    }
  }

  if (type === 'PullRequest') {
    const { repo, pull } = value as { repo: Repo; pull: Pull };
    if (field.name === 'id') return forge.nodeId('PullRequest', repo.dbId, pull.number);
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'mergeable') return forge.pullRequestConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'headRefOid') return forge.commitForRef(repo, `refs/heads/${pull.headRef}`);
    if (field.name === 'baseRefOid') return forge.commitForRef(repo, `refs/heads/${pull.baseRef}`);
    if (field.name === 'createdAt') return pull.createdAt;
    if (field.name === 'updatedAt') return pull.updatedAt;
    if (field.name === 'author') {
      return executeSelection(field.selection, { type: 'User', value: forge.viewer }, ctx);
    }
    if (field.name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 100;
      const files = forge.pullRequestFiles(repo, pull).slice(0, first);
      return {
        nodes: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    }
  }

  if (type === 'Ref') {
    const ref = value as { name: string };
    if (field.name === 'name') return ref.name;
    if (field.name === 'target') return null;
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestChangedFileConnection') {
    const connection = value as { nodes: unknown[]; pageInfo: Record<string, unknown> };
    if (field.name === 'nodes') {
      const nodeType = type === 'IssueConnection' ? 'Issue' : type === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return connection.nodes.map((node) =>
        executeSelection(field.selection, { type: nodeType, value: node }, ctx),
      );
    }
    if (field.name === 'pageInfo') {
      return executeSelection(field.selection, { type: 'PageInfo', value: connection.pageInfo }, ctx);
    }
    if (field.name === 'totalCount') return connection.nodes.length;
    if (field.name === 'edges') return [];
  }

  if (type === 'PullRequestChangedFile') {
    const file = value as { path: string; additions: number; deletions: number; changeType: string };
    if (field.name === 'path') return file.path;
    if (field.name === 'additions') return file.additions;
    if (field.name === 'deletions') return file.deletions;
    if (field.name === 'changeType') return file.changeType;
  }

  if (type === 'PageInfo') {
    const pageInfo = value as Record<string, unknown>;
    if (field.name === 'hasNextPage') return pageInfo.hasNextPage ?? false;
    if (field.name === 'hasPreviousPage') return pageInfo.hasPreviousPage ?? false;
    if (field.name === 'startCursor') return pageInfo.startCursor ?? null;
    if (field.name === 'endCursor') return pageInfo.endCursor ?? null;
  }

  if (type === '__Type') {
    const typeName = value as string;
    if (field.name === 'name') return typeName;
    if (field.name === 'kind') return typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[typeName] ?? [];
      return names.map((name) => ({ name }));
    }
    if (field.name === 'enumValues') {
      if (typeName !== 'SearchType') return null;
      return SEARCH_TYPE_VALUES.map((name) => ({ name }));
    }
    if (field.name === 'description') return null;
  }

  if (type === 'Mutation') {
    return resolveMutation(field, ctx);
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    const payload = value as { issue: { repo: Repo; issue: Issue } | null };
    if (field.name === 'issue') {
      if (payload.issue === null) return null;
      return executeSelection(field.selection, { type: 'Issue', value: payload.issue }, ctx);
    }
    if (field.name === 'clientMutationId') return null;
  }

  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    const payload = value as { pullRequest: { repo: Repo; pull: Pull } | null };
    if (field.name === 'pullRequest') {
      if (payload.pullRequest === null) return null;
      return executeSelection(field.selection, { type: 'PullRequest', value: payload.pullRequest }, ctx);
    }
    if (field.name === 'clientMutationId') return null;
  }

  if (type === 'AddCommentPayload') {
    const payload = value as { commentEdge: { node: { id: string; body: string } } | null };
    if (field.name === 'commentEdge') {
      if (payload.commentEdge === null) return null;
      return executeSelection(field.selection, { type: 'CommentEdge', value: payload.commentEdge }, ctx);
    }
    if (field.name === 'clientMutationId') return null;
  }

  if (type === 'CommentEdge') {
    const edge = value as { node: { id: string; body: string } };
    if (field.name === 'node') {
      return executeSelection(field.selection, { type: 'Comment', value: edge.node }, ctx);
    }
    if (field.name === 'cursor') return null;
  }

  if (type === 'Comment') {
    const comment = value as { id: string; body: string };
    if (field.name === 'id') return comment.id;
    if (field.name === 'body') return comment.body;
  }

  fieldError(ctx, type, field.name);
  return undefined;
}

function resolveNode(id: string, field: FieldNode, ctx: ExecutorContext): unknown {
  const { forge } = ctx;
  let decoded = '';
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split(':');
  const kind = parts[0];
  if (kind === 'Repository' && parts.length === 2) {
    const dbId = Number(parts[1]);
    const repo = [...forge.repos.values()].find((candidate) => candidate.dbId === dbId);
    if (repo === undefined) return null;
    return executeSelection(field.selection, { type: 'Repository', value: repo }, ctx);
  }
  if (kind === 'Issue' && parts.length === 3) {
    const dbId = Number(parts[1]);
    const number = Number(parts[2]);
    const repo = [...forge.repos.values()].find((candidate) => candidate.dbId === dbId);
    const issue = repo?.issues.get(number);
    if (repo === undefined || issue === undefined) return null;
    return executeSelection(field.selection, { type: 'Issue', value: { repo, issue } }, ctx);
  }
  if (kind === 'PullRequest' && parts.length === 3) {
    const dbId = Number(parts[1]);
    const number = Number(parts[2]);
    const repo = [...forge.repos.values()].find((candidate) => candidate.dbId === dbId);
    const pull = repo?.pulls.get(number);
    if (repo === undefined || pull === undefined) return null;
    return executeSelection(field.selection, { type: 'PullRequest', value: { repo, pull } }, ctx);
  }
  if (kind === 'User' && parts.length === 2) {
    return executeSelection(field.selection, { type: 'User', value: forge.viewer }, ctx);
  }
  return null;
}

function resolveIssues(repo: Repo, args: Record<string, unknown>, field: FieldNode, ctx: ExecutorContext): unknown {
  const { forge } = ctx;
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = decodeCursor(args.after);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  issues.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return direction === 'asc' ? (a.createdAt < b.createdAt ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'desc' ? issue.number < after : issue.number > after));
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  const connection = {
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: { hasNextPage, endCursor, hasPreviousPage: after !== null, startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null },
  };
  return executeSelection(field.selection, { type: 'IssueConnection', value: connection }, ctx);
}

function resolvePulls(repo: Repo, args: Record<string, unknown>, field: FieldNode, ctx: ExecutorContext): unknown {
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = decodeCursor(args.after);
  let pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  const connection = {
    nodes: page.map((pull) => ({ repo, pull })),
    pageInfo: { hasNextPage, endCursor, hasPreviousPage: after !== null, startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null },
  };
  return executeSelection(field.selection, { type: 'PullRequestConnection', value: connection }, ctx);
}

function resolveMutation(field: FieldNode, ctx: ExecutorContext): unknown {
  const { forge } = ctx;
  const args = argsMap(field, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (field.name === 'createIssue') {
    const dbId = decodeRepositoryDbId(input.repositoryId);
    const repo = dbId === null ? undefined : [...forge.repos.values()].find((candidate) => candidate.dbId === dbId);
    const title = typeof input.title === 'string' ? input.title : '';
    if (repo === undefined || title === '') {
      ctx.errors.push({ message: 'createIssue: the repository or title is missing' });
      return null;
    }
    const { iso } = forge.tick();
    repo.counter += 1;
    const issue: Issue = {
      id: repo.dbId * 1_000_000 + repo.counter,
      number: repo.counter,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      createdAt: iso,
      updatedAt: iso,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    const payload = { issue: { repo, issue } };
    return executeSelection(field.selection, { type: 'CreateIssuePayload', value: payload }, ctx);
  }

  if (field.name === 'closeIssue') {
    const issueRef = decodeNodeId(String(input.issueId ?? ''));
    const repo = issueRef?.kind === 'Issue' ? [...forge.repos.values()].find((candidate) => candidate.dbId === issueRef.dbId) : undefined;
    const issue = repo?.issues.get(issueRef?.number ?? -1);
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'closeIssue: the issue does not exist' });
      return null;
    }
    issue.state = 'closed';
    issue.updatedAt = forge.tick().iso;
    const payload = { issue: { repo, issue } };
    return executeSelection(field.selection, { type: 'CloseIssuePayload', value: payload }, ctx);
  }

  if (field.name === 'createPullRequest') {
    const dbId = decodeRepositoryDbId(input.repositoryId);
    const repo = dbId === null ? undefined : [...forge.repos.values()].find((candidate) => candidate.dbId === dbId);
    const title = typeof input.title === 'string' ? input.title : '';
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    if (repo === undefined || title === '' || head === '' || base === '') {
      ctx.errors.push({ message: 'createPullRequest: the repository, title, head or base is missing' });
      return null;
    }
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined || baseTip === undefined) {
      ctx.errors.push({ message: 'createPullRequest: the head or base branch does not exist' });
      return null;
    }
    const { iso } = forge.tick();
    repo.counter += 1;
    const pull: Pull = {
      number: repo.counter,
      title,
      body: typeof input.body === 'string' ? input.body : '',
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
    const payload = { pullRequest: { repo, pull } };
    return executeSelection(field.selection, { type: 'CreatePullRequestPayload', value: payload }, ctx);
  }

  if (field.name === 'mergePullRequest') {
    const pullRef = decodeNodeId(String(input.pullRequestId ?? ''));
    const repo = pullRef?.kind === 'PullRequest' ? [...forge.repos.values()].find((candidate) => candidate.dbId === pullRef.dbId) : undefined;
    const pull = repo?.pulls.get(pullRef?.number ?? -1);
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: the pull request does not exist' });
      return null;
    }
    if (pull.merged || pull.state !== 'open') {
      ctx.errors.push({ message: 'mergePullRequest: the pull request is already closed' });
      return null;
    }
    if (forge.pullRequestConflicts(repo, pull)) {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
      return null;
    }
    const merged = forge.mergePullRequest(repo, pull);
    if (merged === null) {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
      return null;
    }
    const payload = { pullRequest: { repo, pull } };
    return executeSelection(field.selection, { type: 'MergePullRequestPayload', value: payload }, ctx);
  }

  if (field.name === 'addComment') {
    const subjectRef = decodeNodeId(String(input.subjectId ?? ''));
    const repo = subjectRef?.kind === 'Issue' ? [...forge.repos.values()].find((candidate) => candidate.dbId === subjectRef.dbId) : undefined;
    const issue = repo?.issues.get(subjectRef?.number ?? -1);
    const body = typeof input.body === 'string' ? input.body : '';
    if (repo === undefined || issue === undefined || body === '') {
      ctx.errors.push({ message: 'addComment: the subject or body is missing' });
      return null;
    }
    const { iso } = forge.tick();
    const comment = { id: forge.nextCommentIdValue(), body, createdAt: iso, updatedAt: iso };
    issue.comments.push(comment);
    const nodeId = forge.nodeId('IssueComment', repo.dbId, issue.number, comment.id);
    const payload = { commentEdge: { node: { id: nodeId, body } } };
    return executeSelection(field.selection, { type: 'AddCommentPayload', value: payload }, ctx);
  }

  fieldError(ctx, 'Mutation', field.name);
  return undefined;
}

/** Decode a node id into its kind and parts (or null when it is not one). */
function decodeNodeId(id: string): { kind: string; dbId: number; number: number } | null {
  let decoded = '';
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split(':');
  if (parts.length !== 3) return null;
  return { kind: parts[0]!, dbId: Number(parts[1]), number: Number(parts[2]) };
}

/** The database id inside a Repository node id (or null when it is not one). */
function decodeRepositoryDbId(id: unknown): number | null {
  if (typeof id !== 'string') return null;
  let decoded = '';
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split(':');
  if (parts.length !== 2 || parts[0] !== 'Repository') return null;
  const dbId = Number(parts[1]);
  return Number.isFinite(dbId) ? dbId : null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function executeOperation(operation: OperationNode, variables: Record<string, unknown>, forge: Forge): Record<string, unknown> {
  const ctx: ExecutorContext = { forge, variables, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(operation.selection, { type: rootType, value: null }, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

export function handleGraphql(ctx: Ctx): void {
  const { forge, res } = ctx;
  const requestId = forge.nextRequestId();
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendError(res, 400, 'Invalid JSON in request body', requestId);
    return;
  }
  const runOne = (body: unknown): Record<string, unknown> => {
    const obj =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (obj === null) return { data: null, errors: [{ message: 'GraphQL body must be an object' }] };
    const query = typeof obj.query === 'string' ? obj.query : '';
    const variables = (obj.variables ?? {}) as Record<string, unknown>;
    if (query === '') return { data: null, errors: [{ message: 'GraphQL query is required' }] };
    let operations: OperationNode[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
    }
    const operation = operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'GraphQL document has no operation' }] };
    return executeOperation(operation, variables, forge);
  };
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map(runOne);
    sendJson(res, 200, results, requestId);
    return;
  }
  sendJson(res, 200, runOne(parsed.value), requestId);
}
