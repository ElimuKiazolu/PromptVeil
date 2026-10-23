import { describe, expect, it } from 'vitest';
import {
  SECRET_ASSIGNMENT_RULE,
  SECRET_BASIC_RULE,
  SECRET_BEARER_RULE,
  SECRET_PEM_RULE,
  SECRET_TOKEN_RULE,
  SECRET_USERINFO_RULE,
  findTokens,
  isPlaceholder,
  isPlaceholderOrCode,
  isSecretKeyName,
} from '@/src/core/detect/rules/secret.ts';
import { blockingCheckpoint } from '@/src/core/detect/schedule.ts';
import type { Rule } from '@/src/core/detect/rules/types.ts';
import { SECRET_TOKENS } from './secret-tokens.ts';

const spans = (rule: Pick<Rule, 'find'>, text: string): string[] =>
  [...rule.find(text)].map(({ start, end }) => text.slice(start, end));

const env = (hasContext = false) => ({
  homeRegions: [],
  preferredRegions: [],
  hasContext,
  checkpoint: blockingCheckpoint(),
});

const status = (rule: Rule, value: string, hasContext = false): string => {
  const verdict = rule.validate(value, env(hasContext));
  if (verdict instanceof Promise) throw new Error('unexpected async verdict');
  if (!verdict.valid) return 'invalid';
  return verdict.possible ? 'possible' : verdict.strength;
};

const GITHUB = SECRET_TOKENS.GITHUB_TOKEN ?? '';

describe('findTokens', () => {
  it('splits on "=" between key and value but keeps base64 padding', () => {
    expect(spans({ find: findTokens }, `GITHUB_TOKEN=${GITHUB}`)).toEqual([
      GITHUB,
    ]);
    expect(spans({ find: findTokens }, 'basic dXNlcjpwYXNzd29yZA== x')).toEqual(
      ['dXNlcjpwYXNzd29yZA=='],
    );
  });

  it('drops a trailing full stop and short runs', () => {
    expect(spans({ find: findTokens }, `Use ${GITHUB}.`)).toEqual([GITHUB]);
    expect(spans({ find: findTokens }, 'short words only here')).toEqual([]);
  });
});

describe('SECRET_TOKEN_RULE', () => {
  it('confirms vendor formats with checksum strength', () => {
    expect(status(SECRET_TOKEN_RULE, GITHUB)).toBe('checksum');
  });

  it('confirms a random key by the generic rule, and a shorter one only near a context word', () => {
    expect(status(SECRET_TOKEN_RULE, 'Xq7Lp2Rv9KtB4mWz8NcY3sHd6FgJ1uAe')).toBe(
      'structural',
    );
    const short = 'q8Zt3Xk9Lw2Rb7Nv5Pd1';
    expect(status(SECRET_TOKEN_RULE, short)).toBe('invalid');
    expect(status(SECRET_TOKEN_RULE, short, true)).toBe('structural');
  });

  it('keeps word-built identifiers out even near a context word', () => {
    for (const identifier of [
      'getUserProfileSettingsHandler',
      'AuthenticationServiceProvider2FA',
      'refresh_token_expiry_seconds_2024',
      'session-manager-config-v2',
    ]) {
      expect(status(SECRET_TOKEN_RULE, identifier, true)).toBe('invalid');
    }
  });
});

describe('SECRET_PEM_RULE', () => {
  const block = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    '-----END PRIVATE KEY-----',
  ].join('\n');

  it('finds whole private key blocks', () => {
    const text = `key:\n${block}\nthanks`;
    expect(spans(SECRET_PEM_RULE, text)).toEqual([block]);
    expect(status(SECRET_PEM_RULE, block)).toBe('checksum');
  });

  it('ignores public material and unterminated blocks', () => {
    const cert = block.replaceAll('PRIVATE KEY', 'CERTIFICATE');
    expect(status(SECRET_PEM_RULE, cert)).toBe('invalid');
    expect(spans(SECRET_PEM_RULE, '-----BEGIN PRIVATE KEY----- abc')).toEqual(
      [],
    );
  });
});

describe('credentials given by syntax', () => {
  it('Basic: base64 of user:password', () => {
    const text = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
    expect(spans(SECRET_BASIC_RULE, text)).toEqual(['dXNlcjpwYXNzd29yZA==']);
    expect(status(SECRET_BASIC_RULE, 'dXNlcjpwYXNzd29yZA==')).toBe('checksum');
    // base64 of "hello world": no colon.
    expect(status(SECRET_BASIC_RULE, 'aGVsbG8gd29ybGQ=')).toBe('invalid');
    expect(spans(SECRET_BASIC_RULE, 'a basic understanding')).toEqual([
      'understanding',
    ]);
    expect(status(SECRET_BASIC_RULE, 'understanding')).toBe('invalid');
  });

  it('Bearer: tokens, not prose or placeholders', () => {
    const text = `Authorization: Bearer ${GITHUB}`;
    expect(spans(SECRET_BEARER_RULE, text)).toEqual([GITHUB]);
    expect(status(SECRET_BEARER_RULE, GITHUB)).toBe('checksum');
    // A dotted OAuth-style token is not mistaken for member access.
    expect(status(SECRET_BEARER_RULE, 'ya29.a0AfH6SMBx3k9Lw2Rb7Nv5')).toBe(
      'checksum',
    );
    expect(status(SECRET_BEARER_RULE, 'authentication')).toBe('invalid');
    expect(status(SECRET_BEARER_RULE, 'YOUR_TOKEN')).toBe('invalid');
  });

  it('URL userinfo and curl -u: the password', () => {
    expect(
      spans(SECRET_USERINFO_RULE, 'postgres://app:Xq7Lp2Rv@db.example.com/x'),
    ).toEqual(['Xq7Lp2Rv']);
    expect(
      spans(SECRET_USERINFO_RULE, 'curl -u admin:s3cr3tPass https://x'),
    ).toEqual(['s3cr3tPass']);
    expect(
      spans(SECRET_USERINFO_RULE, "wget --user='bob:Tr0ub4dor3x' x"),
    ).toEqual(['Tr0ub4dor3x']);
    expect(status(SECRET_USERINFO_RULE, '$PASSWORD')).toBe('invalid');
    expect(status(SECRET_USERINFO_RULE, 's3cr3tPass')).toBe('checksum');
  });
});

describe('isSecretKeyName', () => {
  it.each([
    'password',
    'DB_PASSWORD',
    'githubToken',
    'x-api-key',
    'api_key',
    'apikey',
    'client_secret',
    'PRIVATE_KEY',
    'accessKey',
    'pwd',
    'auth',
    'credentials',
  ])('accepts %s', (key) => {
    expect(isSecretKeyName(key)).toBe(true);
  });

  it.each([
    'key',
    'monkey',
    'author',
    'passenger',
    'keyboard',
    'email',
    'tokenize',
  ])('rejects %s', (key) => {
    expect(isSecretKeyName(key)).toBe(false);
  });
});

describe('placeholders and code', () => {
  it.each([
    '',
    '***',
    'xxxxxxxx',
    '<your-key>',
    '{{token}}',
    '${API_KEY}',
    '{token}',
    '[REDACTED]',
    '%API_KEY%',
    '$API_KEY',
    'YOUR_API_KEY',
    'your-token-here',
  ])('placeholder: %s', (value) => {
    expect(isPlaceholder(value)).toBe(true);
    expect(isPlaceholderOrCode(value)).toBe(true);
  });

  it.each([
    'string',
    'number',
    'boolean',
    'null',
    'undefined',
    'true',
    'false',
    'None',
    'req.body.password',
    'config.pwd',
    'process.env.TOKEN',
    'self.secret',
    'params[:password]',
    'getPassword()',
    'os.getenv("TOKEN")',
  ])('code: %s', (value) => {
    expect(isPlaceholder(value)).toBe(false);
    expect(isPlaceholderOrCode(value)).toBe(true);
  });

  it.each(['hunter2', 'correcthorse', 'Summer2024!', 'changeme', 'pwd'])(
    'ordinary or mixed values are not skipped: %s',
    (value) => {
      expect(isPlaceholderOrCode(value)).toBe(false);
    },
  );
});

describe('SECRET_ASSIGNMENT_RULE', () => {
  it('finds values assigned to secret-named keys in common forms', () => {
    const text = [
      `api_key=${GITHUB}`,
      'password: hunter2',
      '"token": "abc123def"',
      "secret => 'Summer2024!'",
      'PWD := pa55w0rd;',
      'pwd = getPassword()',
      'author: Jane',
    ].join('\n');
    expect(spans(SECRET_ASSIGNMENT_RULE, text)).toEqual([
      GITHUB,
      'hunter2',
      'abc123def',
      'Summer2024!',
      'pa55w0rd',
      'getPassword()',
    ]);
  });

  it('leaves Bearer and Basic headers to their own rules', () => {
    expect(
      spans(SECRET_ASSIGNMENT_RULE, 'Authorization: Bearer abc.def'),
    ).toEqual([]);
    expect(
      spans(SECRET_ASSIGNMENT_RULE, 'Authorization: "Basic dXNlcjpw"'),
    ).toEqual([]);
  });

  it('confirms strong values, offers weak ones as possible, skips code', () => {
    expect(status(SECRET_ASSIGNMENT_RULE, GITHUB)).toBe('checksum');
    expect(status(SECRET_ASSIGNMENT_RULE, 'q8Zt3Xk9Lw2Rb7Nv5Pd1')).toBe(
      'structural',
    );
    expect(
      status(SECRET_ASSIGNMENT_RULE, '9f86d081884c7d659a2feaa0c55ad015'),
    ).toBe('structural');
    expect(status(SECRET_ASSIGNMENT_RULE, 'hunter2')).toBe('possible');
    expect(status(SECRET_ASSIGNMENT_RULE, 'string')).toBe('invalid');
    expect(status(SECRET_ASSIGNMENT_RULE, 'req.body.password')).toBe('invalid');
  });

  it('does not run past an unterminated quote or a long value', () => {
    expect(
      spans(SECRET_ASSIGNMENT_RULE, 'token: "abc\npassword: hunter2'),
    ).toEqual(['hunter2']);
    expect(spans(SECRET_ASSIGNMENT_RULE, `token=${'a'.repeat(5000)}`)).toEqual(
      [],
    );
  });
});
