import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEnv, getCredentials, authHeader, request,
  listPullRequests, getMergeStatus, addComment, setDraft, resolveTask, dispatch,
} from '../index.js';

const CREDS = { url: 'https://bitbucket.example.com', user: 'Example_User', token: 'Example_Token' };

// A fetch double that records the last call and returns a canned response.
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = Array.isArray(responses) ? responses[i++] : responses;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

test('getEnv honours BITBUCKET_* over BB_* precedence', () => {
  const env = { BITBUCKET_URL: 'a', BB_URL: 'b' };
  assert.equal(getEnv(['BITBUCKET_URL', 'BB_URL'], env), 'a');
  assert.equal(getEnv(['BITBUCKET_USER', 'BB_USER'], { BB_USER: 'fallback' }), 'fallback');
});

test('getCredentials throws listing every missing variable', () => {
  assert.throws(() => getCredentials({}), /BITBUCKET_URL, BITBUCKET_USER, BITBUCKET_TOKEN/);
});

test('getCredentials strips a trailing slash from the URL', () => {
  const c = getCredentials({ BITBUCKET_URL: 'https://x/', BITBUCKET_USER: 'u', BITBUCKET_TOKEN: 't' });
  assert.equal(c.url, 'https://x');
});

test('authHeader base64-encodes user:token', () => {
  assert.equal(authHeader(CREDS), `Basic ${Buffer.from('Example_User:Example_Token').toString('base64')}`);
});

test('request throws with status and body on a non-2xx', async () => {
  const impl = fakeFetch({ ok: false, status: 409, body: { errors: ['conflict'] } });
  await assert.rejects(
    () => request('GET', 'https://x', CREDS, undefined, impl),
    (e) => e.status === 409 && e.body.errors[0] === 'conflict',
  );
});

test('listPullRequests builds the state and limit query', async () => {
  const impl = fakeFetch({ body: { values: [] } });
  await listPullRequests(CREDS, { project: 'P', repo: 'r', state: 'MERGED', limit: 5 }, { fetchImpl: impl });
  assert.match(impl.calls[0].url, /\/projects\/P\/repos\/r\/pull-requests\?state=MERGED&limit=5$/);
});

test('getMergeStatus hits the /merge subresource', async () => {
  const impl = fakeFetch({ body: { canMerge: false } });
  await getMergeStatus(CREDS, { project: 'P', repo: 'r', id: 7 }, { fetchImpl: impl });
  assert.match(impl.calls[0].url, /\/pull-requests\/7\/merge$/);
});

test('addComment threads under parentId when given', async () => {
  const impl = fakeFetch({ body: { id: 2 } });
  await addComment(CREDS, { project: 'P', repo: 'r', id: 7, text: 'hi', parentId: 99 }, { fetchImpl: impl });
  const sent = JSON.parse(impl.calls[0].init.body);
  assert.deepEqual(sent, { text: 'hi', parent: { id: 99 } });
});

test('addComment omits parent for a top-level comment', async () => {
  const impl = fakeFetch({ body: { id: 2 } });
  await addComment(CREDS, { project: 'P', repo: 'r', id: 7, text: 'hi' }, { fetchImpl: impl });
  assert.deepEqual(JSON.parse(impl.calls[0].init.body), { text: 'hi' });
});

test('setDraft re-sends reviewers unchanged (SIG-4884 guard)', async () => {
  const impl = fakeFetch([
    { body: { version: 3, title: 'T', description: 'D', draft: true, reviewers: [{ user: { name: 'u1' } }, { user: { name: 'u2' } }] } },
    { body: { draft: false } },
  ]);
  await setDraft(CREDS, { project: 'P', repo: 'r', id: 7, draft: false }, { fetchImpl: impl });
  const put = JSON.parse(impl.calls[1].init.body);
  assert.equal(put.draft, false);
  assert.equal(put.version, 3);
  assert.deepEqual(put.reviewers, [{ user: { name: 'u1' } }, { user: { name: 'u2' } }]);
});

test('resolveTask fetches version then PUTs state RESOLVED', async () => {
  const impl = fakeFetch([
    { body: { version: 1 } },
    { body: { state: 'RESOLVED' } },
  ]);
  await resolveTask(CREDS, { project: 'P', repo: 'r', id: 7, commentId: 42 }, { fetchImpl: impl });
  const put = JSON.parse(impl.calls[1].init.body);
  assert.deepEqual(put, { version: 1, state: 'RESOLVED' });
});

test('dispatch routes by tool name with an injected creds loader', async () => {
  const impl = fakeFetch({ body: { values: [] } });
  const out = await dispatch(
    'bitbucket_list_pull_requests',
    { project: 'P', repo: 'r' },
    { credsLoader: () => CREDS, deps: { fetchImpl: impl } },
  );
  assert.deepEqual(out, { values: [] });
});

test('dispatch rejects an unknown tool', async () => {
  await assert.rejects(() => dispatch('nope', {}, { credsLoader: () => CREDS }), /unknown tool/);
});

import { buildServer, TOOLS } from '../index.js';

test('every read/write tool handler runs through dispatch', async () => {
  // One canned body per GET; two-step tools (resolveTask/setDraft) get a GET then a write.
  const cases = {
    bitbucket_get_pull_request: { args: { project: 'P', repo: 'r', id: 1 }, responses: { body: { id: 1 } } },
    bitbucket_get_activities: { args: { project: 'P', repo: 'r', id: 1 }, responses: { body: { values: [] } } },
    bitbucket_get_blocker_comments: { args: { project: 'P', repo: 'r', id: 1 }, responses: { body: { values: [] } } },
    bitbucket_add_comment: { args: { project: 'P', repo: 'r', id: 1, text: 'x' }, responses: { body: { id: 5 } } },
    bitbucket_resolve_task: { args: { project: 'P', repo: 'r', id: 1, commentId: 5 }, responses: [{ body: { version: 0 } }, { body: {} }] },
    bitbucket_set_draft: { args: { project: 'P', repo: 'r', id: 1, draft: true }, responses: [{ body: { version: 0, title: 't', reviewers: [] } }, { body: {} }] },
  };
  for (const [name, { args, responses }] of Object.entries(cases)) {
    const impl = fakeFetch(responses);
    await dispatch(name, args, { credsLoader: () => CREDS, deps: { fetchImpl: impl } });
    assert.ok(impl.calls.length >= 1, `${name} made a call`);
  }
});

test('buildServer returns a server exposing exactly the TOOLS set', () => {
  const server = buildServer();
  assert.ok(server);
  assert.ok(TOOLS.length >= 8);
});
