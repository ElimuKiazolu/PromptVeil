import { describe, expect, it } from 'vitest';
import {
  decryptValue,
  encryptValue,
  randomDateOffsetDays,
  realHash,
  seedFor,
  type RecordBinding,
} from '@/src/core/vault/crypto.ts';
import { encodeFields, toBase64 } from '@/src/core/vault/encoding.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import { normaliseReal, normaliseStandIn } from '@/src/core/vault/normalise.ts';
import { webCrypto } from './harness.ts';

async function aesKey(): Promise<CryptoKey> {
  return webCrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function hmacKey(): Promise<CryptoKey> {
  return webCrypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

const BINDING: RecordBinding = {
  store: 'mappings',
  recordId: 'record-1',
  conversationId: 'chatgpt:conv-1',
  type: 'EMAIL',
  subtype: null,
};

async function expectDecryptFailed(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof VaultError && error.code === 'decrypt-failed',
  );
}

describe('field encoding', () => {
  it('never encodes two different field lists to the same bytes', () => {
    const lists: (string | null)[][] = [
      ['AB', 'C'],
      ['A', 'BC'],
      ['ABC'],
      ['', 'ABC'],
      ['ABC', ''],
      [null, 'ABC'],
      ['', 'ABC', null],
      ['ABC', null],
      [null],
      [''],
      [],
    ];
    const encoded = lists.map((list) => toBase64(encodeFields(list)));
    expect(new Set(encoded).size).toBe(lists.length);
  });

  it('writes tag, big-endian length and UTF-8 bytes', () => {
    expect([...encodeFields(['é', null])]).toEqual([
      1, 0, 0, 0, 2, 0xc3, 0xa9, 0,
    ]);
  });

  it('encodes base64 with padding', () => {
    expect(toBase64(new Uint8Array([0xff, 0x00]))).toBe('/wA=');
  });
});

describe('AES-GCM with record binding', () => {
  it('round-trips a value', async () => {
    const key = await aesKey();
    const encrypted = await encryptValue(
      webCrypto,
      key,
      'dana.whitfield@example.com',
      BINDING,
    );
    expect(encrypted.iv).toHaveLength(12);
    expect(await decryptValue(webCrypto, key, encrypted, BINDING)).toBe(
      'dana.whitfield@example.com',
    );
  });

  it('uses a fresh IV for every encryption', async () => {
    const key = await aesKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      const { iv } = await encryptValue(webCrypto, key, 'same value', BINDING);
      ivs.add(toBase64(iv));
    }
    expect(ivs.size).toBe(2_000);
  });

  it('rejects a tampered ciphertext, IV or record binding', async () => {
    const key = await aesKey();
    const encrypted = await encryptValue(
      webCrypto,
      key,
      'secret value',
      BINDING,
    );

    const ct = new Uint8Array(encrypted.ct.slice(0));
    ct[0] = (ct[0] ?? 0) ^ 1;
    await expectDecryptFailed(
      decryptValue(
        webCrypto,
        key,
        { iv: encrypted.iv, ct: ct.buffer },
        BINDING,
      ),
    );

    const iv = encrypted.iv.slice();
    iv[0] = (iv[0] ?? 0) ^ 1;
    await expectDecryptFailed(
      decryptValue(webCrypto, key, { iv, ct: encrypted.ct }, BINDING),
    );

    await expectDecryptFailed(
      decryptValue(
        webCrypto,
        key,
        { iv: encrypted.iv.slice(0, 8), ct: encrypted.ct },
        BINDING,
      ),
    );

    const otherBindings: RecordBinding[] = [
      { ...BINDING, store: 'customTerms' },
      { ...BINDING, recordId: 'record-2' },
      { ...BINDING, conversationId: 'chatgpt:conv-2' },
      { ...BINDING, conversationId: null },
      { ...BINDING, type: 'PHONE' },
      { ...BINDING, subtype: 'IBAN' },
    ];
    for (const binding of otherBindings) {
      await expectDecryptFailed(
        decryptValue(webCrypto, key, encrypted, binding),
      );
    }
  });

  it('rejects a ciphertext under another key', async () => {
    const encrypted = await encryptValue(
      webCrypto,
      await aesKey(),
      'x',
      BINDING,
    );
    await expectDecryptFailed(
      decryptValue(webCrypto, await aesKey(), encrypted, BINDING),
    );
  });
});

describe('realHash', () => {
  const input = {
    conversationId: 'chatgpt:conv-1',
    type: 'NATIONAL_ID' as const,
    subtype: 'UK_NINO' as const,
    normalised: 'QQ123456C',
  };

  it('is stable for one key and input, and base64 of 32 bytes', async () => {
    const key = await hmacKey();
    const first = await realHash(webCrypto, key, input);
    expect(await realHash(webCrypto, key, { ...input })).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
  });

  it('differs per conversation, type, subtype, value and key', async () => {
    const key = await hmacKey();
    const hashes = await Promise.all([
      realHash(webCrypto, key, input),
      realHash(webCrypto, key, { ...input, conversationId: 'chatgpt:conv-2' }),
      realHash(webCrypto, key, { ...input, type: 'PASSPORT' }),
      realHash(webCrypto, key, { ...input, subtype: 'IN_PAN' }),
      realHash(webCrypto, key, { ...input, subtype: null }),
      realHash(webCrypto, key, { ...input, normalised: 'QQ123456D' }),
      realHash(webCrypto, await hmacKey(), input),
    ]);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('maps separator and case variants of one value to one hash', async () => {
    const key = await hmacKey();
    const forms = ['QQ 12 34 56 C', 'qq123456c', 'QQ-12-34-56-C'];
    const hashes = await Promise.all(
      forms.map((form) =>
        realHash(webCrypto, key, {
          ...input,
          normalised: normaliseReal('NATIONAL_ID', 'UK_NINO', 'GB', form),
        }),
      ),
    );
    expect(new Set(hashes).size).toBe(1);
  });
});

describe('seedFor', () => {
  it('gives 32 stable bytes, separated by conversation, type and value', async () => {
    const key = await hmacKey();
    const input = {
      conversationId: 'chatgpt:conv-1',
      type: 'EMAIL' as const,
      normalised: 'dana.whitfield@example.com',
    };
    const seed = await seedFor(webCrypto, key, input);
    expect(seed).toHaveLength(32);
    expect(await seedFor(webCrypto, key, input)).toEqual(seed);
    const others = await Promise.all([
      seedFor(webCrypto, key, { ...input, conversationId: 'chatgpt:conv-2' }),
      seedFor(webCrypto, key, { ...input, type: 'PERSON' }),
      seedFor(webCrypto, key, { ...input, normalised: 'other@example.com' }),
    ]);
    for (const other of others) expect(other).not.toEqual(seed);
  });
});

/** getRandomValues returning the given 32-bit draws in order. */
function scripted(draws: readonly number[]): Pick<Crypto, 'getRandomValues'> {
  let next = 0;
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array instanceof Uint32Array) {
        const draw = draws[next];
        if (draw === undefined) throw new Error('no scripted draw left');
        next += 1;
        array[0] = draw;
      }
      return array;
    },
  };
}

describe('randomDateOffsetDays', () => {
  const VALUES = 672;
  const LIMIT = Math.floor(2 ** 32 / VALUES) * VALUES;

  it('maps draws to −365…−30 and 30…365 at the edges', () => {
    expect(randomDateOffsetDays(scripted([0]))).toBe(-30);
    expect(randomDateOffsetDays(scripted([335]))).toBe(-365);
    expect(randomDateOffsetDays(scripted([336]))).toBe(30);
    expect(randomDateOffsetDays(scripted([671]))).toBe(365);
    expect(randomDateOffsetDays(scripted([672]))).toBe(-30);
    expect(randomDateOffsetDays(scripted([LIMIT - 1]))).toBe(365);
  });

  it('rejects draws at or above the last full multiple (no modulo bias)', () => {
    expect(randomDateOffsetDays(scripted([LIMIT, 2 ** 32 - 1, 336]))).toBe(30);
  });

  it('stays in range, never 0, and reaches both signs and both ends', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40_000; i += 1)
      seen.add(randomDateOffsetDays(webCrypto));
    const outOfRange = [...seen].filter(
      (offset) =>
        !Number.isInteger(offset) ||
        Math.abs(offset) < 30 ||
        Math.abs(offset) > 365,
    );
    expect(outOfRange).toEqual([]);
    // 40,000 draws over 672 values: every value appears with near certainty
    // (each is missed with probability ≈ e^-59).
    expect(seen.size).toBe(VALUES);
  });
});

describe('normal forms', () => {
  it('normalises each type as the schema specifies', () => {
    // GB phone: libphonenumber's own GB mobile example number.
    expect(
      normaliseReal('EMAIL', null, null, '  Dana.Whitfield@Example.COM '),
    ).toBe('dana.whitfield@example.com');
    expect(normaliseReal('PHONE', null, 'GB', '07400 123456')).toBe(
      '+447400123456',
    );
    expect(normaliseReal('PHONE', null, null, '+44 7400 123456')).toBe(
      '+447400123456',
    );
    expect(normaliseReal('CARD', null, null, '4242-4242 4242.4242')).toBe(
      '4242424242424242',
    );
    expect(
      normaliseReal('BANK', 'IBAN', 'GB', 'gb82 west 1234 5698 7654 32'),
    ).toBe('GB82WEST12345698765432');
    expect(normaliseReal('BANK', 'IN_UPI', 'IN', ' Name@Bank ')).toBe(
      'name@bank',
    );
    expect(normaliseReal('BANK', 'SWIFT_BIC', null, 'deut de ff')).toBe(
      'DEUTDEFF',
    );
    expect(normaliseReal('NATIONAL_ID', 'BR_CPF', 'BR', '111.444.777-35')).toBe(
      '11144477735',
    );
    expect(
      normaliseReal('NATIONAL_ID', 'CN_RIC', 'CN', '11010519491231002x'),
    ).toBe('11010519491231002X');
    expect(normaliseReal('PASSPORT', null, null, 'ab 123-456')).toBe(
      'AB123456',
    );
    expect(normaliseReal('POSTCODE', null, 'GB', 'sw1a 1aa')).toBe('SW1A1AA');
    expect(normaliseReal('SECRET', null, null, 'AbC-123')).toBe('AbC-123');
    expect(normaliseReal('CRYPTO', null, null, ' 1AbC ')).toBe(' 1AbC ');
    expect(normaliseReal('DATE', null, null, ' 1 May 2020 ')).toBe(
      '1 May 2020',
    );
  });

  it('collapses spaces, lower-cases and strips leading titles from names', () => {
    expect(
      normaliseReal('PERSON', null, null, '  Dr.  Dana   Whitfield '),
    ).toBe('dana whitfield');
    expect(
      normaliseReal('PERSON', null, null, 'Prof. Dr. Dana Whitfield'),
    ).toBe('dana whitfield');
    expect(normaliseReal('PERSON', null, null, 'Mme Dana Whitfield')).toBe(
      'dana whitfield',
    );
    expect(normaliseReal('PERSON', null, null, 'M. Dana Whitfield')).toBe(
      'dana whitfield',
    );
    // A bare initial is not a title; a lone title is kept rather than emptied.
    expect(normaliseReal('PERSON', null, null, 'M Dana')).toBe('m dana');
    expect(normaliseReal('PERSON', null, null, 'Dr')).toBe('dr');
    // NFC: a decomposed é equals the composed one.
    const decomposed = `Cafe${String.fromCodePoint(0x301)} Ltd`;
    const composed = `Caf${String.fromCodePoint(0xe9)} Ltd`;
    expect(normaliseReal('ORG', null, null, decomposed)).toBe(
      normaliseReal('ORG', null, null, composed),
    );
  });

  it('normalises stand-ins by case and separators', () => {
    expect(normaliseStandIn('+1 (212) 555-0142')).toBe('+12125550142');
    expect(normaliseStandIn('Jane.Doe@Example.com')).toBe('janedoe@examplecom');
  });
});
