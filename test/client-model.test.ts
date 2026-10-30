import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDraft, hasChanges, toDraft } from '../src/client/model.js';
import type { Connection } from '../src/client/model.js';

const connection: Connection = {
  ...emptyDraft(),
  id: '0123456789abcdef',
  revision: 1,
  name: 'Analytics',
  user: 'reader',
  enabled: true,
  hasPassword: true,
  toolName: 'mcp__dshdb_0123456789abcdef__query',
  status: 'enabled',
};

test('reverting edits restores a clean draft without losing saved credentials', () => {
  const draft = toDraft(connection);
  assert.equal(hasChanges(draft, connection), false);
  draft.name = 'New name';
  assert.equal(hasChanges(draft, connection), true);
  draft.name = connection.name;
  assert.equal(hasChanges(draft, connection), false);
  assert.equal(draft.password, '');
  assert.equal(draft.clearPassword, false);
});

test('password replacement and explicit clearing both require saving', () => {
  assert.equal(
    hasChanges({ ...toDraft(connection), password: 'local-test-only' }, connection),
    true,
  );
  assert.equal(hasChanges({ ...toDraft(connection), clearPassword: true }, connection), true);
});

test('tool revision/status updates do not masquerade as form edits', () => {
  const draft = toDraft(connection);
  assert.equal(
    hasChanges(draft, { ...connection, revision: 2, status: 'disabled', enabled: false }),
    false,
  );
  assert.equal(hasChanges({ ...draft, tls: !connection.tls }, connection), true);
  assert.equal(hasChanges({ ...draft, maxRows: 100 }, connection), true);
});

test('untouched new drafts are clean and reverted new drafts can close directly', () => {
  assert.equal(hasChanges(emptyDraft()), false);
  assert.equal(hasChanges({ ...emptyDraft(), name: 'New connection' }), true);
  assert.equal(hasChanges({ ...emptyDraft(), port: 3307 }), true);
});
