import { describe, expect, it } from 'vitest';
import {
  isValidEmail,
  isValidEmailDomain,
  isValidEmailLocalPart,
  normaliseEmail,
} from '@/src/core/detect/validators/email.ts';

describe('isValidEmail', () => {
  it('accepts ordinary addresses on documentation domains', () => {
    expect(isValidEmail('dana@example.com')).toBe(true);
    expect(isValidEmail('dana.whitfield@example.org')).toBe(true);
    expect(isValidEmail('o_reilly@example.net')).toBe(true);
    expect(isValidEmail("o'brien@example.com")).toBe(true);
  });

  it('accepts subdomains and plus-addressing', () => {
    expect(isValidEmail('ops@mail.eu.example.org')).toBe(true);
    expect(isValidEmail('dana+newsletter@example.com')).toBe(true);
    expect(isValidEmail('dana+a+b@sub-domain.example.co.uk')).toBe(true);
  });

  it('accepts Unicode letters and punycode TLDs', () => {
    expect(isValidEmail('josé@example.com')).toBe(true);
    expect(isValidEmail('user@bücher.example')).toBe(true);
    expect(isValidEmail('user@example.xn--p1ai')).toBe(true);
  });

  it('requires a TLD that is not a number or a file extension', () => {
    expect(isValidEmail('user@localhost')).toBe(false);
    expect(isValidEmail('user@example.123')).toBe(false);
    expect(isValidEmail('icon@2x.png')).toBe(false);
    expect(isValidEmail('user@example.c')).toBe(false);
  });

  it('rejects quoted local parts and address literals (documented rule)', () => {
    expect(isValidEmail('"john doe"@example.com')).toBe(false);
    expect(isValidEmail('"dana"@example.com')).toBe(false);
    expect(isValidEmail('user@[192.0.2.1]')).toBe(false);
    expect(isValidEmail('user@[IPv6:2001:db8::1]')).toBe(false);
  });

  it('rejects malformed local parts', () => {
    expect(isValidEmail('.dana@example.com')).toBe(false);
    expect(isValidEmail('dana.@example.com')).toBe(false);
    expect(isValidEmail('da..na@example.com')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('da na@example.com')).toBe(false);
    expect(isValidEmail('dana@@example.com')).toBe(false);
  });

  it('rejects malformed domains', () => {
    expect(isValidEmail('dana@')).toBe(false);
    expect(isValidEmail('dana@.example.com')).toBe(false);
    expect(isValidEmail('dana@example..com')).toBe(false);
    expect(isValidEmail('dana@-example.com')).toBe(false);
    expect(isValidEmail('dana@example-.com')).toBe(false);
    expect(isValidEmail('dana@exa_mple.com')).toBe(false);
  });

  it('enforces the RFC 5321 length limits', () => {
    expect(isValidEmail(`${'a'.repeat(64)}@example.com`)).toBe(true);
    expect(isValidEmail(`${'a'.repeat(65)}@example.com`)).toBe(false);
    expect(isValidEmail(`a@${'b'.repeat(63)}.com`)).toBe(true);
    expect(isValidEmail(`a@${'b'.repeat(64)}.com`)).toBe(false);
    const longDomain = `${Array.from({ length: 4 }, () => 'c'.repeat(60)).join('.')}.com`;
    expect(isValidEmail(`a@${longDomain}`)).toBe(true);
    expect(isValidEmail(`${'a'.repeat(10)}@${longDomain}`)).toBe(false);
  });

  it('rejects empty input and input without @', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('dana.example.com')).toBe(false);
  });

  it('stays fast on adversarial input', () => {
    const inputs = [
      `${'a'.repeat(100_000)}@example.com`,
      '@'.repeat(100_000),
      `a@${'b.'.repeat(50_000)}com`,
      `a@${'b-'.repeat(50_000)}`,
      `${'a.'.repeat(50_000)}@example.com`,
    ];
    const started = performance.now();
    for (const input of inputs) expect(isValidEmail(input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('local part and domain checks', () => {
  it('apply the same rules separately', () => {
    expect(isValidEmailLocalPart('dana+news')).toBe(true);
    expect(isValidEmailLocalPart('')).toBe(false);
    expect(isValidEmailLocalPart('-dana')).toBe(false);
    expect(isValidEmailDomain('example.com')).toBe(true);
    expect(isValidEmailDomain('example')).toBe(false);
    expect(isValidEmailDomain('')).toBe(false);
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => {
    expect(normaliseEmail('  Dana.Whitfield@Example.COM ')).toBe(
      'dana.whitfield@example.com',
    );
  });
});
