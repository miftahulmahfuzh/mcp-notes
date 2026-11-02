import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../../src/sessions/redact.js';

describe('redactSecrets', () => {
  const cases: Array<[string, string, string]> = [
    ['anthropic key', 'key is sk-ant-api03-AbCdEf1234567890xyz', 'sk-ant-api03'],
    ['openrouter key', 'OPENROUTER sk-or-v1-0123456789abcdef0123', 'sk-or-v1'],
    ['github token', 'push with ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz0123', 'ghp_ABCD'],
    ['gitlab token', 'glpat-abcdefghij0123456789xx', 'glpat-abc'],
    ['slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234'],
    ['aws key id', 'AKIAABCDEFGHIJKLMNOP is the id', 'AKIAABCD'],
    ['google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSy'],
    ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGci'],
    ['bearer header', 'curl -H "Authorization: Bearer abc.def.ghi123"', 'abc.def.ghi123'],
    ['basic header', 'authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['postgres url', 'DATABASE_URL=postgres://neondb_owner:p4ssw0rd@ep-x.neon.tech/neondb', 'p4ssw0rd'],
    ['redis url in prose', 'connect to redis://default:hunter2@localhost:6379', 'hunter2'],
    ['env secret', 'OPENROUTER_API_KEY=whatever-value-here', 'whatever-value-here'],
    ['export secret', 'export GITHUB_TOKEN="plain"', 'plain'],
    ['yaml password', 'password: correct horse', 'correct'],
    ['json secret', '{"client_secret": "s3cr3t-value"}', 's3cr3t-value'],
    ['query string', 'https://x.test/cb?api_key=abc123&x=1', 'abc123'],
    ['opaque env value', 'SOME_THING=Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0A', 'Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0A'],
    ['opaque token in prose', 'use Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0Aq to log in', 'Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0Aq'],
  ];

  for (const [label, input, secret] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactSecrets(input);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED);
    });
  }

  it('redacts a whole PEM private key block', () => {
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAABG5vbmUAAAAEbm9uZQ', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    const out = redactSecrets(`here:\n${pem}\nthanks`);
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(out).toContain(`${REDACTED} private key`);
    expect(out).toContain('thanks');
  });

  it('keeps ordinary text, paths, commit shas and harmless env lines', () => {
    const text = [
      'fix the wall editor in src/sessions/summaryWorker.ts',
      'commit 8c259df0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6',
      'NODE_ENV=production',
      'NOTESD_SESSIONS=off',
      'used 500 input tokens',
      'https://github.com/miftahulmahfuzh/mcp-notes/pull/12',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets('OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123 and Bearer abcdef');
    expect(redactSecrets(once)).toBe(once);
  });
});
