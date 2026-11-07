/** Real Oracle TCPS authentication/query; wallets and data belong only to this runner. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory, projectPath } from '../../scripts/paths.mjs';
import { command, docker } from './process.js';
import { withContainer } from './lifecycle.js';
import { config, waitReady, seed } from './fixtures.js';
import { createTlsCertificates } from './tls-certificates.js';
import { withIpv6Proxy } from './ipv6-proxy.js';

const root = await temporaryDirectory('oracle-tcps-');
const directory = join(root, 'private');
const results: unknown[] = [];
await mkdir(directory, { mode: 0o700 });
try {
  await createTlsCertificates(directory);
  const walletPassword = randomBytes(20).toString('hex');
  // This generated wallet password is only an ephemeral fixture secret, sent on stdin/env.
  await command(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-inkey',
      join(directory, 'server.key'),
      '-in',
      join(directory, 'matching.pem'),
      '-certfile',
      join(directory, 'ca.pem'),
      '-out',
      join(directory, 'server.p12'),
      '-passout',
      'stdin',
    ],
    { input: walletPassword },
  );
  const classpath = process.env.DSH_TEST_ORAPKI_CLASSPATH;
  if (!classpath)
    throw new Error(
      'Set DSH_TEST_ORAPKI_CLASSPATH to Oracle PKI test jars; the lite image has no orapki',
    );
  const wallet = join(directory, 'wallet');
  await mkdir(wallet, { mode: 0o700 });
  const orapki = (args: string[]) =>
    command('java', ['-cp', classpath, 'oracle.security.pki.textui.OraclePKITextUI', ...args]);
  await orapki(['wallet', 'create', '-wallet', wallet, '-pwd', walletPassword, '-auto_login']);
  await orapki([
    'wallet',
    'import_pkcs12',
    '-wallet',
    wallet,
    '-pwd',
    walletPassword,
    '-pkcs12file',
    join(directory, 'server.p12'),
    '-pkcs12pwd',
    walletPassword,
  ]);
  for (const file of ['ewallet.p12', 'cwallet.sso']) await chmod(join(wallet, file), 0o600);
  await withContainer(
    'oracle',
    async (instance) => {
      console.log('Oracle TCPS: initializing isolated database');
      await waitReady(instance);
      await seed(instance);
      console.log('Oracle TCPS: database seeded; configuring wallet');
      await docker(['exec', '--user', 'root', instance.name, 'mkdir', '-p', '/tmp/dsh-wallet']);
      await docker(['cp', wallet + '/.', `${instance.name}:/tmp/dsh-wallet/`]);
      await docker([
        'exec',
        '--user',
        'root',
        instance.name,
        'sh',
        '-c',
        'chown -R oracle:oinstall /tmp/dsh-wallet; chmod 700 /tmp/dsh-wallet; chmod 600 /tmp/dsh-wallet/*',
      ]);
      // Reuse the owned published port only after plaintext seeding has finished. No TLS downgrade.
      // Stop using the old TCP listener configuration before replacing its address.
      await docker(['exec', instance.name, 'lsnrctl', 'stop']);
      const security =
        'WALLET_LOCATION=(SOURCE=(METHOD=FILE)(METHOD_DATA=(DIRECTORY=/tmp/dsh-wallet)))\nSSL_CLIENT_AUTHENTICATION=FALSE\n';
      const listener =
        'LISTENER=(DESCRIPTION_LIST=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=0.0.0.0)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=1522))))\n' +
        security;
      await docker(
        ['exec', '-i', instance.name, 'sh', '-c', 'cat >> "$ORACLE_HOME/network/admin/sqlnet.ora"'],
        { input: '\n' + security },
      );
      const started = await docker(
        [
          'exec',
          '-i',
          instance.name,
          'sh',
          '-c',
          'cat > "$ORACLE_HOME/network/admin/listener.ora"; lsnrctl start >/tmp/dsh-listener-start.log 2>&1; echo $?',
        ],
        { input: listener },
      );
      if (started !== '0') {
        const log = await docker(['exec', instance.name, 'cat', '/tmp/dsh-listener-start.log']);
        results.push({
          listenerStartFailure: true,
          diagnostic: log.split('\n').filter((line) => /TNS-|error|fail/i.test(line)),
        });
        throw new Error('Owned TCPS listener failed to start; see result.json');
      }
      // Register the PDB with the new listener, using local OS authentication only.
      await docker(['exec', '-i', instance.name, 'sh', '-c', 'sqlplus -s / as sysdba'], {
        input:
          "ALTER SYSTEM SET LOCAL_LISTENER='(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=1522))' SCOPE=MEMORY;\nALTER SYSTEM REGISTER;\nEXIT;\n",
      });
      const deadline = Date.now() + 30000;
      for (;;) {
        const status = await docker(['exec', instance.name, 'lsnrctl', 'status']);
        if (/freepdb1/i.test(status)) break;
        if (Date.now() >= deadline)
          throw new Error('Owned TCPS listener did not register FREEPDB1');
        await delay(500);
      }
      const query = async (host: string, port: number, trusted: boolean, node = process.execPath) =>
        JSON.parse(
          await command(node, ['--import', 'tsx', projectPath('test/docker/tls-worker.ts')], {
            input: JSON.stringify({
              config: { ...config(instance), host, port, tls: true },
              password: instance.password,
              sql: "SELECT TO_CHAR(SUM(amount)) FROM SYSTEM.dsh_test_items WHERE category = 'A'",
            }),
            env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? join(directory, 'ca.pem') : '' },
            timeoutMs: 25000,
          }),
        );
      for (const host of ['127.0.0.1', 'localhost']) {
        const result = await query(host, instance.port, true);
        results.push({ host, trusted: true, node: process.version, result });
        await writeFile(join(root, 'result.json'), JSON.stringify({ results }, null, 2));
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.rows[0][0], '30.375');
      }
      await withIpv6Proxy(instance.port, async (port) => {
        for (const node of [
          process.execPath,
          ...(process.env.DSH_TEST_NODE_CONTROLS?.split(',') ?? []),
        ]) {
          const version = await command(node, ['--version']);
          const result = await query('::1', port, true, node);
          results.push({ host: '::1', trusted: true, node: version, result });
          await writeFile(join(root, 'result.json'), JSON.stringify({ results }, null, 2));
          // The known bad runtime is an explicit negative control, never a passing IPv6 case.
          if (node !== process.execPath && /v24\.(18|19)\./.test(version)) {
            assert.equal(result.ok, false);
            assert.equal(result.code, 'NJS-506');
          } else {
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.equal(result.rows[0][0], '30.375');
          }
        }
        const result = await query('::1', port, false);
        results.push({ host: '::1', trusted: false, node: process.version, result });
        assert.equal(result.ok, false);
      });
      console.log('Oracle TCPS: authenticated exact aggregate and negative controls complete');
    },
    { timeoutMs: 600000 },
  );
} finally {
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify({ node: process.version, results }, null, 2),
  );
  await rm(directory, { recursive: true, force: true });
  console.log(`Oracle TCPS evidence: ${root}`);
}
