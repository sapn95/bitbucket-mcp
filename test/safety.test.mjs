import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, mergePullRequest, TOOLS } from '../index.js';

const CREDS = { url: 'https://bitbucket.example.com', user: 'Example_User', token: 'Example_Token' };

function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = Array.isArray(responses) ? responses[i++] : responses;
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  impl.calls = calls;
  return impl;
}

test('merge refuses without confirm:true and makes no HTTP call', async () => {
  const impl = fakeFetch({ body: {} });
  const out = await dispatch(
    'bitbucket_merge_pull_request',
    { project: 'P', repo: 'r', id: 7 },
    { credsLoader: () => CREDS, deps: { fetchImpl: impl } },
  );
  assert.match(out.refused, /confirm:true/);
  assert.equal(impl.calls.length, 0);
});

test('merge proceeds with confirm:true and sends the version', async () => {
  const impl = fakeFetch([
    { body: { version: 4 } },
    { body: { state: 'MERGED' } },
  ]);
  await mergePullRequest(CREDS, { project: 'P', repo: 'r', id: 7, confirm: true }, { fetchImpl: impl });
  const sent = JSON.parse(impl.calls[1].init.body);
  assert.equal(sent.version, 4);
});

test('no SBB host is baked into the source', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal(/sbb\.ch/i.test(src), false, 'index.js must not hardcode an SBB host');
});

test('every tool exposes a name, description and object input schema', () => {
  for (const t of TOOLS) {
    assert.ok(t.name && t.description, `${t.name} needs name+description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.handler, 'function');
  }
});
