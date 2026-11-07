import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { verifyServerIdentity } from '../src/adapters/tls.js';
import { certificates } from './fixtures/tls-identities.js';

test('TLS IP identity uses exact SAN bytes across IPv4 and equivalent IPv6 representations', () => {
  const cert = new X509Certificate(certificates.addresses).toLegacyObject();
  for (const host of ['127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])
    assert.equal(verifyServerIdentity(host, cert), undefined, host);
  assert.equal(verifyServerIdentity('localhost', cert), undefined);
  for (const host of ['127.0.0.2', '::2', '::ffff:127.0.0.1', 'wrong.invalid'])
    assert.equal(
      (verifyServerIdentity(host, cert) as NodeJS.ErrnoException)?.code,
      'ERR_TLS_CERT_ALTNAME_INVALID',
      host,
    );
});

test('IP identity never accepts a common name, textual SAN substitute or malformed certificate', () => {
  const cnOnly = new X509Certificate(certificates.cnOnly).toLegacyObject();
  const mismatched = { ...cnOnly, subjectaltname: 'IP Address:127.0.0.1' };
  const invalid = { ...cnOnly, raw: Buffer.from('invalid certificate') };
  for (const cert of [cnOnly, mismatched, invalid])
    assert.equal(
      (verifyServerIdentity('127.0.0.1', cert) as NodeJS.ErrnoException)?.code,
      'ERR_TLS_CERT_ALTNAME_INVALID',
    );
});
