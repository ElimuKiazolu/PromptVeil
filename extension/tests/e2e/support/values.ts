/**
 * Test values for the browser checks: published examples (with their
 * sources) and values generated in memory from fixed labels, never written
 * to the repository. Every value a check uses goes through `use`, so the
 * final audit can look for it in every request and log line.
 */
import { createHash } from 'node:crypto';
import { base58 } from '@scure/base';

const used = new Set<string>();

/** Registers a real value for the audit and returns it. */
export function real(value: string): string {
  used.add(value);
  return value;
}

/** Every real value used so far. */
export function usedValues(): readonly string[] {
  return [...used];
}

/** Letters and digits of any script, lower case (the request net's form). */
export function compact(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export const PUBLISHED = {
  /** Fixture identity (GB), example.org is reserved (RFC 2606). */
  email: 'harriet.pemberton@example.org',
  /** libphonenumber's UK mobile example number. */
  phone: '07400 123456',
  /** Fixture validExample (GB); AB is an allocatable prefix. */
  nino: 'AB 12 34 56 C',
  /** Fixture validExample (BR), checksum-valid published example. */
  cpf: '390.533.447-05',
  /** Braintree's published Visa test number (detected; not a stand-in). */
  card: '4111 1111 1111 1111',
  /** The IBAN registry's GB example. */
  iban: 'GB29 NWBK 6016 1331 9268 19',
  /** BIP-173/350 test vector (P2WPKH). */
  segwit: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  /** EIP-55 test case. */
  ethereum: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
} as const;

/** AWS access key ID shape with a made-up body, built from parts. */
export const AWS_STYLE_KEY = ['AKIA', 'Q7ZXMB2T', 'LP9WE4RJ'].join('');

const sha256 = (label: string): Buffer =>
  createHash('sha256').update(label).digest();

/** Deterministic digits for a label (in memory only). */
function digits(label: string, count: number): string {
  let out = '';
  for (let k = 0; out.length < count; k += 1) {
    for (const byte of sha256(`${label} ${k.toString()}`)) {
      if (byte < 250) out += (byte % 10).toString();
      if (out.length === count) break;
    }
  }
  return out;
}

const pick = <T>(items: readonly T[], label: string): T => {
  const item = items[(sha256(label)[0] ?? 0) % items.length];
  if (item === undefined) throw new Error('empty list');
  return item;
};

const GIVEN = ['amelia', 'oliver', 'priya', 'tomas', 'grace', 'kofi', 'lena'];
const FAMILY = ['ashworth', 'brennan', 'castell', 'dunmore', 'everard'];

export const generated = {
  email(label: string): string {
    return `${pick(GIVEN, `g ${label}`)}.${pick(FAMILY, `f ${label}`)}${digits(label, 3)}@example.org`;
  },
  /** A UK mobile number in the 07400 range (valid, not a fiction range). */
  ukMobile(label: string): string {
    return `07400 ${digits(`m ${label}`, 6)}`;
  },
  /** A NINO with an allocatable prefix. */
  nino(label: string): string {
    const prefix = pick(['AB', 'CE', 'JK', 'PR', 'WL'], `n ${label}`);
    const d = digits(`n ${label}`, 6);
    const suffix = pick(['A', 'B', 'C', 'D'], `ns ${label}`);
    return `${prefix} ${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)} ${suffix}`;
  },
  /** A CPF with valid check digits (not all digits equal). */
  cpf(label: string): string {
    for (let k = 0; ; k += 1) {
      const base = digits(`c ${label} ${k.toString()}`, 9);
      if (/^(\d)\1+$/.test(base)) continue;
      const check = (part: string): string => {
        let sum = 0;
        for (let i = 0; i < part.length; i += 1) {
          sum += Number(part[i]) * (part.length + 1 - i);
        }
        const r = (sum * 10) % 11;
        return (r === 10 ? 0 : r).toString();
      };
      const first = check(base);
      const full = base + first + check(base + first);
      return `${full.slice(0, 3)}.${full.slice(3, 6)}.${full.slice(6, 9)}-${full.slice(9)}`;
    }
  },
  /** A GB IBAN with a made-up bank code and valid mod-97 check digits. */
  iban(label: string): string {
    const bban = `PVEU${digits(`i ${label}`, 14)}`;
    const numeric = (bban + 'GB00').replace(/[A-Z]/g, (c) =>
      (c.charCodeAt(0) - 55).toString(),
    );
    let rest = 0;
    for (const c of numeric) rest = (rest * 10 + Number(c)) % 97;
    const check = (98 - rest).toString().padStart(2, '0');
    const iban = `GB${check}${bban}`;
    return iban.replace(/(.{4})/g, '$1 ').trim();
  },
  /** A US SSN with an issuable area, group and serial. */
  ssn(label: string): string {
    const d = digits(`s ${label}`, 9);
    const area = (100 + (Number(d.slice(0, 3)) % 565)).toString();
    const group = (1 + (Number(d.slice(3, 5)) % 99))
      .toString()
      .padStart(2, '0');
    const serial = (1 + (Number(d.slice(5)) % 9999))
      .toString()
      .padStart(4, '0');
    return `${area}-${group}-${serial}`;
  },
  /** A public IPv4 address (no local, reserved or documentation range). */
  publicIpv4(label: string): string {
    for (let k = 0; ; k += 1) {
      const [a = 0, b = 0, c = 0, d = 0] = sha256(
        `ip ${label} ${k.toString()}`,
      );
      const local =
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b < 128) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b < 32) ||
        (a === 192 && (b === 0 || b === 168)) ||
        (a === 198 && (b === 18 || b === 19 || b === 51)) ||
        (a === 203 && b === 0);
      if (!local && d > 0)
        return `${a.toString()}.${b.toString()}.${c.toString()}.${d.toString()}`;
    }
  },
  /** A Base58Check P2PKH Bitcoin address with a made-up payload. */
  bitcoin(label: string): string {
    const payload = Buffer.concat([
      Buffer.from([0]),
      sha256(`btc ${label}`).subarray(0, 20),
    ]);
    const checksum = createHash('sha256')
      .update(createHash('sha256').update(payload).digest())
      .digest()
      .subarray(0, 4);
    return base58.encode(Buffer.concat([payload, checksum]));
  },
};
