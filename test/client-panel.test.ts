import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDraft, toDraft } from '../src/client/model.js';
import type { Connection } from '../src/client/model.js';
import { PanelSession, panelDraftConflict } from '../src/client/panel-session.js';
import type { PanelSnapshot } from '../src/client/panel-session.js';

const connection: Connection = {
  ...emptyDraft(),
  id: '0123456789abcdef',
  revision: 7,
  name: 'Synthetic',
  hasPassword: true,
  enabled: false,
  status: 'disabled',
  toolName: 'synthetic',
};
const snapshot = (changes: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  connections: [connection],
  selected: connection.id,
  draft: toDraft(connection),
  view: 'settings',
  policyOpen: false,
  dirty: false,
  conflict: false,
  pendingMutation: false,
  checking: false,
  scrollTop: 0,
  ...changes,
});

test('panel navigation retains one in-memory draft and disposal prevents late resurrection', () => {
  const session = new PanelSession();
  const draft = {
    ...toDraft(connection),
    passwordMode: 'replace' as const,
    password: 'fixture-only',
  };
  const edited = snapshot({ draft, dirty: true, view: 'activity', policyOpen: true });
  session.write(edited);
  session.scroll(412);
  assert.equal(session.read()?.draft, draft);
  assert.equal(session.read()?.view, 'activity');
  assert.equal(session.read()?.scrollTop, 412);
  assert.equal(session.needsExitWarning, true);
  session.dispose();
  session.write(edited);
  session.scroll(999);
  assert.equal(session.read(), undefined);
  assert.equal(session.needsExitWarning, false);
  assert.equal(new PanelSession().read(), undefined);
});

test('exit warnings cover edits and uncertain mutations, but not read-only checks', () => {
  const session = new PanelSession();
  for (const [changes, expected] of [
    [{ checking: true }, false],
    [{ dirty: true }, true],
    [{ pendingMutation: true }, true],
    [{}, false],
  ] as const) {
    session.write(snapshot(changes));
    assert.equal(session.needsExitWarning, expected);
  }
});

test('resumed edited or cleared-password drafts cannot adopt a changed or removed saved revision', () => {
  const edited = snapshot({
    dirty: true,
    draft: { ...toDraft(connection), passwordMode: 'clear', clearPassword: true },
  });
  assert.equal(panelDraftConflict(edited, [{ ...connection }]), false);
  assert.equal(panelDraftConflict(edited, [{ ...connection, revision: 8 }]), true);
  assert.equal(panelDraftConflict(edited, []), true);
  assert.equal(edited.draft.clearPassword, true);
  assert.equal(edited.connections[0]?.revision, 7);
});

test('clean views can refresh while unsaved creation remains a separate draft', () => {
  assert.equal(panelDraftConflict(snapshot(), [{ ...connection, revision: 8 }]), false);
  const created = snapshot({
    selected: undefined,
    draft: { ...emptyDraft(), name: 'New' },
    dirty: true,
  });
  assert.equal(panelDraftConflict(created, [connection]), false);
  assert.equal(created.selected, undefined);
});

test('uncertain mutations and unresolved conflicts stay blocked even when a list looks unchanged', () => {
  assert.equal(panelDraftConflict(snapshot({ pendingMutation: true }), [connection]), true);
  assert.equal(panelDraftConflict(snapshot({ conflict: true }), [connection]), true);
});
