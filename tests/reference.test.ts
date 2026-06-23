import { describe, it, expect } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { isBlockedAddress, isBlockedHost, hostAllowed } from '../src/reference/guard';
import { detectFrameworks, htmlToText, excerptAround, extractSignal } from '../src/reference/extract';
import { fetchGuarded } from '../src/reference/fetch';

describe('isBlockedAddress (SSRF guard)', () => {
  it('blocks loopback, private, link-local and ULA ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fd12::1', 'fe80::1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::1']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
    expect(isBlockedAddress('172.32.0.1')).toBe(false); // just outside 172.16/12
  });
});

describe('isBlockedHost', () => {
  it('blocks localhost names and private IP literals', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('foo.localhost')).toBe(true);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('192.168.0.5')).toBe(true);
  });
  it('does not pre-block ordinary domains (DNS is checked at fetch time)', () => {
    expect(isBlockedHost('example.com')).toBe(false);
  });
});

describe('hostAllowed', () => {
  it('honors an explicit allowlist and the allowPrivate override', () => {
    expect(hostAllowed('localhost', { allowPrivateHosts: false, allowHosts: ['localhost'] })).toBe(true);
    expect(hostAllowed('localhost', { allowPrivateHosts: true })).toBe(true);
    expect(hostAllowed('localhost', {})).toBe(false);
    expect(hostAllowed('example.com', {})).toBe(true);
  });
});

describe('detectFrameworks', () => {
  it('identifies frameworks from markup signals', () => {
    expect(detectFrameworks('<div id="__next"></div><script src="/_next/static/x.js">')).toContain('next');
    expect(detectFrameworks('<script src="https://cdn/gsap.min.js"></script>')).toContain('gsap');
    expect(detectFrameworks('<canvas></canvas>THREE.WebGLRenderer')).toContain('three');
    expect(detectFrameworks('<p>plain html</p>')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips scripts/styles/tags and collapses whitespace, decoding entities', () => {
    const html = '<style>.a{}</style><script>var x=1</script><h1>Hi &amp; bye</h1><p>line\n\n  two</p>';
    const out = htmlToText(html);
    expect(out).toContain('Hi & bye');
    expect(out).toContain('line two');
    expect(out).not.toContain('var x');
    expect(out).not.toContain('.a{');
  });
});

describe('excerptAround', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta';
  it('returns a window around the query match', () => {
    const out = excerptAround(text, 'delta', 10);
    expect(out).toContain('delta');
    expect(out.length).toBeLessThan(text.length);
  });
  it('falls back to the head when query is absent', () => {
    expect(excerptAround(text, 'zzz', 10)).toContain('alpha');
    expect(excerptAround(text, undefined, 10)).toContain('alpha');
  });
});

describe('extractSignal', () => {
  it('pulls title, description, headings and links (capped)', () => {
    const html = `<html><head><title>My Page</title>
      <meta name="description" content="A test page"></head>
      <body><h1>Hero</h1><h2>Section</h2>
      <a href="https://a.com">A</a><a href="/rel">Rel</a></body></html>`;
    const sig = extractSignal(html, 'https://site.com/p');
    expect(sig.title).toBe('My Page');
    expect(sig.description).toBe('A test page');
    // reversed attribute order (content before name) still resolves
    const rev = extractSignal('<meta content="Reversed desc" name="description">', 'https://x.com');
    expect(rev.description).toBe('Reversed desc');
    expect(sig.headings).toContain('Hero');
    expect(sig.links.some((l) => l.href === 'https://a.com')).toBe(true);
  });
});

// T35 — fetchGuarded is the most security-critical imperative code, but the
// guard *predicates* being correct (above) ≠ the *loop* calling them on every
// hop. Drive the real fetcher against a loopback http.Server. We allowlist
// 127.0.0.1 so hop 0 reaches the fixture (proving the exempt path); the
// redirect-to-private case proves a later hop is still re-validated and refused.
describe('fetchGuarded (SSRF loop, redirects, cap, timeout)', () => {
  // Spin up a one-off server, run the body against its 127.0.0.1 URL, always close.
  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (baseUrl: string, port: number) => Promise<void>,
  ): Promise<void> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`, port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const allow = { allowHosts: ['127.0.0.1'] };

  it('reaches an allowlisted loopback host and returns its body + status', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello from loopback');
      },
      async (url) => {
        const out = await fetchGuarded(url, allow);
        expect(out.status).toBe(200);
        expect(out.body).toBe('hello from loopback');
        expect(out.contentType).toContain('text/plain');
        expect(out.truncated).toBe(false);
      },
    );
  });

  it('refuses a redirect whose Location resolves to a private address', async () => {
    await withServer(
      (_req, res) => {
        // Reachable hop 0 (allowlisted), but it 302s to a private IP NOT on the
        // allowlist → resolveSafe must refuse on hop 1.
        res.writeHead(302, { location: 'http://10.0.0.1/internal' });
        res.end();
      },
      async (url) => {
        await expect(fetchGuarded(url, allow)).rejects.toThrow(/private|Refusing/i);
      },
    );
  });

  it('caps an oversized body and marks it truncated', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // > the 2,000,000-byte default cap, streamed in chunks.
        const chunk = 'x'.repeat(100_000);
        for (let i = 0; i < 25; i++) res.write(chunk); // ~2.5MB
        res.end();
      },
      async (url) => {
        const out = await fetchGuarded(url, allow);
        expect(out.truncated).toBe(true);
        expect(out.body.length).toBeLessThanOrEqual(2_000_000);
      },
    );
  });

  it('respects a smaller configured maxBytes', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.end('y'.repeat(5_000));
      },
      async (url) => {
        const out = await fetchGuarded(url, { ...allow, maxBytes: 1_000 });
        expect(out.truncated).toBe(true);
        expect(out.body.length).toBeLessThanOrEqual(1_000);
      },
    );
  });

  it('throws on a non-http(s) scheme without touching the network', async () => {
    await expect(fetchGuarded('ftp://example.com/x', {})).rejects.toThrow(/http\(s\)/i);
  });

  it('throws after exceeding the redirect limit', async () => {
    await withServer(
      (_req, res) => {
        // Always redirect back to the same allowlisted host → loop until the cap.
        res.writeHead(302, { location: '/again' });
        res.end();
      },
      async (url) => {
        await expect(fetchGuarded(url, allow)).rejects.toThrow(/[Tt]oo many redirects/);
      },
    );
  });

  it('fires the wall-clock timeout on a hung server', async () => {
    await withServer(
      () => {
        /* never respond — let the request hang */
      },
      async (url) => {
        await expect(fetchGuarded(url, allow, { timeoutMs: 150 })).rejects.toThrow(/[Tt]imed out/);
      },
    );
  });
});
