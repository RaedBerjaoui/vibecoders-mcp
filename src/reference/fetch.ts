/**
 * The one impure part of the reference tools: an SSRF-guarded HTTP fetch.
 *
 * It resolves each hop's hostname to IPs, refuses private/loopback/metadata
 * targets, and then PINS the connection to an already-validated IP via a custom
 * `lookup` — so the socket connects to the exact address we cleared and a
 * DNS-rebinding race (validate one IP, connect to another) is impossible. TLS
 * SNI/cert validation still use the hostname, so HTTPS stays correct. Redirects
 * are followed manually so every hop is re-validated, the body is capped, and a
 * wall-clock timeout bounds the whole thing.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { hostAllowed, isBlockedAddress, type ReferenceGuardConfig } from './guard';

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const UA = 'vibecoders-reference/0.1 (+https://github.com/vibecoders/vibecoders-mcp)';

type SafeAddr = { address: string; family: number };

/**
 * Validate a hostname and return the cleared IPs to pin to — or `'exempt'` when
 * the user explicitly allowlisted the host / opted into private hosts (then we
 * let normal resolution happen). Throws if the host is refused or unresolvable.
 */
async function resolveSafe(hostname: string, cfg: ReferenceGuardConfig): Promise<SafeAddr[] | 'exempt'> {
  if (!hostAllowed(hostname, cfg)) {
    throw new Error(
      `Refusing to fetch ${hostname}: private/loopback host. Enable reference.allowPrivateHosts ` +
        `or add it to reference.allowHosts to override.`,
    );
  }
  if (cfg.allowPrivateHosts || cfg.allowHosts?.some((a) => a.toLowerCase() === hostname.toLowerCase())) {
    return 'exempt';
  }
  const addrs = await dnsLookup(hostname, { all: true });
  if (!addrs.length) throw new Error(`Could not resolve ${hostname}.`);
  for (const { address } of addrs) {
    if (isBlockedAddress(address)) {
      throw new Error(`Refusing to fetch ${hostname}: resolves to a private address (${address}).`);
    }
  }
  return addrs.map((a) => ({ address: a.address, family: a.family }));
}

/** A `lookup` that only ever yields the pre-validated addresses (no re-resolution). */
function pinnedLookup(addrs: SafeAddr[]): LookupFunction {
  return ((_host: string, options: { all?: boolean }, cb: (...args: never[]) => void): void => {
    if (options && options.all) (cb as unknown as (e: null, a: SafeAddr[]) => void)(null, addrs);
    else (cb as unknown as (e: null, a: string, f: number) => void)(null, addrs[0]!.address, addrs[0]!.family);
  }) as unknown as LookupFunction;
}

interface RawResponse {
  status: number;
  headers: IncomingMessage['headers'];
  res: IncomingMessage;
}

function requestOnce(url: URL, lookup: LookupFunction | undefined, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = doRequest(
      url,
      {
        method: 'GET',
        ...(lookup ? { lookup } : {}),
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, res }),
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms.`)));
    req.on('error', reject);
    req.end();
  });
}

function readCapped(res: IncomingMessage, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), truncated });
    };
    res.on('data', (c: Buffer) => {
      if (received >= maxBytes) return;
      chunks.push(c);
      received += c.length;
      if (received >= maxBytes) {
        truncated = true;
        res.destroy();
      }
    });
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', finish);
  });
}

/** Fetch a URL with all guards applied. Throws on blocked host, bad scheme, or timeout. */
export async function fetchGuarded(
  rawUrl: string,
  cfg: ReferenceGuardConfig,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<FetchResult> {
  const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Only http(s) URLs are supported (got ${url.protocol}).`);
    }
    const safe = await resolveSafe(url.hostname, cfg);
    const lookup = safe === 'exempt' ? undefined : pinnedLookup(safe);
    const { status, headers, res } = await requestOnce(url, lookup, timeoutMs);
    const location = headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy(); // discard redirect body
      url = new URL(location, url);
      continue;
    }
    const { body, truncated } = await readCapped(res, maxBytes);
    return { url: url.toString(), status, contentType: headers['content-type'] ?? '', body, truncated };
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`);
}
