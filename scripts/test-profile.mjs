import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Uses the supported DSH launch-token exchange, not the browser's cookie store.
const logPath = process.env.DSH_DATABASE_TEST_PROFILE_LOG;
assert(logPath, 'Set DSH_DATABASE_TEST_PROFILE_LOG to the local test Profile startup log.');
const log = await readFile(logPath, 'utf8');
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
assert(url, 'No local DSH startup URL found.');
const origin = new URL(url).origin;
const login = await fetch(url, { redirect: 'manual' });
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert(cookie, 'Host did not issue its authentication cookie.');
const request = (headers = {}, body = { action: 'list' }) =>
  fetch(`${origin}/api/dsh-database`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
assert.equal((await request()).status, 401);
assert.equal((await request({ cookie, origin: 'https://untrusted.example' })).status, 403);
const response = await request({ cookie, origin });
assert.equal(response.status, 200);
const data = await response.json();
assert.equal(data.ok, true);
for (const connection of data.connections) {
  assert(!('password' in connection));
  assert(!('passwordRef' in connection));
  assert.match(connection.toolName, /^mcp__dshdb_[a-f0-9]{16}__query$/);
}
assert.equal((await request({ cookie, origin }, { action: 'unsupported' })).status, 400);
console.log(
  `Profile smoke passed: authentication 401, origin 403, list 200, invalid input 400; ${data.connections.length} connection(s), no credential fields.`,
);
