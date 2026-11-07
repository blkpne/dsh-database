/** Strict TLS to a real disposable SQL Server, including authentication-before/after controls. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import tedious from 'tedious';
import { temporaryDirectory, projectPath } from '../../scripts/paths.mjs';
import { command, docker, type DockerCommand } from './process.js';
import { withContainer, type Instance } from './lifecycle.js';
import { config } from './fixtures.js';
import { createTlsCertificates } from './tls-certificates.js';
import { withIpv6Proxy } from './ipv6-proxy.js';

const root = await temporaryDirectory('sqlserver-tls-');
const directory = join(root, 'private');
await mkdir(directory, { mode: 0o700 });
const results: unknown[] = [];
const persist = () =>
  writeFile(
    join(root, 'result.json'),
    JSON.stringify(
      {
        node: process.version,
        ipv6Transport:
          'byte forwarding from ::1 to owned IPv4 Docker publication, no TLS termination',
        results,
      },
      null,
      2,
    ),
  );
try {
  // A deliberately unrelated CN makes the DNS cases prove SAN matching, not CN fallback.
  await createTlsCertificates(directory);
  const admin = async (instance: Instance, text: string, database = 'master') => {
    const client = new tedious.Connection({
      server: '127.0.0.1',
      authentication: {
        type: 'default',
        options: { userName: 'sa', password: instance.adminPassword },
      },
      options: {
        port: instance.port,
        database,
        encrypt: true,
        trustServerCertificate: false,
        cryptoCredentialsDetails: { ca: await readFile(join(directory, 'ca.pem')) },
        connectTimeout: 3000,
        requestTimeout: 10000,
        maxRetriesOnTransientErrors: 0,
      },
    });
    client.on('error', () => {});
    const ended = new Promise<void>((resolve) => client.once('end', resolve));
    try {
      await new Promise<void>((resolve, reject) =>
        client.connect((e) => (e ? reject(e) : resolve())),
      );
      return await new Promise<unknown[][]>((resolve, reject) => {
        const rows: unknown[][] = [];
        const req = new tedious.Request(text, (e) => (e ? reject(e) : resolve(rows)));
        req.on('row', (columns: { value: unknown }[]) => rows.push(columns.map((c) => c.value)));
        client.execSql(req);
      });
    } catch (error) {
      const logs = await docker(['logs', '--tail', '120', instance.name]);
      results.push({
        adminFailure: true,
        database,
        code: (error as { code?: string }).code,
        diagnostic: logs
          .replaceAll(instance.adminPassword, '[fixture secret]')
          .split('\n')
          .filter((line) => /Login failed|Reason:|Error: 18456/i.test(line)),
      });
      await persist();
      throw error;
    } finally {
      client.close();
      await ended;
    }
  };
  let stageName = '';
  const run: DockerCommand = async (args, options) => {
    if (args[0] === 'create') {
      stageName = args[args.indexOf('--name') + 1]!;
      const image = args.findIndex((a) => a.startsWith('mcr.microsoft.com/mssql/server:'));
      args = [
        ...args.slice(0, image),
        '--user',
        'root',
        '--entrypoint',
        '/bin/sh',
        ...args.slice(image),
        '-c',
        'mkdir -p /var/opt/mssql/secrets; cp /tmp/dsh-key.pem /var/opt/mssql/secrets/server.key; cp /tmp/dsh-cert.pem /var/opt/mssql/secrets/server.pem; chown -R mssql:mssql /var/opt/mssql/secrets; chmod 700 /var/opt/mssql/secrets; chmod 600 /var/opt/mssql/secrets/server.key; chmod 644 /var/opt/mssql/secrets/server.pem; exec runuser -u mssql -- /opt/mssql/bin/sqlservr',
      ];
      const out = await docker(args, options);
      await docker(['cp', join(directory, 'server.key'), `${stageName}:/tmp/dsh-key.pem`]);
      await docker(['cp', join(directory, 'matching.pem'), `${stageName}:/tmp/dsh-cert.pem`]);
      const conf = join(directory, 'mssql.conf');
      await writeFile(
        conf,
        '[network]\ntlscert=/var/opt/mssql/secrets/server.pem\ntlskey=/var/opt/mssql/secrets/server.key\ntlsprotocols=1.2\nforceencryption=1\n',
      );
      await chmod(conf, 0o644);
      await docker(['cp', conf, `${stageName}:/var/opt/mssql/mssql.conf`]);
      return out;
    }
    return docker(args, options);
  };
  await withContainer(
    'sqlserver',
    async (instance) => {
      const ready = async () => {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const state = JSON.parse(
            await docker(['inspect', '--format', '{{json .State}}', instance.name]),
          );
          if (!state.Running || state.OOMKilled) {
            const logs = await docker(['logs', '--tail', '120', instance.name]);
            results.push({
              startupFailure: true,
              exitCode: state.ExitCode,
              oomKilled: state.OOMKilled,
              diagnostic: logs
                .replaceAll(instance.adminPassword, '[fixture secret]')
                .split('\n')
                .filter((line) => /error|certificate|permission|denied|failed/i.test(line)),
            });
            await persist();
            throw new Error('Owned TLS SQL Server stopped during startup; see result.json');
          }
          const logs = await docker([
            'logs',
            '--since',
            state.StartedAt,
            '--tail',
            '100',
            instance.name,
          ]);
          if (logs.includes('SQL Server is now ready for client connections')) {
            // Docker may assign a different ephemeral host port after restart.
            const published = await docker(['port', instance.name, '1433/tcp']);
            const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
            assert(match, 'SQL Server must remain exclusively loopback-published');
            instance.port = Number(match[1]);
            return;
          }
          await delay(500);
        }
        throw new Error('TLS SQL Server startup deadline');
      };
      await ready();
      console.log('SQL Server TLS: server ready, strict admin authentication');
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          await admin(instance, 'SELECT 1');
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await delay(1000);
        }
      }
      await admin(instance, 'CREATE DATABASE dsh_test');
      await admin(
        instance,
        `CREATE LOGIN dsh_reader WITH PASSWORD='${instance.password}', CHECK_POLICY=OFF`,
      );
      await admin(
        instance,
        'CREATE TABLE dsh_test_items (id int PRIMARY KEY, amount decimal(18,3)); INSERT INTO dsh_test_items VALUES (1,10.125),(2,20.250); CREATE USER dsh_reader FOR LOGIN dsh_reader; ALTER ROLE db_datareader ADD MEMBER dsh_reader; ALTER ROLE db_denydatawriter ADD MEMBER dsh_reader;',
        'dsh_test',
      );
      const version = await admin(
        instance,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(128))",
      );
      results.push({
        serverVersion: version[0]![0],
        permissions: await docker([
          'exec',
          instance.name,
          'stat',
          '-c',
          '%a %U:%G',
          '/var/opt/mssql/secrets',
          '/var/opt/mssql/secrets/server.key',
          '/var/opt/mssql/secrets/server.pem',
        ]),
      });
      const query = async (
        host: string,
        port: number,
        trusted: boolean,
        node = process.execPath,
        user = 'dsh_reader',
      ) =>
        JSON.parse(
          await command(node, ['--import', 'tsx', projectPath('test/docker/tls-worker.ts')], {
            input: JSON.stringify({
              config: { ...config(instance), host, port, tls: true, user },
              password: instance.password,
              tlsDiagnostics: true,
              sql: 'SELECT CAST(SUM(amount) AS varchar(100)) FROM dsh_test_items',
            }),
            env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? join(directory, 'ca.pem') : '' },
            timeoutMs: 25000,
          }),
        );
      const runtimes = [
        process.execPath,
        ...(process.env.DSH_TEST_NODE_CONTROLS?.split(',') ?? []),
      ];
      const logFailures = async () => {
        const log = await docker(['exec', instance.name, 'cat', '/var/opt/mssql/log/errorlog']);
        return (log.match(/Login failed for user 'dsh_tls_probe'/g) ?? []).length;
      };
      for (const certificate of ['matching', 'ip', 'dns', 'wrong', 'expired']) {
        if (certificate !== 'matching') {
          await docker([
            'cp',
            join(directory, certificate + '.pem'),
            `${instance.name}:/tmp/dsh-cert.pem`,
          ]);
          await docker(['restart', instance.name], { timeoutMs: 60000 });
          await ready();
          const log = await docker(['logs', '--tail', '100', instance.name]);
          results.push({
            certificate,
            serverCertificateDiagnostic: log
              .split('\n')
              .filter((line) => /certificate|SSL|TLS|encryption/i.test(line)),
          });
          await persist();
        }
        await withIpv6Proxy(instance.port, async (ipv6Port) => {
          for (const node of runtimes) {
            const nodeVersion = await command(node, ['--version']);
            for (const host of ['localhost', '127.0.0.1', '::1']) {
              const expected =
                certificate === 'matching' ||
                (certificate === 'ip' && host === '127.0.0.1') ||
                (certificate === 'dns' && host === 'localhost');
              const port = host === '::1' ? ipv6Port : instance.port;
              const result = await query(host, port, true, node);
              results.push({
                certificate,
                host,
                node: nodeVersion,
                trusted: true,
                expected,
                result,
              });
              await persist();
              assert.equal(
                result.ok,
                expected,
                JSON.stringify({ certificate, host, nodeVersion, result }),
              );
              if (expected) assert.equal(result.rows[0][0], '30.375');
              else
                assert(
                  result.tlsErrorCodes.some((code: string) =>
                    /ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED/.test(code),
                  ),
                  'A refusal must be a certificate error, not a stale port/network failure',
                );
              // A real failed-login positive control proves server error-log observation works.
              if (node === process.execPath) {
                const before = await logFailures();
                const probe = await query(host, port, true, node, 'dsh_tls_probe');
                await delay(100);
                const after = await logFailures();
                results.push({
                  certificate,
                  host,
                  credentialBoundary: true,
                  expectedAuthenticationReached: expected,
                  observedFailedLogins: after - before,
                  result: probe,
                });
                await persist();
                assert.equal(
                  after > before,
                  expected,
                  'Certificate rejection must precede LOGIN7 authentication',
                );
              }
            }
            if (certificate === 'matching') {
              const result = await query('::1', ipv6Port, false, node);
              results.push({
                certificate,
                host: '::1',
                node: nodeVersion,
                trusted: false,
                expected: false,
                result,
              });
              await persist();
              assert.equal(result.ok, false);
              assert(
                result.tlsErrorCodes.some((code: string) =>
                  /SELF_SIGNED|UNABLE_TO_|CERT_UNTRUSTED/.test(code),
                ),
                'Untrusted CA must be rejected by chain validation',
              );
            }
          }
        });
        console.log(`SQL Server TLS: ${certificate} complete`);
      }
    },
    { run, timeoutMs: 600000 },
  );
} finally {
  await persist();
  await rm(directory, { recursive: true, force: true });
  console.log(`SQL Server TLS evidence: ${root}`);
}
