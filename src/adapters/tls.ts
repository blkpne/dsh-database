import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

/** Identity only: the TLS socket must still enforce the complete certificate chain. */
export function verifyServerIdentity(host: string, cert: PeerCertificate): Error | undefined {
  if (!isIP(host)) return checkServerIdentity(host, cert);
  // Some supported Node patches send IPv6 through IDNA/DNS matching. Use the DER
  // certificate's exact IP SAN bytes instead; IPs never fall back to a DNS SAN or CN.
  try {
    if (new X509Certificate(cert.raw).checkIP(host)) return undefined;
  } catch {
    // A missing or malformed certificate must also fail closed.
  }
  return Object.assign(new Error('TLS certificate does not match the configured IP address.'), {
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
  });
}
