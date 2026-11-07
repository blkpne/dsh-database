// Credentials arrive only on stdin; each process gets its own fixture CA trust.
import { QueryRunner } from '../../src/query.js';
import { safeError } from '../../src/errors.js';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import type { Adapter } from '../../src/adapters/types.js';
let body = '';
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
// Compile/load generated variants before timing the TLS probe. Cold TS/module loading
// is not part of this fixture's handshake or certificate acceptance assertion.
let adapter: Adapter | undefined = input.adapter
  ? (await import(pathToFileURL(input.adapter).href)).execute
  : undefined;
const tlsErrorCodes: string[] = [];
if (input.tlsDiagnostics) {
  const actual: Adapter =
    adapter ?? (await import(`../../src/adapters/${input.config.engine}.js`)).execute;
  adapter = async (...args) => {
    try {
      return await actual(...args);
    } catch (error) {
      const visit = (value: unknown, depth = 0): void => {
        if (!value || typeof value !== 'object' || depth > 6) return;
        const e = value as { code?: string; cause?: unknown; errors?: unknown[] };
        if (
          typeof e.code === 'string' &&
          /^(ERR_TLS_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|ECONN|ESOCKET|ELOGIN|ETIMEOUT|NJS-)/.test(
            e.code,
          )
        )
          tlsErrorCodes.push(e.code);
        visit(e.cause, depth + 1);
        for (const child of e.errors ?? []) visit(child, depth + 1);
      };
      visit(error);
      throw error;
    }
  };
}
const runner = new QueryRunner(
  input.config,
  async () => input.password,
  adapter ? async () => adapter : undefined,
);
try {
  if (input.lifecycle) {
    const capped = await runner.query('SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3');
    assert.equal(capped.truncated, true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await assert.rejects(runner.query('SELECT SLEEP(10) AS n', controller.signal), {
        code: 'CANCELED',
      });
    } finally {
      clearTimeout(timer);
    }
    const recovered = await runner.query('SELECT 1 AS ok');
    assert.equal(String(recovered.rows[0]?.[0]), '1');
    console.log(
      JSON.stringify({ ok: true, lifecycle: { truncated: true, canceled: true, recovered: true } }),
    );
  } else {
    const result = input.probe
      ? await runner.test()
      : await runner.query(input.sql ?? 'SELECT 1 AS ok');
    console.log(JSON.stringify({ ok: true, rows: result.rows }));
  }
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      ...safeError(error),
      ...(input.tlsDiagnostics ? { tlsErrorCodes } : {}),
    }),
  );
} finally {
  await runner.close();
}
