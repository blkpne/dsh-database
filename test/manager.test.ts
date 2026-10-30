import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager } from '../src/manager.js';
import type { ConnectionRecord } from '../src/schema.js';
import type { MountTool } from '../src/manager.js';
import { QueryRunner } from '../src/query.js';
import type { RunnerFactory } from '../src/ports.js';
import type { RuntimeLimits } from '../src/limits.js';

function fixture(
  mount?: MountTool,
  limits: Partial<RuntimeLimits> = {},
  createRunner?: RunnerFactory,
) {
  const records = new Map<string, ConnectionRecord>();
  const secrets = new Map<string, string>();
  const mounted = new Set<string>();
  const manager = new ConnectionManager(
    {
      entries: () => records.entries(),
      get: (id) => records.get(id),
      put: async (id, record) => {
        records.set(id, record);
      },
      delete: async (id) => records.delete(id),
    },
    {
      read: async (ref) => secrets.get(ref) ?? '',
      set: async (ref, value) => {
        secrets.set(ref, value);
      },
      delete: async (ref) => {
        secrets.delete(ref);
      },
    },
    mount ??
      (async (record) => {
        mounted.add(record.id);
        return async () => {
          mounted.delete(record.id);
        };
      }),
    limits,
    createRunner,
  );
  return { manager, records, secrets, mounted };
}
const input = {
  name: 'Analytics',
  host: 'localhost',
  user: 'reader',
  password: 'test-only-placeholder',
};

test('independent tools; password rotation; disabled by default; delete and teardown', async () => {
  const { manager, records, secrets, mounted } = fixture();
  let list = (await manager.save(input)).connections;
  assert.equal(list[0]!.status, 'disabled');
  assert.equal(secrets.size, 1);
  assert(!JSON.stringify(list).includes(input.password));
  assert(!JSON.stringify([...records.values()]).includes(input.password));
  const id = list[0]!.id;
  list = await manager.toggle(id, true, list[0]!.revision);
  assert(mounted.has(id));
  const name = list[0]!.toolName;
  list = (await manager.save({ ...input, name: 'Renamed', password: '' }, id, list[0]!.revision))
    .connections;
  assert.equal(list[0]!.toolName, name);
  assert.equal(secrets.size, 1);
  assert.equal([...secrets.values()][0], input.password);
  list = (
    await manager.save({ ...input, password: 'replacement-placeholder' }, id, list[0]!.revision)
  ).connections;
  assert.equal(secrets.size, 1);
  assert.equal([...secrets.values()][0], 'replacement-placeholder');
  list = (await manager.save({ ...input, name: 'Second' })).connections;
  const second = list[1]!;
  list = await manager.toggle(second.id, true, second.revision);
  assert.equal(mounted.size, 2);
  list = await manager.toggle(id, false, list[0]!.revision);
  assert.equal(mounted.size, 1);
  list = await manager.remove(id, list[0]!.revision);
  assert.equal(list.length, 1);
  assert.equal(secrets.size, 1);
  await manager.close();
  assert.equal(mounted.size, 0);
  await assert.rejects(manager.save(input), { code: 'CLOSED' });
});

test('connection names remain unique to prevent ambiguous Agent selection', async () => {
  const { manager } = fixture();
  await manager.save(input);
  await assert.rejects(manager.save({ ...input, name: ' analytics ' }), { code: 'DUPLICATE_NAME' });
  await manager.close();
});

test('stale writes are rejected, concurrent edits do not lose an update', async () => {
  const { manager } = fixture();
  const [record] = (await manager.save(input)).connections;
  const outcomes = await Promise.allSettled([
    manager.save({ ...input, name: 'One' }, record!.id, record!.revision),
    manager.save({ ...input, name: 'Two' }, record!.id, record!.revision),
  ]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(manager.list()[0]!.name, 'One');
  await manager.close();
});

test('explicit password clearing removes credential; secrets never listed', async () => {
  const { manager, secrets } = fixture();
  const [record] = (await manager.save(input)).connections;
  const [saved] = (
    await manager.save(
      { ...input, password: '', clearPassword: true },
      record!.id,
      record!.revision,
    )
  ).connections;
  assert.equal(saved!.hasPassword, false);
  assert.equal(secrets.size, 0);
  assert.equal('passwordRef' in saved!, false);
  await manager.close();
});

test('MCP registration failure is visible', async () => {
  const { manager } = fixture(async () => {
    throw new Error('raw private failure');
  });
  const [saved] = (await manager.save(input)).connections;
  const [enabled] = await manager.toggle(saved!.id, true, saved!.revision);
  assert.equal(enabled!.status, 'error');
  assert(!enabled!.error!.includes('private'));
  await manager.close();
});

test('close during activation disposes the late registration', async () => {
  let activate!: () => void;
  let entered!: () => void;
  let disposed = false;
  const barrier = new Promise<void>((resolve) => {
    activate = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { manager } = fixture(async () => {
    entered();
    await barrier;
    return async () => {
      disposed = true;
    };
  });
  const [saved] = (await manager.save(input)).connections;
  const enabling = manager.toggle(saved!.id, true, saved!.revision);
  await ready;
  const closing = manager.close();
  activate();
  await enabling;
  await closing;
  assert(disposed);
});

test('persist failure leaves previous runtime and password intact', async () => {
  const secrets = new Map<string, string>();
  const manager = new ConnectionManager(
    {
      entries: () => new Map().entries(),
      get: () => undefined,
      put: async () => {
        throw new Error('disk full');
      },
      delete: async () => false,
    },
    {
      read: async (ref) => secrets.get(ref) ?? '',
      set: async (ref, value) => {
        secrets.set(ref, value);
      },
      delete: async (ref) => {
        secrets.delete(ref);
      },
    },
    async () => {
      throw new Error('must not mount');
    },
  );
  await assert.rejects(manager.save(input));
  assert.equal(secrets.size, 0);
  await manager.close();
});

test('disable removes tool discovery immediately while waiting for driver cleanup', async (t) => {
  let cleanup!: () => void;
  let entered!: () => void;
  let registered = false;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { manager } = fixture(async (_record, runner) => {
    registered = true;
    t.mock.method(runner, 'close', async () => {
      entered();
      await new Promise<void>((resolve) => {
        cleanup = resolve;
      });
    });
    return async () => {
      registered = false;
    };
  });
  const [saved] = (await manager.save(input)).connections;
  const [enabled] = await manager.toggle(saved!.id, true, saved!.revision);
  let done = false;
  const disabling = manager.toggle(saved!.id, false, enabled!.revision).then(() => {
    done = true;
  });
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registered, false);
  assert.equal(done, false);
  cleanup();
  await disabling;
  await manager.close();
});

test('mutation queue is bounded and queued work is rejected when unload begins', async () => {
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
    enter = r;
  });
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const { manager } = fixture(
    async () => {
      enter();
      await barrier;
      return async () => {};
    },
    { maxPendingMutations: 2 },
  );
  const [saved] = (await manager.save(input)).connections;
  const active = manager.toggle(saved!.id, true, saved!.revision);
  await ready;
  const queued = assert.rejects(manager.save({ ...input, name: 'Queued' }), { code: 'CLOSED' });
  await assert.rejects(manager.save({ ...input, name: 'Overload' }), { code: 'BUSY' });
  const closing = manager.close();
  assert.equal(closing, manager.close());
  release();
  await Promise.all([closing, active, queued]);
  assert.equal(manager.list().length, 1);
});

test('restore is serialized with configuration changes and repeated restores do not leak tools', async () => {
  let mounted = 0,
    disposed = 0;
  const { manager } = fixture(async () => {
    mounted++;
    return async () => {
      disposed++;
    };
  });
  const [saved] = (await manager.save(input)).connections;
  await manager.toggle(saved!.id, true, saved!.revision);
  await Promise.all([manager.restore(), manager.restore()]);
  assert.equal(mounted, 1);
  await manager.close();
  assert.equal(disposed, 1);
});

test('credential retirement still runs after a committed removal hits a disposer failure', async () => {
  const { manager, secrets } = fixture(async () => async () => {
    throw new Error('fixture disposer failure');
  });
  const [saved] = (await manager.save(input)).connections;
  const [enabled] = await manager.toggle(saved!.id, true, saved!.revision);
  await assert.rejects(manager.remove(enabled!.id, enabled!.revision));
  assert.equal(manager.list().length, 0);
  assert.equal(secrets.size, 0);
  await assert.rejects(manager.close(), { code: 'CLEANUP_FAILED' });
});

for (const action of ['save', 'toggle', 'remove'] as const) {
  test(`${action} cancels owned probes, waits for cleanup and leaves other connections alone`, async () => {
    let entered!: () => void, clean!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const cleanup = new Promise<void>((r) => {
      clean = r;
    });
    let active = 0;
    const createRunner: RunnerFactory = (config, password) =>
      new QueryRunner(config, password, async () => async (_input, { signal }) => {
        active++;
        entered();
        try {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          await cleanup;
        } finally {
          active--;
        }
      });
    const { manager } = fixture(undefined, {}, createRunner);
    try {
      const [saved] = (await manager.save(input)).connections;
      const probe = assert.rejects(manager.test(input, saved!.id), { code: 'CANCELED' });
      await ready;
      let completed = false;
      const change = (
        action === 'save'
          ? manager.save(input, saved!.id, saved!.revision)
          : action === 'toggle'
            ? manager.toggle(saved!.id, false, saved!.revision)
            : manager.remove(saved!.id, saved!.revision)
      ).then(() => {
        completed = true;
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(active, 1);
      assert.equal(completed, false);
      if (action !== 'remove')
        await assert.rejects(manager.test(input, saved!.id), { code: 'BUSY' });
      clean();
      await Promise.all([probe, change]);
      assert.equal(active, 0);
      assert.equal(completed, true);
    } finally {
      clean();
      await manager.close();
    }
  });
}

test('connection mutation does not cancel another connection diagnostic', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  let canceled = false;
  const { manager } = fixture(
    undefined,
    {},
    (config, password) =>
      new QueryRunner(config, password, async () => async (_input, { signal }) => {
        entered();
        await new Promise<void>((r) =>
          signal.addEventListener(
            'abort',
            () => {
              canceled = true;
              r();
            },
            { once: true },
          ),
        );
      }),
  );
  try {
    const [one] = (await manager.save(input)).connections;
    const [, two] = (await manager.save({ ...input, name: 'Second' })).connections;
    const probe = manager.diagnose(two!.id, two!.revision);
    await ready;
    await manager.remove(one!.id, one!.revision);
    assert.equal(canceled, false);
    await manager.close();
    await probe;
    assert.equal(canceled, true);
  } finally {
    await manager.close();
  }
});

test('overlapping diagnoses return their own trace despite another probe finishing first', async () => {
  for (const firstFails of [true, false]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let count = 0;
    const result = {
      columns: ['probe'],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
      durationMs: 0,
      readOnly: true as const,
    };
    const { manager } = fixture(undefined, {}, () => {
      const index = ++count;
      return {
        query: async () => result,
        mongo: async () => result,
        close: async () => {},
        test: async () => {
          if (index === 1) {
            entered();
            await gate;
          }
          if ((index === 1) === firstFails) {
            const { DatabaseError } = await import('../src/errors.js');
            throw new DatabaseError('METADATA_DENIED', 'synthetic failure');
          }
          return result;
        },
      };
    });
    try {
      const saved = await manager.save(input);
      const connection = saved.connections[0]!;
      const first = manager.diagnose(connection.id, connection.revision);
      await ready;
      const second = await manager.diagnose(connection.id, connection.revision);
      release();
      const response = await first;
      assert.equal(response.trace.outcome, firstFails ? 'denied' : 'success');
      assert.equal(second.trace.outcome, firstFails ? 'success' : 'denied');
      assert.notEqual(response.trace.requestId, second.trace.requestId);
      assert.equal(response.observations.lastProbe?.requestId, second.trace.requestId);
      assert.equal(response.trace.connectionId, connection.id);
      response.trace.outcome = 'running';
      assert.notEqual(
        manager.observations
          .snapshot(connection.id)
          .records.find((r) => r.requestId === response.trace.requestId)?.outcome,
        'running',
      );
    } finally {
      release();
      await manager.close();
    }
  }
});
