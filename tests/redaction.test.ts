import { describe, it, expect } from 'vitest';
import { makeRedactor, defaultRedactor } from '../src/util/redact';
import { loadConfig } from '../src/config/env';
import { keychainGet } from '../src/config/secrets';

// Build a secret-SHAPED fixture at runtime from prefix + body, so the literal
// token pattern never appears contiguously in this source file. These are
// synthetic test values (not real keys), but a contiguous literal would trip
// GitHub/secret scanners on a public push — splitting prefix from body defeats
// the scanner while the redactor still receives a realistically shaped token.
const tok = (prefix: string, body: string): string => prefix + body;

describe('redaction', () => {
  it('scrubs registered secret values verbatim', () => {
    const redact = makeRedactor(['super-secret-token-123456']);
    expect(redact('auth header super-secret-token-123456 sent')).toBe('auth header *** sent');
  });

  it('scrubs key-shaped tokens by pattern', () => {
    const out = defaultRedactor(`using ${tok('sk-ant-', 'FAKEKEYFORTESTSONLY')} to call the api`);
    expect(out).toContain('***');
    expect(out).not.toContain('FAKEKEYFORTESTSONLY');
  });

  it('handles non-string input without throwing', () => {
    const out = defaultRedactor({ token: tok('ghp_', 'FAKEFAKEFAKEFAKEFAKE00') });
    expect(out).not.toContain('FAKEFAKEFAKEFAKEFAKE00');
  });

  // Vibecoders manages GEMINI_API_KEY — a Google "AIza…" key. It must never
  // survive into a log line, even when not in the live secret set.
  it('scrubs a Google/Gemini AIza key by pattern', () => {
    const out = defaultRedactor(`key ${tok('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5pQr')} used`);
    expect(out).toContain('***');
    expect(out).not.toContain('SyA1b2');
  });

  // Vibecoders manages SUPABASE_ACCESS_TOKEN (sbp_…) and projects expose JWT
  // anon/service keys (eyJ…). Both shapes must be redacted by pattern.
  it('scrubs a Supabase sbp_ access token by pattern', () => {
    const out = defaultRedactor(tok('sbp_', '0123456789abcdef0123456789abcdef01234567'));
    expect(out).toBe('***');
  });

  it('scrubs a JWT (e.g. Supabase anon/service key) by pattern', () => {
    const jwt = tok('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV1adQssw5c');
    const out = defaultRedactor(`token=${jwt}`);
    expect(out).not.toContain('eyJ');
  });

  // Good-citizen coverage for the common provider tokens a vibecoder is likely
  // to paste through this gateway. Each row is the same behavior: scrub by shape.
  it.each([
    ['OpenAI project key', tok('sk-proj-', 'ABCDEFGHIJKLMNOPQRSTUVWX1234')],
    ['OpenAI legacy key', tok('sk-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789AB')],
    ['Slack token', tok('xoxb-', 'FAKEFAKEFAKE-FAKEFAKEFAKE')],
    ['Stripe live key', tok('sk_live_', 'ABCDEFGHIJKLMNOP1234')],
    ['npm token', tok('npm_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
    ['GitHub server token', tok('ghs_', 'ABCDEFGHIJKLMNOP1234567890')],
    ['Bearer token', `Authorization: Bearer ${tok('', 'ABCDEFGHIJKLMNOP1234')}`],
  ])('scrubs a %s by pattern', (_label, token) => {
    const out = defaultRedactor(`value ${token} end`);
    expect(out).toContain('***');
    expect(out).not.toContain(token);
  });

  // T15 — the pattern layer is the fallback for tokens that leak through a
  // downstream tool's response (the T10 data-plane case). Widen the body class
  // and add provider prefixes that the original set missed.
  it.each([
    // Newer OpenAI keys carry `-`/`_` in the body — the old [A-Za-z0-9] body
    // class stopped scrubbing at the first separator and leaked the tail.
    ['OpenAI key with separators in body', tok('sk-', 'ABCD_EFGH-IJKL_MNOP-QRST_UVWX-YZ01_2345')],
    ['OpenAI project key with separators', tok('sk-proj-', 'ABCD_EFGH-IJKL-MNOP_QRST1234')],
    // Google OAuth client secret + refresh token.
    ['Google OAuth client secret', tok('GOCSPX-', 'AbCdEfGhIjKlMnOpQrStUvWxYz')],
    ['Google OAuth refresh token', tok('1//0g', 'ABCDEFGHIJKLMNOPqrstuvwxyz-_1234567890')],
    // Hugging Face user access token.
    ['HuggingFace token', tok('hf_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh')],
    // Slack app-level token (Socket Mode) — distinct from the xoxb/xoxp set.
    ['Slack app-level token', tok('xapp-1-', 'A01B2C3D4E5-1234567890-abcdef0123456789')],
  ])('scrubs a %s by pattern', (_label, token) => {
    const out = defaultRedactor(`value ${token} end`);
    expect(out).toContain('***');
    expect(out).not.toContain(token);
  });

  // VERCEL_TOKEN has no distinctive prefix, so pattern-scrubbing can't catch it
  // by shape. The guarantee for prefix-less managed secrets is value-scrubbing:
  // the live secret set must redact it verbatim from any response.
  it('scrubs a prefix-less managed token (e.g. VERCEL_TOKEN) by value', () => {
    const vercel = 'AbCdEf0123456789AbCdEf01'; // 24-char opaque, no prefix
    const redact = makeRedactor([vercel]);
    expect(redact(`VERCEL_TOKEN=${vercel} deploying`)).toBe('VERCEL_TOKEN=*** deploying');
  });

  // The redactor must not be trigger-happy: ordinary text passes through intact.
  it('does not over-redact benign text', () => {
    const benign = 'Upgraded to version 1.2.3, build 456789, see https://github.com/foo/bar';
    expect(defaultRedactor(benign)).toBe(benign);
  });
});

// T38 — secrets.ts is the lone shell-wrapper without an injectable exec seam
// (mdfind/delegate/codex/gemini all have one). With a fake runner we can assert
// the parse/fail-closed behavior directly instead of only via the catch on CI.
describe('keychainGet (fake-exec seam)', () => {
  it('returns the value with the trailing newline stripped', async () => {
    const fake = async (): Promise<{ stdout: string }> => ({ stdout: 'super-secret\n' });
    expect(await keychainGet('OPENAI_API_KEY', fake)).toBe('super-secret');
  });

  it('returns undefined for empty stdout (no entry / blank value)', async () => {
    const fake = async (): Promise<{ stdout: string }> => ({ stdout: '' });
    expect(await keychainGet('OPENAI_API_KEY', fake)).toBeUndefined();
  });

  it('returns undefined when the runner throws (absent entry / non-macOS)', async () => {
    const fake = async (): Promise<{ stdout: string }> => {
      throw new Error('SecKeychainSearchCopyNext: The specified item could not be found.');
    };
    expect(await keychainGet('OPENAI_API_KEY', fake)).toBeUndefined();
  });

  it('passes the service and account through to the runner', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fake = async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push({ cmd, args });
      return { stdout: 'v\n' };
    };
    await keychainGet('GEMINI_API_KEY', fake);
    expect(calls[0]!.cmd).toBe('security');
    expect(calls[0]!.args).toContain('GEMINI_API_KEY');
    expect(calls[0]!.args).toContain('vibecoders-mcp');
  });
});

describe('config — bring-your-own-keys, fail-closed', () => {
  it('resolves present keys and reports missing ones clearly', async () => {
    const cfg = await loadConfig({
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      VIBECODERS_LOG_LEVEL: 'warn',
    });
    expect(cfg.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(cfg.require('ANTHROPIC_API_KEY')).toBe('test-anthropic-key');
    expect(cfg.logLevel).toBe('warn');
    expect(cfg.has('GEMINI_API_KEY')).toBe(false);
    expect(() => cfg.require('GEMINI_API_KEY')).toThrow(/Missing GEMINI_API_KEY/);
  });
});
