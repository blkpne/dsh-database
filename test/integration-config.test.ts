import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationTls } from './integration/tls.js';
import { connectionInput } from '../src/schema.js';

test('existing-server TLS is enabled by default and plaintext requires an explicit opt-in', () => {
  for (const key of ['DSH_DATABASE_TEST_TLS', 'DSH_DATABASE_POSTGRESQL_TLS']) {
    assert.equal(integrationTls({}, key), true);
    assert.equal(integrationTls({ [key]: 'true' }, key), true);
    assert.equal(integrationTls({ [key]: 'false' }, key), false);
    for (const value of ['', '0', 'FALSE', 'typo-not-a-credential']) {
      assert.throws(
        () => integrationTls({ [key]: value }, key),
        (error: Error) => {
          assert(error.message.includes(key));
          assert(!error.message.includes(value === '' ? 'undefined' : value));
          return true;
        },
      );
    }
  }
  assert.throws(
    () =>
      connectionInput.parse({
        name: 'SRV fixture',
        engine: 'mongodb',
        host: 'cluster.example.test',
        database: 'fixture',
        mongoSrv: true,
        tls: integrationTls({ DSH_DATABASE_MONGODB_TLS: 'false' }, 'DSH_DATABASE_MONGODB_TLS'),
      }),
    /SRV/,
  );
});
