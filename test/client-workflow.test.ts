import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionProbe } from '../src/client/probe.js';
import {
  emptyDraft,
  toDraft,
  switchEngine,
  connectionPayload,
  changePasswordMode,
} from '../src/client/model.js';
import { connectionInput, connectionRecord } from '../src/schema.js';
import { safeError } from '../src/errors.js';
import { Observatory } from '../src/observability.js';
import type { Connection } from '../src/client/model.js';

const connection: Connection = {
  ...emptyDraft(),
  tls: false,
  id: '0123456789abcdef',
  revision: 1,
  name: 'Synthetic',
  user: 'reader',
  hasPassword: true,
  enabled: false,
  status: 'disabled',
  toolName: 'synthetic',
};

test('new forms default to no TLS requirement while saved and legacy security choices roundtrip', () => {
  for (const engine of [
    'mysql',
    'mariadb',
    'postgresql',
    'sqlserver',
    'oracle',
    'mongodb',
  ] as const) {
    const draft = {
      ...switchEngine(emptyDraft(), engine),
      name: 'Synthetic',
      user: 'reader',
      database: 'fixture',
    };
    assert.equal(draft.tls, false);
    assert.equal(connectionInput.safeParse(connectionPayload(draft)).success, true);
    for (const tls of [true, false]) {
      assert.equal(connectionInput.parse(connectionPayload({ ...draft, tls })).tls, tls);
      assert.equal(switchEngine({ ...draft, tls }, 'mysql').tls, tls);
      assert.equal(connectionPayload(toDraft({ ...connection, engine, tls })).tls, tls);
    }
  }
  assert.equal(
    connectionInput.parse({ name: 'Legacy', host: 'localhost', user: 'reader' }).tls,
    true,
  );
  assert.equal(
    connectionRecord.parse({
      name: 'Legacy',
      host: 'localhost',
      user: 'reader',
      id: connection.id,
      revision: 1,
      enabled: false,
      createdAt: '',
      updatedAt: '',
    }).tls,
    true,
  );
});

test('password intent maps to the existing Host contract without sending UI state or saved secrets', () => {
  const kept = connectionPayload(toDraft(connection));
  assert.equal(kept.password, '');
  assert.equal(kept.clearPassword, false);
  assert.equal('passwordMode' in kept, false);
  assert.equal(connectionInput.safeParse(kept).success, true);
  const replaced = {
    ...changePasswordMode(toDraft(connection), 'replace'),
    password: 'test-only-replacement',
  };
  assert.equal(connectionPayload(replaced).password, 'test-only-replacement');
  const cleared = connectionPayload(changePasswordMode(replaced, 'clear'));
  assert.equal(cleared.password, '');
  assert.equal(cleared.clearPassword, true);
  const restored = connectionPayload(changePasswordMode(replaced, 'keep'));
  assert.equal(restored.password, '');
  assert.equal(restored.clearPassword, false);
  assert.equal(toDraft({ ...connection, hasPassword: false }).passwordMode, 'replace');
});

test('editing, navigation, closing and cancellation invalidate late check results even when transport ignores abort', async () => {
  for (const reason of ['edit', 'switch', 'close', 'cancel']) {
    const checks = new ConnectionProbe();
    const first = checks.start()!;
    assert.equal(checks.start(), undefined, 'duplicate click does not start another request');
    let resolve!: () => void;
    const response = new Promise<void>((done) => {
      resolve = done;
    });
    let result = '';
    const publish = response.then(() => {
      if (checks.owns(first)) result = 'obsolete success';
    });
    assert(checks.cancel(), reason);
    assert(first.signal.aborted);
    const second = checks.start()!;
    resolve();
    await publish;
    assert.equal(result, '');
    assert.equal(checks.finish(first), false, 'old finally cannot clear current request');
    assert(checks.owns(second));
    assert(checks.finish(second));
    assert.equal(checks.owns(second), false);
  }
});

test('TLS negotiation diagnostics distinguish no-TLS servers from invalid certificates without raw errors', () => {
  const unsupported = safeError(new Error('The server does not support SSL connections'));
  assert.equal(unsupported.code, 'TLS_NOT_SUPPORTED');
  assert.match(unsupported.message, /手动选择/);
  assert.match(safeError({ code: 'HANDSHAKE_NO_SSL_SUPPORT' }).message, /未提供 TLS/);
  for (const code of [
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'SELF_SIGNED_CERT_IN_CHAIN',
  ]) {
    assert.doesNotMatch(safeError({ code, message: 'private' }).message, /不要求加密|private/);
  }
  assert.equal(safeError(new Error('private raw detail')).code, 'DATABASE_ERROR');
});

test('Client diagnostics and call records recover TLS guidance from serialized codes alone', () => {
  for (const operation of ['diagnose', 'test', 'query'] as const) {
    for (const error of [
      new Error('The server does not support SSL connections'),
      { code: 'HANDSHAKE_NO_SSL_SUPPORT', message: 'private driver detail' },
    ]) {
      const expected = safeError(error);
      const journal = new Observatory();
      const trace = journal.start({ connectionId: connection.id, revision: 1, operation });
      journal.finish(trace, expected.code);
      const record = JSON.parse(JSON.stringify(journal.snapshot(connection.id).records[0]));
      assert.equal('message' in record, false, 'call history stores the code, not driver text');
      // This is the code-only boundary used by Manager diagnostics and CallDetails replay.
      const replayed = safeError({ code: record.code });
      assert.deepEqual(replayed, expected);
      assert.match(replayed.message, /核对端口和服务器配置/);
      assert.match(replayed.message, /手动选择/);
      assert.doesNotMatch(replayed.message, /private driver detail/);
    }
  }
});

test('SRV still requires TLS and ordinary MongoDB defaults do not bypass the Host constraint', () => {
  const draft = {
    ...switchEngine(emptyDraft(), 'mongodb'),
    name: 'SRV',
    host: 'cluster.example.com',
    database: 'fixture',
    mongoSrv: true,
  };
  assert.equal(connectionInput.safeParse(connectionPayload(draft)).success, false);
  assert.equal(connectionInput.parse(connectionPayload({ ...draft, tls: true })).tls, true);
});
