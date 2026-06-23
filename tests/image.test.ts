import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRollout,
  extractImageFromRollout,
  parseSessionId,
  generateViaOpenAI,
  generateViaGemini,
  generateViaCodex,
  runImageGen,
  CODEX_AUTH_ENV_UNSET,
  type ImageDeps,
} from '../src/capabilities/image';
import { getProvider } from '../src/providers/registry';

const SESSION_ID = '019ee317-da4a-7e20-821b-46fdfcd7c528';

/** A rollout line carrying a generated image as base64 (the real event shape). */
const imageEventLine = (b64: string) =>
  JSON.stringify({ payload: { type: 'image_generation_end', call_id: 'ig_x', result: b64 } });

/**
 * Fake codex child: prints the session-id banner, runs `onRun` (which may or may
 * not write a rollout JSONL), then exits 0 — modelling codex generating (or not)
 * while always self-reporting done.
 */
function fakeCodexSpawn(onRun: () => void): any {
  return () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write: () => {},
      end: () => {
        setImmediate(() => {
          onRun();
          child.stdout.emit('data', `OpenAI Codex\nsession id: ${SESSION_ID}\n`);
          child.stdout.emit('data', 'IMAGEGEN_DONE');
          child.emit('close', 0);
        });
      },
    };
    return child;
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'vibe-img-'));

/** A fake fetch returning a JSON body + status. */
const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response) as unknown as typeof fetch;

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

describe('codex rollout extraction (the #28898 workaround)', () => {
  it('parseSessionId pulls the id from the codex banner', () => {
    expect(parseSessionId(`OpenAI Codex\nsession id: ${SESSION_ID}\nmodel: gpt-5.5`)).toBe(SESSION_ID);
    expect(parseSessionId('no banner here')).toBeUndefined();
  });

  it('findRollout locates the JSONL whose name embeds the session id', () => {
    const root = tmp();
    const day = join(root, '2026', '06', '19');
    mkdirSync(day, { recursive: true });
    const roll = join(day, `rollout-2026-06-19T23-34-11-${SESSION_ID}.jsonl`);
    writeFileSync(roll, '');
    writeFileSync(join(day, 'rollout-other-019eAAAA.jsonl'), '');
    expect(findRollout(root, SESSION_ID)).toBe(roll);
    expect(findRollout(root, 'nonexistent-id')).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('extractImageFromRollout decodes the LAST image_generation_end base64', () => {
    const root = tmp();
    const roll = join(root, 'r.jsonl');
    const first = Buffer.from('first-image').toString('base64');
    const last = Buffer.from('LAST-image').toString('base64');
    writeFileSync(
      roll,
      [
        JSON.stringify({ payload: { type: 'agent_message', text: 'hi' } }),
        imageEventLine(first),
        '{ not json',
        imageEventLine(last),
      ].join('\n'),
    );
    expect(extractImageFromRollout(roll)?.toString()).toBe('LAST-image');
    rmSync(root, { recursive: true, force: true });
  });

  it('extractImageFromRollout returns undefined when there is no image event', () => {
    const root = tmp();
    const roll = join(root, 'r.jsonl');
    writeFileSync(roll, JSON.stringify({ payload: { type: 'agent_message', text: 'no image' } }));
    expect(extractImageFromRollout(roll)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('generateViaOpenAI', () => {
  const deps = (f: typeof fetch): ImageDeps => ({ getSecret: (k) => (k === 'OPENAI_API_KEY' ? 'sk-test' : undefined), fetchImpl: f });

  it('fails closed (no throw) when the key is missing', async () => {
    const r = await generateViaOpenAI({ prompt: 'x', outPath: '/tmp/x.png' }, { getSecret: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/OPENAI_API_KEY/);
  });

  it('writes the decoded image on success', async () => {
    const root = tmp();
    const out = join(root, 'a.png');
    const r = await generateViaOpenAI({ prompt: 'cat', outPath: out }, deps(fakeFetch(200, { data: [{ b64_json: PNG_B64 }] })));
    expect(r.ok).toBe(true);
    expect(r.path).toBe(out);
    expect(readFileSync(out).toString()).toBe('fake-png-bytes');
    rmSync(root, { recursive: true, force: true });
  });

  it('surfaces an API error instead of throwing', async () => {
    const r = await generateViaOpenAI({ prompt: 'x', outPath: '/tmp/x.png' }, deps(fakeFetch(429, { error: 'rate limited' })));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/429/);
  });
});

describe('generateViaGemini', () => {
  it('writes the decoded image from candidates[].content.parts[].inlineData (Nano Banana)', async () => {
    const root = tmp();
    const out = join(root, 'g.png');
    const deps: ImageDeps = {
      getSecret: (k) => (k === 'GEMINI_API_KEY' ? 'g-test' : undefined),
      fetchImpl: fakeFetch(200, {
        candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { data: PNG_B64 } }] } }],
      }),
    };
    const r = await generateViaGemini({ prompt: 'dog', outPath: out }, deps);
    expect(r.ok).toBe(true);
    expect(readFileSync(out).toString()).toBe('fake-png-bytes');
    rmSync(root, { recursive: true, force: true });
  });

  it('fails closed when the key is missing', async () => {
    const r = await generateViaGemini({ prompt: 'x', outPath: '/tmp/x.png' }, { getSecret: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/GEMINI_API_KEY/);
  });
});

describe('generateViaCodex (rollout-extracting, anti-false-success)', () => {
  const baseOpts = (sessionsDir: string, spawnImpl: any) => ({
    command: 'codex',
    sessionsDir,
    maxAttempts: 2,
    now: () => Date.now(),
    sleep: async () => {}, // never actually wait on the cooldown in tests
    spawnImpl,
  });

  it('returns ok:false when the run produced no image_generation_end event', async () => {
    const sessionsDir = tmp();
    const out = join(tmp(), 'out.png');
    // codex "succeeds" and even writes a rollout, but with NO image event.
    const spawnImpl = fakeCodexSpawn(() => {
      writeFileSync(
        join(sessionsDir, `rollout-x-${SESSION_ID}.jsonl`),
        JSON.stringify({ payload: { type: 'agent_message', text: 'done' } }),
      );
    });
    const r = await generateViaCodex({ prompt: 'apple', outPath: out }, baseOpts(sessionsDir, spawnImpl));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no image after 2 attempts/);
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('decodes the image from the rollout and writes it to outPath', async () => {
    const sessionsDir = tmp();
    const out = join(tmp(), 'out.png');
    const b64 = Buffer.from('GENERATED-PNG').toString('base64');
    const spawnImpl = fakeCodexSpawn(() => {
      writeFileSync(join(sessionsDir, `rollout-x-${SESSION_ID}.jsonl`), imageEventLine(b64));
    });
    const r = await generateViaCodex({ prompt: 'leaf', outPath: out }, baseOpts(sessionsDir, spawnImpl));
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).toString()).toBe('GENERATED-PNG');
    rmSync(sessionsDir, { recursive: true, force: true });
  });
});

describe('codex image-gen strips API creds (shared with the delegate provider)', () => {
  // The image executor and the `codex` delegate provider must strip the SAME auth
  // env so codex bills the ChatGPT/Codex plan, not the OpenAI API. They share one
  // constant so adding a third var to the provider can't silently miss image-gen.
  it('codex image-gen and the codex provider def strip the identical unset-list', () => {
    expect(getProvider('codex')!.env?.unset).toEqual([...CODEX_AUTH_ENV_UNSET]);
  });

  it('removes exactly the shared unset-list from the spawned codex child env', async () => {
    const sessionsDir = tmp();
    const out = join(tmp(), 'out.png');
    let childEnv: NodeJS.ProcessEnv | undefined;
    // Plant the creds so we can prove they're gone from the child env, not just absent.
    process.env.OPENAI_API_KEY = 'sk-should-be-stripped';
    process.env.OPENAI_AUTH_TOKEN = 'tok-should-be-stripped';
    // Also plant an UNRELATED secret — the secure default (minimal env) must drop it.
    process.env.VIBE_TEST_UNRELATED_SECRET = 'leak-me';
    // Capture the env the executor passes to spawn (3rd arg), then behave like a
    // codex that emitted no image so the run ends quickly.
    const spawnImpl: any = (_cmd: string, _argv: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      childEnv = opts.env;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)) };
      return child;
    };
    try {
      await generateViaCodex(
        { prompt: 'x', outPath: out },
        { command: 'codex', sessionsDir, maxAttempts: 1, sleep: async () => {}, spawnImpl },
      );
      for (const k of CODEX_AUTH_ENV_UNSET) expect(childEnv?.[k]).toBeUndefined();
      // Operational env survives (PATH is on the base allowlist)...
      expect(childEnv?.PATH).toBe(process.env.PATH);
      // ...but the unrelated secret is dropped by the secure default (minimal env).
      expect(childEnv?.VIBE_TEST_UNRELATED_SECRET).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_AUTH_TOKEN;
      delete process.env.VIBE_TEST_UNRELATED_SECRET;
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

describe('runImageGen dispatch', () => {
  it('routes to the provider executor and supports test overrides', async () => {
    const calls: string[] = [];
    const deps: ImageDeps = {
      getSecret: () => undefined,
      executors: {
        'openai-api': async (req) => {
          calls.push(`openai:${req.prompt}`);
          return { ok: true, message: 'ok', path: req.outPath };
        },
      },
    };
    const r = await runImageGen('openai-api', { prompt: 'hi', outPath: '/tmp/z.png' }, deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['openai:hi']);
  });
});
