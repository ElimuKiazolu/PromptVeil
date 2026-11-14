/**
 * Vendor-format test tokens for the rule fixtures, assembled at run time from
 * a documented prefix and an obviously fake body, so the repository holds no
 * literal token that secret scanners would report. None is a real credential.
 */
const fake = (...parts: string[]): string => parts.join('');
const FAKE_BODY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';

export const SECRET_TOKENS: Readonly<Record<string, string>> = {
  // AWS access key ID shape with a made-up body (AWS's documented example
  // IDs are not detected: see reserved-values.ts).
  AWS_ACCESS_KEY: fake('AKIA', 'Q7ZXMB2T', 'LP9WE4RJ'),
  GOOGLE_API_KEY: fake('AI', 'za', FAKE_BODY.slice(0, 33), '_-'),
  GITHUB_TOKEN: fake('ghp_', FAKE_BODY.slice(0, 36)),
  SLACK_TOKEN: fake(
    'xox',
    'b-',
    '123456789012-',
    '1234567890123-',
    FAKE_BODY.slice(0, 24),
  ),
};
