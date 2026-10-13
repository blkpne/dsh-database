import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionRuntimes } from '../src/runtime.js';
import { connectionRecord } from '../src/schema.js';
import type { ConnectionRunner, MountTool } from '../src/ports.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const record = connectionRecord.parse({
  name: 'Runtime',
  host: 'localhost',
  user: 'unused',
  id: '0123456789abcdef',
  revision: 1,
  enabled: true,
  createdAt: '',
  updatedAt: '',
});
const secrets = { read: async () => '', set: async () => {}, delete: async () => {} };
function runner(close: () => Promise<void>): ConnectionRunner {
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  return { query: unused, mongo: unused, test: unused, close };
}

test('duplicate restore shares one activation and all close callers await late registration cleanup', async () => {
  const entered = deferred(),
    mount = deferred(),
    cleanup = deferred();
  let mounted = 0,
    disposed = 0,
    closed = false;
  const runtimes = new ConnectionRuntimes(
    secrets,
    async () => {
      mounted++;
      entered.resolve();
      await mount.promise;
      return async () => {
        disposed++;
        await cleanup.promise;
      };
    },
    () =>
      runner(async () => {
        closed = true;
      }),
  );
  const start = runtimes.start(record);
  const duplicate = runtimes.start(record);
  assert.equal(start, duplicate);
  await entered.promise;
  const close = runtimes.close();
  assert.equal(close, runtimes.close());
  let finished = false;
  void close.then(() => {
    finished = true;
  });
  mount.resolve();
  await new Promise((r) => setImmediate(r));
  assert(closed);
  assert.equal(disposed, 1);
  assert.equal(finished, false);
  cleanup.resolve();
  await Promise.all([start, duplicate, close]);
  assert.equal(mounted, 1);
  assert.equal(runtimes.status(record.id).status, 'disabled');
});

test('stop retires discovery while close still owns a runner being cleaned up', async () => {
  const cleanup = deferred(),
    entered = deferred();
  let registered = true;
  const runtimes = new ConnectionRuntimes(
    secrets,
    async () => async () => {
      registered = false;
    },
    () =>
      runner(async () => {
        entered.resolve();
        await cleanup.promise;
      }),
  );
  await runtimes.start(record);
  const stop = runtimes.stop(record.id);
  await entered.promise;
  const close = runtimes.close();
  let finished = false;
  void close.then(() => {
    finished = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(registered, false);
  assert.equal(finished, false);
  cleanup.resolve();
  await Promise.all([stop, close]);
});

test('one cleanup failure cannot cause close to finish before the other runners are drained', async () => {
  const cleanup = deferred();
  let runners = 0,
    disposed = 0;
  const mount: MountTool = async () => async () => {
    disposed++;
  };
  const runtimes = new ConnectionRuntimes(secrets, mount, () => {
    const index = runners++;
    return runner(async () => {
      if (index === 0) throw new Error('fixture failure');
      await cleanup.promise;
    });
  });
  await runtimes.start(record);
  await runtimes.start({ ...record, id: '1123456789abcdef' });
  let finished = false;
  const close = assert.rejects(runtimes.close()).then(() => {
    finished = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, 2);
  assert.equal(finished, false);
  cleanup.resolve();
  await close;
});

test('a late registration disposal failure is reported to close instead of swallowed as a mount error', async () => {
  const entered = deferred(),
    mount = deferred();
  const runtimes = new ConnectionRuntimes(
    secrets,
    async () => {
      entered.resolve();
      await mount.promise;
      return async () => {
        throw new Error('fixture disposal failure');
      };
    },
    () => runner(async () => {}),
  );
  const starting = assert.rejects(runtimes.start(record), /fixture disposal failure/);
  await entered.promise;
  const closing = assert.rejects(runtimes.close(), /fixture disposal failure/);
  mount.resolve();
  await Promise.all([starting, closing]);
});
