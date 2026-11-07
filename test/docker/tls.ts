/** Real server TLS matrix. No system trust changes and no production bypass option. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory, linkDependencies } from '../../scripts/paths.mjs';
import { parseArgs } from 'node:util';
import { command, docker } from './process.js';
import { definitions } from './definitions.js';
import { withContainer } from './lifecycle.js';
import { config, seed, waitReady, withSql } from './fixtures.js';
import { createTlsCertificates } from './tls-certificates.js';

const { values: flags } = parseArgs({
  options: { protocol: { type: 'boolean' }, engines: { type: 'string' } },
});
const engines = ['mysql', 'mariadb', 'postgresql'] as const;
const selected = flags.engines?.split(',') ?? [...engines];
if (selected.some((engine) => !engines.includes(engine as (typeof engines)[number])))
  throw new Error('TLS engines: mysql,mariadb,postgresql');
if (!flags.protocol) {
  const endpoint =
    process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
      ? process.env.DOCKER_HOST
      : await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!/^(unix|npipe):\/\//.test(endpoint))
    throw new Error('TLS engine tests require a local Docker socket/context');
  process.env.DOCKER_HOST = endpoint;
  delete process.env.DOCKER_CONTEXT;
}
const root = await temporaryDirectory('tls-');
const directory = join(root, 'work');
await mkdir(directory);
const path = (name: string) => join(directory, name);
const openssl = (args: string[]) => command('openssl', args);
const results: unknown[] = [];
try {
  await linkDependencies(directory);
  await createTlsCertificates(directory);
  console.log(
    `TLS fixture permissions explicit; caller umask ${process.umask().toString(8)} unchanged`,
  );
  if (flags.protocol) {
    const { protocolMatrix } = await import('../experiments/tls-protocol.js');
    await protocolMatrix(directory, root);
    const { pgProtocolMatrix } = await import('../experiments/pg-tls-protocol.js');
    await pgProtocolMatrix(directory, root);
    const { directTlsMatrix } = await import('../experiments/direct-tls.js');
    await directTlsMatrix(directory, root);
  } else
    for (const engine of engines.filter((engine) => selected.includes(engine))) {
      console.log(`${engine}: certificates generated, starting isolated server`);
      await writeFile(path('active.pem'), await readFile(path('matching.pem')));
      await chmod(path('active.pem'), 0o644);
      await withContainer(
        engine,
        async (instance) => {
          console.log(`${engine}: waiting for server readiness`);
          await waitReady(instance);
          const permissions = await docker([
            'exec',
            instance.name,
            'stat',
            '-c',
            '%a %U:%G',
            '/tmp/dsh-ca.pem',
            '/tmp/dsh-server-cert.pem',
            '/tmp/dsh-server-key.pem',
          ]);
          const owner = engine === 'postgresql' ? 'postgres' : 'mysql';
          assert.deepEqual(permissions.trim().split('\n'), [
            '644 root:root',
            '644 root:root',
            `600 ${owner}:${owner}`,
          ]);
          console.log(`${engine}: public certificates 0644; disposable key 0600 owned by ${owner}`);
          await seed(instance);
          console.log(`${engine}: TLS cases`);
          const query = async (host: string, trusted: boolean, lifecycle = false) =>
            JSON.parse(
              await command(process.execPath, ['--import', 'tsx', 'test/docker/tls-worker.ts'], {
                input: JSON.stringify({
                  config: { ...config(instance), host, tls: true },
                  password: instance.password,
                  lifecycle,
                }),
                env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? path('ca.pem') : '' },
                timeoutMs: 30000,
              }),
            );
          for (const [certificate, host, trusted, expected] of [
            ['matching', '127.0.0.1', true, true],
            ['matching', 'localhost', true, true],
            ['ip', '127.0.0.1', true, true],
            ['dns', 'localhost', true, true],
            ['dns', '127.0.0.1', true, false], // Must NOT fall back to validating "localhost".
            ['wrong', '127.0.0.1', true, false],
            ['wrong', 'localhost', true, false],
            ['expired', '127.0.0.1', true, false],
            ['matching', '127.0.0.1', false, false],
          ] as const) {
            console.log(`${engine}: ${certificate}/${host}/${trusted}`);
            let certificateFile = path(`${certificate}.pem`);
            let expiresAt = 0;
            if (engine === 'mysql' && certificate === 'expired') {
              // MySQL rejects an already-expired certificate during RELOAD TLS. Load a
              // briefly valid certificate, then let it expire before the client connects.
              // This exercises real server expiry without disabling any validation.
              expiresAt = Math.ceil(Date.now() / 1000) * 1000 + 15000;
              certificateFile = path('expiring.pem');
              await openssl([
                'ca',
                '-config',
                path('ca.cnf'),
                '-batch',
                '-subj',
                '/CN=expiry.fixture.invalid',
                '-startdate',
                '20200101000000Z',
                '-enddate',
                new Date(expiresAt)
                  .toISOString()
                  .replace(/[-:]/g, '')
                  .slice(0, 15)
                  .replace('T', '') + 'Z',
                '-in',
                path('server.csr'),
                '-out',
                certificateFile,
              ]);
            }
            await chmod(certificateFile, 0o644);
            await docker(['cp', certificateFile, `${instance.name}:/tmp/dsh-server-cert.pem`]);
            await withSql(instance, true, async ({ sql }) => {
              await sql(
                engine === 'mysql'
                  ? 'ALTER INSTANCE RELOAD TLS'
                  : engine === 'mariadb'
                    ? 'FLUSH SSL'
                    : 'SELECT pg_reload_conf()',
              );
            });
            if (expiresAt) {
              const valid = await query(host, trusted);
              assert.equal(valid.ok, true, 'The same certificate must work before expiry');
              assert.equal(String(valid.rows?.[0]?.[0]), '1');
              results.push({
                engine,
                certificate: 'before-expiry',
                host,
                trusted,
                expected: true,
                result: valid,
              });
              assert(Date.now() < expiresAt, 'Fixture certificate must be valid during reload');
              await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now() + 500));
            }
            if (engine === 'postgresql') await new Promise((resolve) => setTimeout(resolve, 300));
            const result = await query(host, trusted);
            const row = { engine, certificate, host, trusted, expected, result };
            results.push(row);
            console.log(JSON.stringify(row));
            await writeFile(
              `${root}/tls-results.json`,
              JSON.stringify({ node: process.version, results }, null, 2),
            );
            assert.equal(result.ok, expected, `${engine}/${certificate}/${host}/${trusted}`);
            if (expected) assert.equal(String(result.rows?.[0]?.[0]), '1');
            else
              assert.match(
                result.code,
                /^(HANDSHAKE_SSL_ERROR|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|DEPTH_ZERO_SELF_SIGNED_CERT)$/,
                'Failure must come from TLS validation, not authentication or connectivity',
              );
          }
          if (engine === 'mysql' || engine === 'mariadb') {
            const result = await query('127.0.0.1', true, true);
            assert.deepEqual(result, {
              ok: true,
              lifecycle: { truncated: true, canceled: true, recovered: true },
            });
            results.push({ engine, kind: 'TLS lifecycle', result });
            await writeFile(
              `${root}/tls-results.json`,
              JSON.stringify({ node: process.version, results }, null, 2),
            );
            console.log(`${engine}: TLS truncation, cancellation and recovery passed`);
          }
        },
        {
          timeoutMs: 240000,
          run: async (args, options) => {
            console.log(`${engine}: docker ${args[0]}`);
            if (args[0] !== 'create') return docker(args, options);
            const changed = [...args];
            const index = changed.indexOf(definitions[engine].image);
            assert(index > 0);
            const daemonArgs = changed.splice(index + 1);
            changed.splice(index, 0, '--entrypoint', '/bin/sh');
            const owner = engine === 'postgresql' ? 'postgres' : 'mysql';
            const tlsArgs =
              engine === 'postgresql'
                ? [
                    '-c',
                    'ssl=on',
                    '-c',
                    'ssl_ca_file=/tmp/dsh-ca.pem',
                    '-c',
                    'ssl_cert_file=/tmp/dsh-server-cert.pem',
                    '-c',
                    'ssl_key_file=/tmp/dsh-server-key.pem',
                  ]
                : [
                    '--ssl-ca=/tmp/dsh-ca.pem',
                    '--ssl-cert=/tmp/dsh-server-cert.pem',
                    '--ssl-key=/tmp/dsh-server-key.pem',
                  ];
            changed.push(
              '-c',
              `chown ${owner}:${owner} /tmp/dsh-server-key.pem && chmod 600 /tmp/dsh-server-key.pem && chown 0:0 /tmp/dsh-ca.pem /tmp/dsh-server-cert.pem && chmod 644 /tmp/dsh-ca.pem /tmp/dsh-server-cert.pem && exec /usr/local/bin/docker-entrypoint.sh "$@"`,
              'dsh-tls-fixture',
              engine === 'postgresql' ? 'postgres' : engine === 'mysql' ? 'mysqld' : 'mariadbd',
              ...daemonArgs,
              ...tlsArgs,
            );
            const id = await docker(changed, options);
            console.log(`${engine}: copying temporary certificates`);
            // Copy into the owned container; avoid host bind mounts and Desktop file-sharing state.
            for (const [source, target] of [
              ['ca.pem', 'ca'],
              ['active.pem', 'server-cert'],
              ['server.key', 'server-key'],
            ])
              await docker(['cp', path(source!), `${id}:/tmp/dsh-${target}.pem`], options);
            return id;
          },
        },
      );
    }
} finally {
  await rm(directory, { recursive: true, force: true });
}
