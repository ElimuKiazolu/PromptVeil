/**
 * A throwaway self-signed certificate for the local chatgpt.com copy,
 * created in memory for each run (ECDSA P-256, valid for one day), so no key
 * is kept on disk or in the repository. Chrome runs with
 * --ignore-certificate-errors, but the certificate is still a well-formed
 * X.509 v3 certificate with the mapped host names, checked by Node before use.
 */
import {
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';

/** DER length octets. */
function length(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: Uint8Array | readonly number[]): Buffer {
  const body = Buffer.from(content);
  return Buffer.concat([Buffer.from([tag, ...length(body.length)]), body]);
}

const sequence = (...items: Buffer[]): Buffer =>
  tlv(0x30, Buffer.concat(items));

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk: number[] = [];
    for (let value = part; ; value = Math.floor(value / 128)) {
      chunk.unshift((value % 128) | (chunk.length === 0 ? 0 : 0x80));
      if (value < 128) break;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, bytes);
}

/** UTCTime YYMMDDHHMMSSZ. */
function utcTime(date: Date): Buffer {
  const text = date
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(2, 14)
    .concat('Z');
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function name(commonName: string): Buffer {
  return sequence(
    tlv(
      0x31,
      sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8'))),
    ),
  );
}

export interface Certificate {
  readonly key: string;
  readonly cert: string;
}

export function selfSignedCertificate(hosts: readonly string[]): Certificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const ecdsaWithSha256 = sequence(oid('1.2.840.10045.4.3.2'));
  const now = Date.now();
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f; // positive INTEGER
  const altNames = sequence(
    ...hosts.map((host) => tlv(0x82, Buffer.from(host, 'ascii'))),
  );
  const extensions = tlv(
    0xa3,
    sequence(sequence(oid('2.5.29.17'), tlv(0x04, altNames))),
  );
  const subject = name('PromptVeil e2e');
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, [2])),
    tlv(0x02, serial),
    ecdsaWithSha256,
    subject,
    sequence(
      utcTime(new Date(now - 60_000)),
      utcTime(new Date(now + 86_400_000)),
    ),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbs, {
    key: privateKey,
    dsaEncoding: 'der',
  });
  const der = sequence(
    tbs,
    ecdsaWithSha256,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const body = der.toString('base64').replace(/.{64}/g, '$&\n');
  const cert = `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
  // Throws if the encoding is wrong.
  const parsed = new X509Certificate(cert);
  if (!parsed.verify(publicKey)) throw new Error('certificate does not verify');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert,
  };
}
