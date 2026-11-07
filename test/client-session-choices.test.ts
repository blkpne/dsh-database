import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSessionChoices, sessionLabel } from '../src/client/session-choices.js';

test('session labels distinguish sessions in one workspace without inventing titles', () => {
  const scope = { id: 'session-1', workspace: '/workspace', createdAt: 0 };
  const label = sessionLabel(scope);
  assert.ok(label.includes(new Date(0).toLocaleString()));
  assert.ok(label.includes('/workspace · 会话'));
  assert.ok(label.endsWith('session-1'));
  assert.ok(sessionLabel({ ...scope, child: true }).includes('子 Agent'));
  assert.notEqual(label, sessionLabel({ ...scope, id: 'session-2' }));
  assert.equal(sessionLabel({ id: 'unknown' }), '未指定工作区 · 会话 · unknown');
  assert.equal(sessionLabel({ id: 'unknown', createdAt: NaN }), '未指定工作区 · 会话 · unknown');
});

test('session discovery posts the existing host API and distinguishes an empty list', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/dsh-database');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body as string), { action: 'scopes' });
    return Response.json({ ok: true, scopes: [] });
  });
  assert.deepEqual(await loadSessionChoices(controller.signal), []);
});

test('failed or malformed discovery is not presented as a successful empty list', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(loadSessionChoices(new AbortController().signal), /scopes unavailable/);
  fetch.mock.mockImplementation(async () => Response.json({ ok: true }));
  await assert.rejects(loadSessionChoices(new AbortController().signal), /scopes unavailable/);
});

test('a canceled discovery cannot replace choices even if response parsing completes late', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    async json() {
      controller.abort();
      return { scopes: [{ id: 'stale-session' }] };
    },
  }));
  await assert.rejects(loadSessionChoices(controller.signal), { name: 'AbortError' });
});
