import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { execute } from '../src/adapters/postgresql.js';
import { callContext, cancellation, Observatory } from '../src/observability.js';
import { connectionInput } from '../src/schema.js';
import { ResultCollector } from '../src/result.js';

for (const foreignContext of [true, false]) {
  for (const confirmed of [true, false]) {
    test(`PostgreSQL external cancellation retains its own trace (foreign context: ${foreignContext}, server confirmation: ${confirmed})`, async (t) => {
      const closed: FixtureClient[] = [];
      let running!: pg.Query;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      class FixtureClient extends EventEmitter {
        async connect() {}
        async end() {
          closed.push(this);
        }
        query(query: string | pg.Query, values?: unknown[]) {
          if (typeof query !== 'string') {
            running = query;
            started();
            return query;
          }
          if (query === 'SELECT pg_terminate_backend($1)') {
            assert.deepEqual(values, [123]);
            return Promise.resolve({ rows: [{ pg_terminate_backend: true }] });
          }
          return Promise.resolve({ rows: [{ pid: 123 }] });
        }
      }
      t.mock.method(pg, 'Client', function () {
        return new FixtureClient();
      } as any);
      const observatory = new Observatory();
      const trace = observatory.start({ connectionId: 'target', revision: 1, operation: 'query' });
      const unrelated = observatory.start({
        connectionId: 'other',
        revision: 1,
        operation: 'query',
      });
      const controller = new AbortController();
      const config = connectionInput.parse({
        name: 'Observation fixture',
        engine: 'postgresql',
        host: 'localhost',
        user: 'reader',
        database: 'fixture',
        tls: false,
      });
      const operation = observatory.observe(trace, () =>
        execute('SELECT 1', {
          config,
          password: '',
          signal: controller.signal,
          result: new ResultCollector(10),
        }),
      );
      const rejected = assert.rejects(operation, /aborted/);
      await ready;
      // AbortSignal and driver EventEmitter callbacks run in their caller's context,
      // which can be absent or belong to an unrelated Host request.
      cancellation(false, trace);
      observatory.finish(trace, 'CANCELED', true);
      const cancel = () => {
        controller.abort();
        if (confirmed)
          running.emit('error', Object.assign(new Error('terminated'), { code: '57P01' }));
      };
      if (foreignContext) callContext.run(unrelated, cancel);
      else {
        assert.equal(callContext.getStore(), undefined);
        cancel();
      }
      await rejected;
      assert.equal(closed.length, 2, 'both actual driver sessions closed');
      assert.equal(new Set(closed).size, 2, 'each driver session closed once');
      assert.equal(trace.driverClosed, true);
      assert.equal(trace.serverTermination, confirmed ? 'confirmed' : 'unknown');
      assert.equal(trace.code, 'CANCELED');
      assert.equal(trace.finalHostOutcome, true);
      assert.equal(unrelated.driverClosed, false);
      assert.equal(unrelated.serverTermination, 'not-requested');
      await observatory.close();
    });
  }
}
