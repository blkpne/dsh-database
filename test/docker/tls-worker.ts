// Credentials arrive only on stdin; each process gets its own fixture CA trust.
import { QueryRunner } from '../../src/query.js';
import { safeError } from '../../src/errors.js';
import { pathToFileURL } from 'node:url';
let body = '';
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
// Compile/load generated variants before timing the TLS probe. Cold TS/module loading
// is not part of this fixture's handshake or certificate acceptance assertion.
const adapter = input.adapter
  ? (await import(pathToFileURL(input.adapter).href)).execute
  : undefined;
const runner = new QueryRunner(
  input.config,
  async () => input.password,
  adapter ? async () => adapter : undefined,
);
try {
  const result = input.probe ? await runner.test() : await runner.query('SELECT 1 AS ok');
  console.log(JSON.stringify({ ok: true, rows: result.rows }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, ...safeError(error) }));
} finally {
  await runner.close();
}
