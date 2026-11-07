import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './process.js';
import { prepareTlsFiles } from './tls-files.js';

/** Public test certificates and private keys owned by one caller's disposable directory. */
export async function createTlsCertificates(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = (name: string) => join(directory, name);
  const openssl = (args: string[]) => command('openssl', args);
  const configValue = (value: string) => `"${value.replace(/[\\"$]/g, '\\$&')}"`;
  // Exercise OpenSSL's parser on Windows drive/UNC paths and shell-like filename characters.
  // This stays in the optional TLS suite: basic development does not require OpenSSL.
  for (const value of [
    String.raw`C:\Users\alice\database test\ca.pem`,
    String.raw`C:\Users\alice $lab #1\ca.pem`,
    String.raw`\\server\share $test\ca.pem`,
    '/tmp/a "quote" # $HOME/ca.pem',
  ]) {
    await writeFile(path('path.cnf'), `asn1=FORMAT:UTF8,UTF8String:${configValue(value)}\n`);
    await openssl(['asn1parse', '-genconf', path('path.cnf'), '-out', path('path.der'), '-noout']);
    const bytes = Buffer.from(value);
    assert(bytes.length < 128);
    assert.deepEqual(
      await readFile(path('path.der')),
      Buffer.concat([Buffer.from([0x0c, bytes.length]), bytes]),
      'OpenSSL must preserve the configured path exactly',
    );
  }
  console.log('OpenSSL config: 4 path round-trip checks passed');
  await openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path('ca.key'),
    '-out',
    path('ca.pem'),
    '-days',
    '2',
    '-subj',
    '/CN=DSH isolated TLS fixture',
  ]);
  await openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path('server.key'),
    '-out',
    path('server.csr'),
    '-subj',
    '/CN=fixture.invalid',
  ]);
  for (const [name, san] of [
    ['matching', 'DNS:localhost,IP:127.0.0.1,IP:::1'],
    ['dns', 'DNS:localhost'],
    ['ip', 'IP:127.0.0.1'],
    ['wrong', 'DNS:wrong.invalid'],
  ] as const) {
    await writeFile(path(`${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
    await openssl([
      'x509',
      '-req',
      '-in',
      path('server.csr'),
      '-CA',
      path('ca.pem'),
      '-CAkey',
      path('ca.key'),
      '-CAcreateserial',
      '-out',
      path(`${name}.pem`),
      '-days',
      '2',
      '-extfile',
      path(`${name}.ext`),
    ]);
  }
  await writeFile(path('index'), '');
  await writeFile(path('serial'), '10\n');
  await writeFile(
    path('ca.cnf'),
    `[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=${configValue(path('index'))}\nserial=${configValue(path('serial'))}\nnew_certs_dir=${configValue(directory)}\ncertificate=${configValue(path('ca.pem'))}\nprivate_key=${configValue(path('ca.key'))}\ndefault_md=sha256\npolicy=policy\nx509_extensions=ext\n[policy]\ncommonName=supplied\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n`,
  );
  await openssl([
    'ca',
    '-config',
    path('ca.cnf'),
    '-batch',
    '-startdate',
    '20200101000000Z',
    '-enddate',
    '20200102000000Z',
    '-in',
    path('server.csr'),
    '-out',
    path('expired.pem'),
  ]);
  await prepareTlsFiles(directory);
}
