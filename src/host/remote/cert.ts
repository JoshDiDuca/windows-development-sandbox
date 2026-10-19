// The LAN listener's certificate: self-signed, EC P-256, 397 days (the most phones accept), for this PC's private
// addresses (subject alternative names, IP entries) and its name, server authentication only and not a CA (a CA key on
// this PC that a phone trusted could vouch for any site). Node 22 has no certificate builder, so this writes the X.509
// DER itself (a few fixed structures) and node:crypto makes the key and signs. The self-test parses the result with
// crypto.X509Certificate and serves HTTPS with it.
import crypto from 'node:crypto';
import net from 'node:net';

/** Phones (Apple's rule) refuse certificates valid longer than this. */
export const CERT_DAYS = 397;
const DAY_MS = 86_400_000;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER element: tag, length, content. */
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 + n, inner);

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** A positive INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.subarray(1);
  return tlv(0x02, b[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

/** UTCTime (YYMMDDHHMMSSZ), what certificates use before 2050. */
function utcTime(ms: number): Buffer {
  const iso = new Date(ms).toISOString();
  const text = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + 'Z';
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function name(commonName: string): Buffer {
  return seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octets(value));
}

/** The subject alternative names: IP entries for the addresses, a DNS entry for the PC's name. */
function altNames(addresses: readonly string[], dnsNames: readonly string[]): Buffer {
  const entries = [
    ...addresses.filter((a) => net.isIPv4(a)).map((a) => tlv(0x87, Buffer.from(a.split('.').map(Number)))),
    ...dnsNames.filter((d) => /^[A-Za-z0-9-]{1,63}$/.test(d)).map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
  ];
  return seq(...entries);
}

export interface MadeCertificate {
  /** PEM certificate and PKCS#8 PEM private key. */
  readonly cert: string;
  readonly key: string;
  /** SHA-256 of the certificate, AA:BB:... (what browsers show). */
  readonly fingerprint: string;
  readonly notAfter: string;
}

export interface CertificateRequest {
  readonly addresses: readonly string[];
  readonly dnsNames?: readonly string[];
  readonly now?: number;
  readonly days?: number;
}

/** A new key and its self-signed certificate. */
export function makeCertificate(r: CertificateRequest): MadeCertificate {
  if (!r.addresses.length || !r.addresses.every((a) => net.isIPv4(a)))
    throw new Error('A certificate needs at least one IPv4 address.');
  const now = r.now ?? Date.now();
  const days = r.days ?? CERT_DAYS;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const algorithm = seq(oid('1.2.840.10045.4.3.2'));
  const subject = name('Agent Sandbox web UI');
  const notBefore = now - 60 * 60_000;
  const notAfter = now + days * DAY_MS;
  const extensions = seq(
    extension('2.5.29.19', true, seq()),
    extension('2.5.29.15', true, bits(Buffer.from([0x80]))),
    extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
    extension('2.5.29.17', false, altNames(r.addresses, r.dnsNames ?? [])),
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    subject,
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    explicit(3, extensions),
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, algorithm, bits(signature));
  const cert = '-----BEGIN CERTIFICATE-----\n' + (der.toString('base64').match(/.{1,64}/g) ?? []).join('\n') + '\n-----END CERTIFICATE-----\n';
  return {
    cert,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: fingerprintOf(der),
    notAfter: new Date(notAfter).toISOString(),
  };
}

/** SHA-256 of DER bytes as AA:BB:... */
export function fingerprintOf(der: Buffer): string {
  return (
    crypto
      .createHash('sha256')
      .update(der)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g) ?? []
  ).join(':');
}
