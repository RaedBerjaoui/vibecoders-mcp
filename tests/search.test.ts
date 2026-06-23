import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  extractJsonArray,
  searchViaGeminiApi,
  searchViaBrave,
  searchViaTavily,
  searchViaGeminiCli,
  runWebSearch,
  type SearchDeps,
} from '../src/capabilities/search';

/** A fake fetch returning a JSON body + status (mirrors image.test.ts). */
const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response) as unknown as typeof fetch;

/** Fake gemini child: emits the given stdout, then exits 0. */
function fakeGeminiSpawn(stdout: string, code = 0): any {
  return () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write: () => {},
      end: () => {
        setImmediate(() => {
          child.stdout.emit('data', stdout);
          child.emit('close', code);
        });
      },
    };
    return child;
  };
}

describe('extractJsonArray', () => {
  it('parses a bare JSON array of hits', () => {
    const hits = extractJsonArray('[{"title":"A","url":"https://a.com","snippet":"x"}]');
    expect(hits).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'x' }]);
  });

  it('parses a JSON array embedded in prose / fenced code', () => {
    const out = 'Sure, here are results:\n```json\n[{"title":"B","url":"https://b.com","snippet":"y"}]\n```\nDone.';
    expect(extractJsonArray(out)).toEqual([{ title: 'B', url: 'https://b.com', snippet: 'y' }]);
  });

  it('returns undefined when there is no array', () => {
    expect(extractJsonArray('no results found, sorry')).toBeUndefined();
  });
});

describe('searchViaGeminiApi (google_search grounding)', () => {
  const deps = (f: typeof fetch): SearchDeps => ({
    getSecret: (k) => (k === 'GEMINI_API_KEY' ? 'g-test' : undefined),
    fetchImpl: f,
  });

  it('fails closed (no throw) when the key is missing', async () => {
    const r = await searchViaGeminiApi({ query: 'x' }, { getSecret: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/GEMINI_API_KEY/);
  });

  it('parses the answer text and grounding chunks into hits', async () => {
    const body = {
      candidates: [
        {
          content: { parts: [{ text: 'The capital is Paris.' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://wiki/paris', title: 'Paris — Wikipedia' } },
              { web: { uri: 'https://france.gov', title: 'France' } },
            ],
          },
        },
      ],
    };
    const r = await searchViaGeminiApi({ query: 'capital of France' }, deps(fakeFetch(200, body)));
    expect(r.ok).toBe(true);
    expect(r.answer).toBe('The capital is Paris.');
    expect(r.hits).toEqual([
      { title: 'Paris — Wikipedia', url: 'https://wiki/paris', snippet: '' },
      { title: 'France', url: 'https://france.gov', snippet: '' },
    ]);
  });

  it('surfaces an API error instead of throwing', async () => {
    const r = await searchViaGeminiApi({ query: 'x' }, deps(fakeFetch(429, { error: 'rate limited' })));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/429/);
  });
});

describe('searchViaBrave', () => {
  const deps = (f: typeof fetch): SearchDeps => ({
    getSecret: (k) => (k === 'BRAVE_API_KEY' ? 'b-test' : undefined),
    fetchImpl: f,
  });

  it('fails closed when the key is missing', async () => {
    const r = await searchViaBrave({ query: 'x' }, { getSecret: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/BRAVE_API_KEY/);
  });

  it('maps web.results[] into hits', async () => {
    const body = {
      web: {
        results: [
          { title: 'R1', url: 'https://r1', description: 'd1' },
          { title: 'R2', url: 'https://r2', description: 'd2' },
        ],
      },
    };
    const r = await searchViaBrave({ query: 'q', count: 2 }, deps(fakeFetch(200, body)));
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([
      { title: 'R1', url: 'https://r1', snippet: 'd1' },
      { title: 'R2', url: 'https://r2', snippet: 'd2' },
    ]);
  });

  it('surfaces an API error', async () => {
    const r = await searchViaBrave({ query: 'x' }, deps(fakeFetch(401, { error: 'bad token' })));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
  });
});

describe('searchViaTavily', () => {
  const deps = (f: typeof fetch): SearchDeps => ({
    getSecret: (k) => (k === 'TAVILY_API_KEY' ? 't-test' : undefined),
    fetchImpl: f,
  });

  it('fails closed when the key is missing', async () => {
    const r = await searchViaTavily({ query: 'x' }, { getSecret: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/TAVILY_API_KEY/);
  });

  it('maps results[] + answer', async () => {
    const body = {
      answer: 'Synthesized answer.',
      results: [
        { title: 'T1', url: 'https://t1', content: 'c1' },
        { title: 'T2', url: 'https://t2', content: 'c2' },
      ],
    };
    const r = await searchViaTavily({ query: 'q' }, deps(fakeFetch(200, body)));
    expect(r.ok).toBe(true);
    expect(r.answer).toBe('Synthesized answer.');
    expect(r.hits).toEqual([
      { title: 'T1', url: 'https://t1', snippet: 'c1' },
      { title: 'T2', url: 'https://t2', snippet: 'c2' },
    ]);
  });
});

describe('searchViaGeminiCli', () => {
  const baseOpts = (spawnImpl: any) => ({ command: 'gemini', timeoutMs: 5_000, spawnImpl });

  it('extracts hits from the CLI JSON output', async () => {
    const out = '```json\n[{"title":"C1","url":"https://c1","snippet":"s1"}]\n```';
    const r = await searchViaGeminiCli({ query: 'q' }, baseOpts(fakeGeminiSpawn(out)));
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([{ title: 'C1', url: 'https://c1', snippet: 's1' }]);
  });

  it('returns ok:false when the CLI emits no parseable results', async () => {
    const r = await searchViaGeminiCli({ query: 'q' }, baseOpts(fakeGeminiSpawn('I could not find anything.')));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no.*result/i);
  });

  it('minimal env (default) drops an unrelated secret and strips the gemini API keys', async () => {
    let childEnv: NodeJS.ProcessEnv | undefined;
    // Plant an unrelated secret + the API creds the CLI must not see (OAuth billing).
    process.env.VIBE_TEST_UNRELATED_SECRET = 'leak-me';
    process.env.GEMINI_API_KEY = 'g-should-be-stripped';
    process.env.GOOGLE_API_KEY = 'g-should-be-stripped';
    const capturingSpawn: any = (_cmd: string, _argv: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      childEnv = opts.env;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)) };
      return child;
    };
    try {
      await searchViaGeminiCli({ query: 'q' }, baseOpts(capturingSpawn));
      expect(childEnv?.VIBE_TEST_UNRELATED_SECRET).toBeUndefined(); // unrelated secret dropped
      expect(childEnv?.GEMINI_API_KEY).toBeUndefined(); // OAuth-billing strip preserved
      expect(childEnv?.GOOGLE_API_KEY).toBeUndefined();
      expect(childEnv?.PATH).toBe(process.env.PATH); // operational env survives
    } finally {
      delete process.env.VIBE_TEST_UNRELATED_SECRET;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
    }
  });
});

describe('runWebSearch dispatch', () => {
  it('routes to the provider executor and supports test overrides', async () => {
    const calls: string[] = [];
    const deps: SearchDeps = {
      getSecret: () => undefined,
      executors: {
        'brave-api': async (req) => {
          calls.push(`brave:${req.query}`);
          return { ok: true, message: 'ok', hits: [] };
        },
      },
    };
    const r = await runWebSearch('brave-api', { query: 'hi' }, deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['brave:hi']);
  });

  it('reports an unknown provider without throwing', async () => {
    const r = await runWebSearch('nope' as any, { query: 'x' }, { getSecret: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no.*executor/i);
  });
});
