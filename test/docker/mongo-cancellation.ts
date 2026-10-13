import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as Database from '../../src/index.js';
import { queryResult } from '../../src/schema.js';
import { harness } from '../harness.js';
import { QueryRunner } from '../../src/query.js';
import { QueryCapacity } from '../../src/limits.js';
import { config, withMongo } from './fixtures.js';
import type { Instance } from './lifecycle.js';

/** Server observations use only the disposable fixture's admin account, never product commands. */
export async function exerciseMongoCancellation(instance: Instance): Promise<void> {
  assert.equal(instance.engine, 'mongodb');
  const collection = 'dsh_cancel_probe';
  await withMongo(instance, true, async (observer) => {
    const admin = observer.db('admin');
    const db = observer.db('dsh_test');
    await db.collection(collection).insertOne({ fixture: true });
    const capacity = new QueryCapacity(1);
    const settings = config(instance);
    const makeRunner = (timeoutMs: number) =>
      new QueryRunner({ ...settings, timeoutMs }, async () => instance.password, undefined, {
        capacity,
      });
    const recovery = makeRunner(10000);
    const connections = async (): Promise<number> =>
      (await admin.command({ serverStatus: 1 })).connections.current;
    const operations = async (): Promise<any[]> => {
      const result = await admin.command({ currentOp: 1, $all: true });
      return result.inprog.filter(
        (op: any) =>
          op.active &&
          (op.command?.aggregate === collection || op.command?.collection === collection) &&
          (op.ns === `dsh_test.${collection}` || op.command?.$db === 'dsh_test'),
      );
    };
    const until = async (name: string, predicate: () => Promise<boolean>, timeoutMs: number) => {
      const deadline = performance.now() + timeoutMs;
      do {
        instance.signal.throwIfAborted();
        if (await predicate()) return;
        await delay(25, undefined, { signal: instance.signal });
      } while (performance.now() < deadline);
      assert.fail(name);
    };
    // A blocking group processes 100 million virtual rows from one tiny document.
    // Only allowed stages/expressions are used; no sleep, JavaScript or server failpoints.
    const query = {
      operation: 'aggregate',
      collection,
      pipeline: [
        { $project: { a: { $range: [0, 10000] }, b: { $range: [0, 10000] } } },
        { $unwind: '$a' },
        { $unwind: '$b' },
        { $group: { _id: null, total: { $sum: '$b' } } },
      ],
    };
    try {
      // Ensure driver loading is outside the measured cancellation paths.
      assert.equal((await recovery.test(instance.signal)).readOnly, true);
      await delay(250, undefined, { signal: instance.signal });
      const baseline = await connections();
      for (const mode of ['cancel', 'timeout', 'close'] as const) {
        const runner = makeRunner(mode === 'timeout' ? 2500 : 15000);
        const controller = new AbortController();
        const started = performance.now();
        let settled = false;
        const outcome = runner
          .mongo(query, AbortSignal.any([instance.signal, controller.signal]))
          .then(
            () => ({ code: 'UNEXPECTED_SUCCESS' }),
            (error: unknown) => ({ code: (error as { code?: string }).code }),
          )
          .finally(() => {
            settled = true;
          });
        try {
          await until(
            'query must be observed executing on the server',
            async () => {
              assert.equal(settled, false, 'query completed before server observation');
              return (await operations()).length === 1;
            },
            2000,
          );
          await delay(100, undefined, { signal: instance.signal });
          assert.equal(settled, false);
          assert.equal((await operations()).length, 1, 'query must still be running');
          // A separate runner exercises the shared budget, not just the per-runner limit.
          await assert.rejects(recovery.test(instance.signal), { code: 'BUSY' });
          const observedMs = Math.round(performance.now() - started);
          const stopped = mode === 'timeout' ? started + 2500 : performance.now();
          let closing: Promise<void> | undefined;
          if (mode === 'cancel') controller.abort();
          else if (mode === 'close') closing = runner.close();
          assert.equal((await outcome).code, mode === 'timeout' ? 'TIMEOUT' : 'CANCELED');
          await closing;
          const outcomeMs = Math.round(performance.now() - started);
          assert(performance.now() - stopped < 2000, 'driver cleanup exceeded cancellation budget');
          // Check immediately after completion, before polling the server or draining monitors.
          const release = capacity.acquire();
          release();
          // Driver completion alone is insufficient: require independent server confirmation.
          await until(
            'server query remains active after cancellation',
            async () => (await operations()).length === 0,
            2000,
          );
          const serverGoneMs = Math.round(performance.now() - stopped);
          assert(serverGoneMs < 2000, 'server termination exceeded cancellation budget');
          await until(
            'query-owned client connections remain open',
            async () => (await connections()) <= baseline,
            3000,
          );
          const read = { operation: 'count', collection, filter: { fixture: true } };
          assert.equal((await recovery.mongo(read, instance.signal)).rows[0]?.[0], 1);
          if (mode === 'close')
            await assert.rejects(runner.test(instance.signal), { code: 'CONNECTION_DISABLED' });
          else assert.equal((await runner.mongo(read, instance.signal)).rows[0]?.[0], 1);
          await until(
            'recovery query connections remain open',
            async () => (await connections()) <= baseline,
            3000,
          );
          console.log(
            `  mongodb in-flight ${mode}: observed=${observedMs}ms outcome=${outcomeMs}ms serverGoneAfterStop=${serverGoneMs}ms; ` +
              `operations=0 connections<=${baseline} budget=released recovery=passed`,
          );
        } finally {
          controller.abort();
          await runner.close();
          await outcome;
        }
      }
      // Use real Host providers and the product apply function with public test-only limits.
      const limitedPlugin: typeof Database = {
        ...Database,
        apply(ctx, options) {
          return Database.apply(ctx, { ...options, maxConcurrentQueries: 1 });
        },
      };
      for (const mode of ['disable', 'delete', 'unload'] as const) {
        const directory = await mkdtemp(join(tmpdir(), 'dsh-mongodb-host-cancel-'));
        let app: Awaited<ReturnType<typeof harness>> | undefined;
        let restored: { dispose(): Promise<void> } | undefined;
        let pending: Promise<unknown> | undefined;
        try {
          const host = (app = await harness(directory, 'native', limitedPlugin));
          const save = async (name: string) => {
            const saved = await host.api({
              action: 'save',
              connection: { ...settings, timeoutMs: 15000, name, password: instance.password },
            });
            const record = saved.connections.find((value: any) => value.name === name);
            const enabled = await host.api({
              action: 'toggle',
              id: record.id,
              revision: record.revision,
              enabled: true,
            });
            return enabled.connections.find((value: any) => value.id === record.id);
          };
          const record = await save(`Host cancellation ${mode}`);
          const other = await save(`Host recovery ${mode}`);
          const read = { operation: 'count', collection, filter: { fixture: true } };
          const call = (name: string, args: Record<string, unknown>, label: string) =>
            host.ctx.tools.execute({
              name,
              arguments: args,
              callId: ToolCallId(`mongo-${mode}-${label}`),
              signal: instance.signal,
            });
          const warm = await call(other.toolName, read, 'warm');
          assert.equal(warm.isError, false);
          assert.equal(queryResult.parse(warm.value).rows[0]?.[0], 1);
          await until(
            'warm-up connections remain open',
            async () => (await connections()) <= baseline,
            3000,
          );
          let settled = false;
          const started = performance.now();
          const outcome = call(record.toolName, query, 'in-flight').finally(() => {
            settled = true;
          });
          pending = outcome;
          void outcome.catch(() => {});
          await until(
            'Host query must be executing on the server',
            async () => {
              assert.equal(settled, false, 'Host query ended before server observation');
              return (await operations()).length === 1;
            },
            2000,
          );
          await delay(100, undefined, { signal: instance.signal });
          assert.equal(settled, false);
          assert.equal((await operations()).length, 1);
          const busy = await call(other.toolName, read, 'busy');
          assert.equal(busy.isError, true);
          assert(
            JSON.stringify(busy).includes('BUSY'),
            'different Host runner must share capacity',
          );
          const observedMs = Math.round(performance.now() - started);
          const stopped = performance.now();
          const change =
            mode === 'disable'
              ? host.api({
                  action: 'toggle',
                  id: record.id,
                  revision: record.revision,
                  enabled: false,
                })
              : mode === 'delete'
                ? host.api({ action: 'remove', id: record.id, revision: record.revision })
                : host.plugin.dispose();
          void change.catch(() => {});
          const revoked =
            mode === 'unload'
              ? [record.toolName, record.inspectToolName, other.toolName, other.inspectToolName]
              : [record.toolName, record.inspectToolName];
          await until(
            'Host tools were not revoked',
            async () => host.ctx.tools.schemas().every((tool) => !revoked.includes(tool.name)),
            2000,
          );
          const result = await outcome;
          assert.equal(result.isError, true);
          assert(
            JSON.stringify(result).includes('CANCELED'),
            'in-flight Host outcome must be canceled',
          );
          await change;
          const hostDoneMs = Math.round(performance.now() - stopped);
          assert(hostDoneMs < 2000, 'Host cleanup exceeded cancellation budget');
          await until(
            'Host cancellation left server work running',
            async () => (await operations()).length === 0,
            2000,
          );
          const serverGoneMs = Math.round(performance.now() - stopped);
          assert(serverGoneMs < 2000, 'Host server termination exceeded cancellation budget');
          await until(
            'Host cancellation left driver connections open',
            async () => (await connections()) <= baseline,
            3000,
          );
          if (mode === 'unload') restored = await host.mount();
          const list = (await host.api({ action: 'list' })).connections;
          const remaining = list.find((value: any) => value.id === record.id);
          if (mode === 'delete') assert.equal(remaining, undefined);
          else assert.equal(remaining.enabled, mode === 'unload');
          // disable/delete reuse the same Manager capacity; reload creates a fresh Manager.
          const recovered = await call(other.toolName, read, 'recovery');
          assert.equal(recovered.isError, false);
          assert.equal(queryResult.parse(recovered.value).rows[0]?.[0], 1);
          if (mode === 'disable') {
            await host.api({
              action: 'toggle',
              id: remaining.id,
              revision: remaining.revision,
              enabled: true,
            });
          }
          if (mode !== 'delete') {
            const original = await call(record.toolName, read, 'original-recovery');
            assert.equal(original.isError, false);
            assert.equal(queryResult.parse(original.value).rows[0]?.[0], 1);
          }
          await until(
            'Host recovery left driver connections open',
            async () => (await connections()) <= baseline,
            3000,
          );
          console.log(
            `  mongodb Host in-flight ${mode}: observed=${observedMs}ms hostDone=${hostDoneMs}ms ` +
              `serverGoneAfterStop=${serverGoneMs}ms; tools=revoked operations=0 ` +
              `connections<=${baseline} recovery=passed`,
          );
        } finally {
          try {
            await restored?.dispose();
          } finally {
            try {
              await app?.close();
            } finally {
              await pending?.catch(() => {});
              await rm(directory, { recursive: true, force: true });
            }
          }
        }
      }
    } finally {
      await recovery.close();
      await db.collection(collection).drop();
    }
  });
}
