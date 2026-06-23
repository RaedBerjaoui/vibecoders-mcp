import { describe, it, expect } from 'vitest';
import { runDelegate, startDelegate } from '../src/providers/delegate';
import type { ProviderDef } from '../src/providers/registry';

const base = { billing: 'test plan, not the api' } as const;

// Harmless stand-ins backed by node, so tests exercise the real spawn path
// without invoking (or billing) any actual coding-agent CLI.
const echoStdin: ProviderDef = {
  ...base,
  id: 'echo',
  label: 'Echo',
  command: 'node',
  promptVia: 'stdin',
  args: () => [
    '-e',
    'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("got:"+d))',
  ],
};

describe('runDelegate', () => {
  it('delivers the prompt over stdin for stdin providers', async () => {
    const r = await runDelegate(echoStdin, 'hello');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('got:hello');
  });

  it('fails closed (not throws) with the stderr detail on a non-zero exit', async () => {
    const failer: ProviderDef = {
      ...base,
      id: 'failer',
      label: 'Failer',
      command: 'node',
      promptVia: 'argv',
      args: () => ['-e', 'process.stderr.write("boom"); process.exit(2)'],
    };
    const r = await runDelegate(failer, 'x');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('boom');
  });

  it('reads the clean answer from a file when readsOutputFromFile is set', async () => {
    const fileOut: ProviderDef = {
      ...base,
      id: 'fileout',
      label: 'FileOut',
      command: 'node',
      promptVia: 'stdin',
      readsOutputFromFile: true,
      // argv[1] is the outFile path we injected.
      args: ({ outFile }) => [
        '-e',
        'require("fs").writeFileSync(process.argv[1],"FINAL ANSWER")',
        outFile ?? '',
      ],
    };
    const r = await runDelegate(fileOut, 'x');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('FINAL ANSWER');
  });

  it('parses stdout via parseStdout (e.g. JSON-mode providers)', async () => {
    const jsonProv: ProviderDef = {
      ...base,
      id: 'json',
      label: 'Json',
      command: 'node',
      promptVia: 'argv',
      args: ({ prompt }) => [
        '-e',
        'process.stdout.write("noise " + JSON.stringify({response:"parsed:"+process.argv[1]}))',
        prompt,
      ],
      parseStdout: (s) => {
        const j = JSON.parse(s.slice(s.indexOf('{')));
        return j.response;
      },
    };
    const r = await runDelegate(jsonProv, 'hi');
    expect(r.output).toBe('parsed:hi');
  });

  it('applies the provider env (sets subscription flags, strips API keys)', async () => {
    process.env.SECRET_TEST_KEY = 'leak';
    try {
      const envProv: ProviderDef = {
        ...base,
        id: 'env',
        label: 'Env',
        command: 'node',
        promptVia: 'argv',
        args: () => [
          '-e',
          'process.stdout.write("GCA="+(process.env.GOOGLE_GENAI_USE_GCA||"")+";KEY="+(process.env.SECRET_TEST_KEY||"unset"))',
        ],
        env: { unset: ['SECRET_TEST_KEY'], set: { GOOGLE_GENAI_USE_GCA: 'true' } },
      };
      const r = await runDelegate(envProv, 'x');
      expect(r.output).toBe('GCA=true;KEY=unset');
    } finally {
      delete process.env.SECRET_TEST_KEY;
    }
  });

  it('minimal env mode (default) drops an unrelated secret from the child env', async () => {
    // Plant an unrelated secret in the parent. Under the secure default the
    // child must NOT see it — this is the leak we're closing.
    process.env.VIBE_TEST_UNRELATED_SECRET = 'leak-me';
    try {
      const probe: ProviderDef = {
        ...base,
        id: 'probe',
        label: 'Probe',
        command: 'node',
        promptVia: 'argv',
        args: () => [
          '-e',
          'process.stdout.write("SECRET="+(process.env.VIBE_TEST_UNRELATED_SECRET||"unset"))',
        ],
      };
      // No envMode passed → resolves to the config default ('minimal').
      const r = await runDelegate(probe, 'x');
      expect(r.output).toBe('SECRET=unset');
    } finally {
      delete process.env.VIBE_TEST_UNRELATED_SECRET;
    }
  });

  it('inherit env mode forwards the unrelated secret (opt-out)', async () => {
    process.env.VIBE_TEST_UNRELATED_SECRET = 'leak-me';
    try {
      const probe: ProviderDef = {
        ...base,
        id: 'probe2',
        label: 'Probe2',
        command: 'node',
        promptVia: 'argv',
        args: () => [
          '-e',
          'process.stdout.write("SECRET="+(process.env.VIBE_TEST_UNRELATED_SECRET||"unset"))',
        ],
      };
      const r = await runDelegate(probe, 'x', { envMode: 'inherit' });
      expect(r.output).toBe('SECRET=leak-me');
    } finally {
      delete process.env.VIBE_TEST_UNRELATED_SECRET;
    }
  });

  it('reports a timeout instead of hanging on a slow provider', async () => {
    const slow: ProviderDef = {
      ...base,
      id: 'slow',
      label: 'Slow',
      command: 'node',
      promptVia: 'argv',
      args: () => ['-e', 'setTimeout(() => {}, 5000)'],
    };
    const r = await runDelegate(slow, 'x', { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/timed out/i);
  }, 5000);
});

describe('startDelegate', () => {
  it('exposes a live child and resolves done with the result', async () => {
    const h = startDelegate(echoStdin, 'hello');
    expect(typeof h.child.pid).toBe('number');
    expect(h.child.pid).toBeGreaterThan(0);
    const r = await h.done;
    expect(r.ok).toBe(true);
    expect(r.output).toBe('got:hello');
  });

  it('peek() exposes streamed output before the child exits', async () => {
    const streamer: ProviderDef = {
      ...base,
      id: 'streamer',
      label: 'Streamer',
      command: 'node',
      promptVia: 'argv',
      // write immediately, then stay alive so we can observe the stream mid-run
      args: () => ['-e', 'process.stdout.write("partial");setTimeout(()=>{},800)'],
    };
    const h = startDelegate(streamer, 'x', { timeoutMs: 5000 });
    // Poll until the first chunk lands — node startup latency varies under load,
    // so a fixed sleep would be flaky.
    const deadline = Date.now() + 4000;
    while (!h.peek().includes('partial') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.peek()).toContain('partial');
    h.child.kill('SIGKILL');
    await h.done;
  }, 8000);
});
