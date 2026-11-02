// Bitbucket Server / Data Center MCP server.
//
// Wraps the Bitbucket REST 1.0 API for pull-request work: list, read, merge
// state, comments (threaded replies), tasks, draft toggle, and merge.
//
// The server URL and credentials are read from the environment only — nothing
// SBB-internal is baked in, so this repository stays safe to publish:
//   BITBUCKET_URL   / BB_URL    e.g. https://bitbucket.example.com
//   BITBUCKET_USER  / BB_USER
//   BITBUCKET_TOKEN / BB_TOKEN  personal access token or app password
//
// BITBUCKET_* wins when both a BITBUCKET_* and a BB_* variable are set, which
// matches the precedence used by the sigma-commit-push bb.py helper.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// --- credentials -----------------------------------------------------------

export function getEnv(names, env = process.env) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export function getCredentials(env = process.env) {
  const url = getEnv(['BITBUCKET_URL', 'BB_URL'], env);
  const user = getEnv(['BITBUCKET_USER', 'BB_USER'], env);
  const token = getEnv(['BITBUCKET_TOKEN', 'BB_TOKEN'], env);
  const missing = [];
  if (!url) missing.push('BITBUCKET_URL');
  if (!user) missing.push('BITBUCKET_USER');
  if (!token) missing.push('BITBUCKET_TOKEN');
  if (missing.length) {
    throw new Error(`Missing Bitbucket credentials: ${missing.join(', ')}`);
  }
  return { url: url.replace(/\/+$/, ''), user, token };
}

export function authHeader(creds) {
  const raw = `${creds.user}:${creds.token}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

// --- HTTP core -------------------------------------------------------------

// Injectable so tests never touch the network.
export async function request(method, url, creds, body, fetchImpl = fetch) {
  const headers = { Authorization: authHeader(creds), Accept: 'application/json' };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const err = new Error(`Bitbucket ${method} ${response.status}`);
    err.status = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

function prBase(creds, project, repo) {
  return `${creds.url}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests`;
}

// --- read ------------------------------------------------------------------

export function listPullRequests(creds, { project, repo, state = 'OPEN', limit = 25 }, deps = {}) {
  const url = `${prBase(creds, project, repo)}?state=${encodeURIComponent(state)}&limit=${limit}`;
  return request('GET', url, creds, undefined, deps.fetchImpl);
}

export function getPullRequest(creds, { project, repo, id }, deps = {}) {
  return request('GET', `${prBase(creds, project, repo)}/${id}`, creds, undefined, deps.fetchImpl);
}

export function getMergeStatus(creds, { project, repo, id }, deps = {}) {
  return request('GET', `${prBase(creds, project, repo)}/${id}/merge`, creds, undefined, deps.fetchImpl);
}

export function getActivities(creds, { project, repo, id, limit = 100 }, deps = {}) {
  const url = `${prBase(creds, project, repo)}/${id}/activities?limit=${limit}`;
  return request('GET', url, creds, undefined, deps.fetchImpl);
}

export function getBlockerComments(creds, { project, repo, id }, deps = {}) {
  return request('GET', `${prBase(creds, project, repo)}/${id}/blocker-comments`, creds, undefined, deps.fetchImpl);
}

// --- write -----------------------------------------------------------------

// A reply threads under parentId; omit it for a top-level comment.
export function addComment(creds, { project, repo, id, text, parentId }, deps = {}) {
  const body = { text };
  if (parentId !== undefined && parentId !== null) body.parent = { id: parentId };
  return request('POST', `${prBase(creds, project, repo)}/${id}/comments`, creds, body, deps.fetchImpl);
}

// A task on a PR is a blocker comment with severity BLOCKER. Resolve it by
// flipping its state to RESOLVED; the comment version is required by Bitbucket.
export async function resolveTask(creds, { project, repo, id, commentId }, deps = {}) {
  const base = prBase(creds, project, repo);
  const current = await request('GET', `${base}/${id}/comments/${commentId}`, creds, undefined, deps.fetchImpl);
  const body = { version: current.version, state: 'RESOLVED' };
  return request('PUT', `${base}/${id}/comments/${commentId}`, creds, body, deps.fetchImpl);
}

export async function setDraft(creds, { project, repo, id, draft }, deps = {}) {
  const base = prBase(creds, project, repo);
  const pr = await request('GET', `${base}/${id}`, creds, undefined, deps.fetchImpl);
  // Bitbucket PUT has REPLACE semantics: any omitted field is wiped. SIG-4884
  // lost reviewers this way. Re-send title, description and the live reviewer
  // list unchanged so only `draft` changes.
  const body = {
    version: pr.version,
    title: pr.title,
    description: pr.description ?? '',
    draft: Boolean(draft),
    reviewers: (pr.reviewers ?? []).map((r) => ({ user: { name: r.user.name } })),
  };
  return request('PUT', `${base}/${id}`, creds, body, deps.fetchImpl);
}

// Merge requires the current PR version. message/strategyId are optional.
export async function mergePullRequest(creds, { project, repo, id, version, message, strategyId }, deps = {}) {
  const base = prBase(creds, project, repo);
  let v = version;
  if (v === undefined || v === null) {
    const pr = await request('GET', `${base}/${id}`, creds, undefined, deps.fetchImpl);
    v = pr.version;
  }
  const body = { version: v };
  if (message) body.message = message;
  if (strategyId) body.strategyId = strategyId;
  return request('POST', `${base}/${id}/merge`, creds, body, deps.fetchImpl);
}

// --- MCP wiring ------------------------------------------------------------

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

const PROJECT_REPO = {
  project: { type: 'string', description: 'Bitbucket project key, e.g. KD_SIGMA' },
  repo: { type: 'string', description: 'Repository slug, e.g. sigma-skills' },
};

export const TOOLS = [
  {
    name: 'bitbucket_list_pull_requests',
    description: 'List pull requests in a repository. Optional state (OPEN/MERGED/DECLINED/ALL) and page size.',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, state: { type: 'string' }, limit: { type: 'number' } }, required: ['project', 'repo'] },
    handler: (creds, a, d) => listPullRequests(creds, a, d),
  },
  {
    name: 'bitbucket_get_pull_request',
    description: 'Get one pull request by id (title, description, branches, reviewers, draft flag).',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' } }, required: ['project', 'repo', 'id'] },
    handler: (creds, a, d) => getPullRequest(creds, a, d),
  },
  {
    name: 'bitbucket_get_merge_status',
    description: 'Get the merge state of a pull request: canMerge, conflicted, and the list of veto reasons.',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' } }, required: ['project', 'repo', 'id'] },
    handler: (creds, a, d) => getMergeStatus(creds, a, d),
  },
  {
    name: 'bitbucket_get_activities',
    description: 'Get the activity stream of a pull request (comments, approvals, updates) for reading the discussion thread.',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' }, limit: { type: 'number' } }, required: ['project', 'repo', 'id'] },
    handler: (creds, a, d) => getActivities(creds, a, d),
  },
  {
    name: 'bitbucket_get_blocker_comments',
    description: 'List the tasks (blocker comments) on a pull request with their OPEN/RESOLVED state and ids.',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' } }, required: ['project', 'repo', 'id'] },
    handler: (creds, a, d) => getBlockerComments(creds, a, d),
  },
  {
    name: 'bitbucket_add_comment',
    description: 'Post a comment on a pull request. Pass parentId to thread the comment as a reply under an existing comment; omit it for a top-level comment.',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' }, text: { type: 'string' }, parentId: { type: 'number' } }, required: ['project', 'repo', 'id', 'text'] },
    handler: (creds, a, d) => addComment(creds, a, d),
  },
  {
    name: 'bitbucket_resolve_task',
    description: 'Resolve a task (blocker comment) on a pull request by its comment id. Fetches the comment version first, then flips state to RESOLVED.',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' }, commentId: { type: 'number' } }, required: ['project', 'repo', 'id', 'commentId'] },
    handler: (creds, a, d) => resolveTask(creds, a, d),
  },
  {
    name: 'bitbucket_set_draft',
    description: 'Turn a pull request\'s draft flag on or off. Preserves title, description and the full reviewer list across the required PUT (Bitbucket PUT replaces the whole resource).',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' }, draft: { type: 'boolean' } }, required: ['project', 'repo', 'id', 'draft'] },
    handler: (creds, a, d) => setDraft(creds, a, d),
  },
  {
    name: 'bitbucket_merge_pull_request',
    description: 'IRREVERSIBLE: merge a pull request. Requires confirm:true. Uses the current PR version unless one is given. Optional message and strategyId (merge-commit/squash/fast-forward).',
    inputSchema: { type: 'object', properties: { ...PROJECT_REPO, id: { type: 'number' }, version: { type: 'number' }, message: { type: 'string' }, strategyId: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['project', 'repo', 'id', 'confirm'] },
    handler: (creds, a, d) => {
      if (a.confirm !== true) {
        return Promise.resolve({ refused: 'merge is irreversible — pass confirm:true to proceed' });
      }
      return mergePullRequest(creds, a, d);
    },
  },
];

export async function dispatch(name, args, { credsLoader = getCredentials, deps = {} } = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const creds = credsLoader();
  return tool.handler(creds, args ?? {}, deps);
}

export function buildServer() {
  const server = new Server({ name: 'bitbucket-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await dispatch(req.params.name, req.params.arguments);
      return text(result);
    } catch (e) {
      return text({ error: e.message, status: e.status, body: e.body });
    }
  });
  return server;
}

// Start only when run directly, so tests can import the functions above.
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
