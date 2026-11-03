import { describe, expect, it } from 'vitest';
import {
  decryptReal,
  encryptReal,
  randomDateOffsetDays,
  realHash,
  seedFor,
  type RecordBinding,
} from '@/src/core/vault/crypto.ts';
import {
  decodeFields,
  encodeFields,
  toBase64,
} from '@/src/core/vault/encoding.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { normaliseStandIn } from '@/src/core/vault/normalise.ts';
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

/** Fixture identity address with its normal form. */
const REAL = {
  value: 'Dana.Whitfield@example.com',
  normalised: 'dana.whitfield@example.com',
};

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

  it('decodes exactly what it encoded', () => {
    for (const list of [['AB', 'C'], [null, ''], [], ['é', null, 'x']]) {
      expect(decodeFields(encodeFields(list))).toEqual(list);
    }
  });

  it('refuses malformed bytes', () => {
    const valid = encodeFields(['abc']);
    for (const bytes of [
      valid.subarray(0, 4),
      valid.subarray(0, valid.length - 1),
      new Uint8Array([...valid, 7]),
      new Uint8Array([2]),
      new Uint8Array([1, 0, 0, 0, 1, 0xff]),
    ]) {
      expect(decodeFields(bytes)).toBeNull();
    }
  });

  it('encodes base64 with padding', () => {
    expect(toBase64(new Uint8Array([0xff, 0x00]))).toBe('/wA=');
  });
});

describe('AES-GCM with record binding', () => {
  it('round-trips a value with its normal form', async () => {
    const key = await aesKey();
    const encrypted = await encryptReal(webCrypto, key, REAL, BINDING);
    expect(encrypted.iv).toHaveLength(12);
    expect(await decryptReal(webCrypto, key, encrypted, BINDING)).toEqual(REAL);
  });

  it('refuses a plaintext that is not a sealed value', async () => {
    const key = await aesKey();
    const iv = webCrypto.getRandomValues(new Uint8Array(12));
    const seal = async (plain: Uint8Array<ArrayBuffer>) => ({
      iv,
      ct: await webCrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: encodeFields([
            'pv-aad/1',
            BINDING.store,
            BINDING.recordId,
            BINDING.conversationId,
            BINDING.type,
            BINDING.subtype,
          ]),
        },
        key,
        plain,
      ),
    });
    // The control case decrypts, so the others fail for their payload only.
    expect(
      await decryptReal(
        webCrypto,
        key,
        await seal(encodeFields(['pv-real/1', 'a', 'b'])),
        BINDING,
      ),
    ).toEqual({ value: 'a', normalised: 'b' });
    for (const plain of [
      new TextEncoder().encode('just text'),
      encodeFields(['pv-real/2', 'a', 'b']),
      encodeFields(['pv-real/1', 'a']),
      encodeFields(['pv-real/1', 'a', null]),
      encodeFields(['pv-real/1', 'a', 'b', 'c']),
    ]) {
      await expectDecryptFailed(
        decryptReal(webCrypto, key, await seal(plain), BINDING),
      );
    }
  });

  it('uses a fresh IV for every encryption', async () => {
    const key = await aesKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      const { iv } = await encryptReal(webCrypto, key, REAL, BINDING);
      ivs.add(toBase64(iv));
    }
    expect(ivs.size).toBe(2_000);
  });

  it('rejects a tampered ciphertext, IV or record binding', async () => {
    const key = await aesKey();
    const encrypted = await encryptReal(webCrypto, key, REAL, BINDING);

    const ct = new Uint8Array(encrypted.ct.slice(0));
    ct[0] = (ct[0] ?? 0) ^ 1;
    await expectDecryptFailed(
      decryptReal(webCrypto, key, { iv: encrypted.iv, ct: ct.buffer }, BINDING),
    );

    const iv = encrypted.iv.slice();
    iv[0] = (iv[0] ?? 0) ^ 1;
    await expectDecryptFailed(
      decryptReal(webCrypto, key, { iv, ct: encrypted.ct }, BINDING),
    );

    await expectDecryptFailed(
      decryptReal(
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
        decryptReal(webCrypto, key, encrypted, binding),
      );
    }
  });

  it('rejects a ciphertext under another key', async () => {
    const encrypted = await encryptReal(
      webCrypto,
      await aesKey(),
      REAL,
      BINDING,
    );
    await expectDecryptFailed(
      decryptReal(webCrypto, await aesKey(), encrypted, BINDING),
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

describe('stand-in normal form', () => {
  it('normalises stand-ins by case and separators', () => {
    expect(normaliseStandIn('+1 (212) 555-0142')).toBe('+12125550142');
    expect(normaliseStandIn('Jane.Doe@Example.com')).toBe('janedoe@examplecom');
  });
});
