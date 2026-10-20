import { describe, expect, it } from 'vitest';
import {
  GENERIC_MIN_CLASS_SWITCHES,
  GENERIC_MIN_ENTROPY,
  GENERIC_MAX_VOWEL_SHARE,
  GENERIC_MIN_LENGTH,
  classSwitchRatio,
  isHighEntropyToken,
  normaliseSecret,
  shannonEntropy,
  validateSecret,
  vowelShare,
} from '@/src/core/detect/validators/secret.ts';

/**
 * Vendor-format test tokens are assembled at run time from a documented
 * prefix and an obviously fake body, so the repository holds no literal
 * token that secret scanners would report. None is a real credential.
 */
const fake = (...parts: string[]): string => parts.join('');
const FAKE_BODY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';

const kindOf = (value: string) => {
  const result = validateSecret(value);
  return result.valid ? result.kind : null;
};

describe('validateSecret: known formats', () => {
  it("flags AWS's documented example access key IDs", () => {
    // From the AWS IAM documentation.
    expect(kindOf('AKIAIOSFODNN7EXAMPLE')).toBe('aws-access-key');
    expect(kindOf(fake('ASIA', 'IOSFODNN7EXAMPLE'))).toBe('aws-access-key');
    expect(kindOf('AKIAIOSFODNN7EXAMPL')).not.toBe('aws-access-key');
    expect(kindOf('akiaiosfodnn7example')).toBeNull();
  });

  it('flags GitHub tokens in the documented prefix and length format', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_']) {
      expect(kindOf(fake(prefix, FAKE_BODY.slice(0, 36)))).toBe('github-token');
    }
    expect(
      kindOf(fake('github_', 'pat_', FAKE_BODY, '_', FAKE_BODY, 'Ab')),
    ).toBe('github-token');
    expect(kindOf(fake('ghp_', FAKE_BODY.slice(0, 20)))).toBeNull();
  });

  it('flags Google API keys (AIza + 35 characters)', () => {
    expect(kindOf(fake('AI', 'za', FAKE_BODY.slice(0, 33), '_-'))).toBe(
      'google-api-key',
    );
    expect(kindOf(fake('AI', 'za', FAKE_BODY.slice(0, 20)))).toBeNull();
  });

  it('flags Slack tokens', () => {
    for (const kind of ['a', 'b', 'p', 'r', 's']) {
      expect(
        kindOf(fake('xox', kind, '-1234567890-', FAKE_BODY.slice(0, 24))),
      ).toBe('slack-token');
    }
    expect(kindOf(fake('xox', 'z-1234567890-abcdef'))).toBeNull();
  });

  it('flags sk- keys whose body mixes digits and both cases', () => {
    expect(kindOf(fake('sk', '-', FAKE_BODY))).toBe('openai');
    expect(kindOf(fake('sk', '-proj-', FAKE_BODY, '_', FAKE_BODY))).toBe(
      'openai',
    );
    expect(kindOf(fake('sk', '-ant-api03-', FAKE_BODY, '-', FAKE_BODY))).toBe(
      'openai',
    );
  });

  it('does not flag sk- followed by ordinary words', () => {
    expect(kindOf('sk-this-is-not-a-real-key-at-all')).toBeNull();
    expect(kindOf('sk-learn')).toBeNull();
    expect(kindOf('sk-learn-tutorial-chapter-2024')).toBeNull();
  });

  it('flags the jwt.io example token', () => {
    // Example token from jwt.io (HS256, payload {"sub":"1234567890","name":"John Doe","iat":1516239022}).
    const token = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    expect(kindOf(token)).toBe('jwt');
  });

  it('flags an unsecured JWT (empty signature)', () => {
    // {"alg":"none"} . {"sub":"1"} .
    expect(kindOf('eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.')).toBe('jwt');
  });

  it('does not take dotted names or non-JSON headers for JWTs', () => {
    expect(kindOf('com.example.app')).toBeNull();
    expect(kindOf('eyJub3QganNvbg.eyJzdWIiOiIxIn0.abc')).toBeNull();
    // A JSON header without "alg".
    expect(kindOf('eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxIn0.abc')).toBeNull();
    // A JSON array header.
    expect(kindOf('WzEsMl0.eyJzdWIiOiIxIn0.abc')).toBeNull();
    expect(kindOf('eyJhbGciOiJub25lIn0..abc')).toBeNull();
    expect(kindOf('eyJhbGciOiJub25lIn0.eyJ$.abc')).toBeNull();
  });

  it('flags PEM private key blocks of every documented label', () => {
    const body =
      '\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n';
    for (const label of [
      'PRIVATE KEY',
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'DSA PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
      'PGP PRIVATE KEY BLOCK',
    ]) {
      const block = fake(
        '-----BEGIN ',
        label,
        '-----',
        body,
        '-----END ',
        label,
        '-----',
      );
      expect(kindOf(block)).toBe('private-key');
      expect(kindOf(`  ${block}\n`)).toBe('private-key');
    }
  });

  it('does not flag public keys, certificates or mismatched PEM blocks', () => {
    const body = '\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf\n';
    expect(
      kindOf(`-----BEGIN PUBLIC KEY-----${body}-----END PUBLIC KEY-----`),
    ).toBeNull();
    expect(
      kindOf(`-----BEGIN CERTIFICATE-----${body}-----END CERTIFICATE-----`),
    ).toBeNull();
    expect(
      kindOf(
        fake(
          '-----BEGIN RSA PRIVATE KEY-----',
          body,
          '-----END EC PRIVATE KEY-----',
        ),
      ),
    ).toBeNull();
    expect(
      kindOf(
        fake('-----BEGIN PRIVATE KEY-----', '\n', '-----END PRIVATE KEY-----'),
      ),
    ).toBeNull();
  });
});

describe('validateSecret: generic high-entropy rule', () => {
  it('flags random-looking mixed tokens of 32+ characters', () => {
    expect(kindOf('Xq7Lp2Rv9KtB4mWz8NcY3sHd6FgJ1uAe')).toBe('high-entropy');
    expect(kindOf('n3Kd9_Qx-7VbLm2Rt8Yw4Zp1Hs6Jc0Ga5Ue')).toBe('high-entropy');
    expect(kindOf('q8F/2kLm+9Xc4Vb7Nz1Rt6Yw3Hs5Jd0GaPeU=')).toBe(
      'high-entropy',
    );
  });

  it("flags AWS's documented example secret access key", () => {
    // From the AWS IAM documentation; it has no prefix, so only the generic rule applies.
    expect(kindOf('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(
      'high-entropy',
    );
  });

  it('does not flag git commit hashes, SHA-256 hashes or UUIDs', () => {
    // Commit hash from the Git book; UUID from RFC 9562 examples.
    expect(kindOf('9fceb02d0ae598e95dc970b74767f19372d61af8')).toBeNull();
    expect(
      kindOf(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ),
    ).toBeNull();
    expect(kindOf('123e4567-e89b-12d3-a456-426614174000')).toBeNull();
    expect(kindOf('9FCEB02D0AE598E95DC970B74767F19372D61AF8')).toBeNull();
  });

  it('does not flag plain long words or identifiers', () => {
    for (const word of [
      'pneumonoultramicroscopicsilicovolcanoconiosis',
      'Supercalifragilisticexpialidocious2024',
      'ThisIsAVeryLongCamelCaseIdentifier42',
      'getUserProfileSettingsHandlerForAccount2',
      'my-blog-post-2024-about-things-and-stuff',
      'usr/local/bin/python3/site-packages/numpy',
      'ORDER_PAYMENT_INVOICE_CUSTOMER_PRODUCT_2024',
      'S3BucketNameForProjectBackup2024v2',
      'HTTPRequestHandlerV2ForOAuth2Tokens',
      'AuthenticationServiceProvider2FA',
      'abcdefghijklmnopqrstuvwxyz0123456789',
    ]) {
      expect(kindOf(word)).toBeNull();
    }
  });

  it('does not flag base64 of ordinary text', () => {
    const texts = [
      'Please send the quarterly report to the finance team before Friday.',
      'Meeting notes: discuss the roadmap, hiring plan and budget for next year.',
      '{"name":"Dana","role":"admin","created":"2024-01-01T00:00:00Z"}',
    ];
    for (const text of texts) {
      const encoded = btoa(text);
      expect(kindOf(encoded)).toBeNull();
      expect(kindOf(encoded.slice(0, 32))).toBeNull();
      expect(
        kindOf(encoded.replace(/\+/g, '-').replace(/\//g, '_')),
      ).toBeNull();
    }
  });

  it('does not flag base64 of UTF-8 text', () => {
    const bytes = new TextEncoder().encode(
      'Grüße aus München! Das Wetter ist schön heute.',
    );
    const encoded = btoa(String.fromCharCode(...bytes));
    expect(kindOf(encoded)).toBeNull();
  });

  it('does not flag hex colour codes or short tokens', () => {
    expect(kindOf('#ff00aa')).toBeNull();
    expect(kindOf('ff00aa')).toBeNull();
    expect(kindOf('Xq7Lp2Rv9KtB4mWz8NcY3sHd6FgJ1uA')).toBeNull();
  });

  it('requires digits and both cases', () => {
    expect(isHighEntropyToken('XqLpRvKtBmWzNcYsHdFgJuAeQoPiUyTr')).toBe(false);
    expect(isHighEntropyToken('xq7lp2rv9ktb4mwz8ncy3shd6fgj1uae')).toBe(false);
    expect(isHighEntropyToken('XQ7LP2RV9KTB4MWZ8NCY3SHD6FGJ1UAE')).toBe(false);
  });

  it('documents the chosen thresholds', () => {
    expect(GENERIC_MIN_LENGTH).toBe(32);
    expect(GENERIC_MIN_ENTROPY).toBe(4);
    expect(GENERIC_MIN_CLASS_SWITCHES).toBe(0.3);
    expect(GENERIC_MAX_VOWEL_SHARE).toBe(0.3);
  });
});

describe('validateSecret: input bounds', () => {
  it('rejects empty and over-long input', () => {
    expect(validateSecret('')).toEqual({ valid: false });
    expect(validateSecret('Xq7Lp2Rv9KtB4mWz'.repeat(600)).valid).toBe(false);
  });

  it('stays fast on adversarial input', () => {
    const inputs = [
      'a.'.repeat(4000),
      `-----BEGIN PRIVATE KEY-----${'A'.repeat(8000)}`,
      `eyJ${'A'.repeat(4000)}.${'B'.repeat(4000)}.c`,
      `sk-${'a-'.repeat(4000)}`,
      'Xq7Lp2Rv9KtB4mWz'.repeat(500),
      `xoxb-${'1-'.repeat(4000)}`,
    ];
    const started = performance.now();
    for (const input of inputs) validateSecret(input);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('shannonEntropy', () => {
  it('measures bits per character', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBe(1);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(shannonEntropy('aabb')).toBe(1);
  });

  it('counts astral characters once', () => {
    expect(shannonEntropy('😀😀')).toBe(0);
  });
});

describe('classSwitchRatio', () => {
  it('measures class changes between neighbours', () => {
    expect(classSwitchRatio('')).toBe(0);
    expect(classSwitchRatio('a')).toBe(0);
    expect(classSwitchRatio('aaaa')).toBe(0);
    expect(classSwitchRatio('aA1-')).toBe(1);
    expect(classSwitchRatio('abAB')).toBeCloseTo(1 / 3);
  });
});

describe('vowelShare', () => {
  it('measures vowels among ASCII letters only', () => {
    expect(vowelShare('')).toBe(0);
    expect(vowelShare('1234')).toBe(0);
    expect(vowelShare('aEiO')).toBe(1);
    expect(vowelShare('Xq7L')).toBe(0);
    expect(vowelShare('Token42')).toBeCloseTo(2 / 5);
  });
});

describe('normaliseSecret', () => {
  it('keeps the value exactly as written', () => {
    expect(normaliseSecret(' Ab1/ ')).toBe(' Ab1/ ');
  });
});
