/**
 * SSRF guard for the reference (URL-study) tools. By default the tools refuse to
 * fetch loopback / private / link-local / unique-local addresses so they can't be
 * pointed at a localhost admin panel or a cloud metadata endpoint
 * (169.254.169.254). The user can opt into private hosts or allowlist specific
 * hostnames via config. Pure predicates — the fetch layer also re-checks the
 * DNS-resolved IP of every redirect hop against these.
 */

export interface ReferenceGuardConfig {
  allowPrivateHosts?: boolean;
  allowHosts?: string[];
  maxBytes?: number;
}

function isBlockedV4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (includes "this host")
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function isBlockedV6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true; // loopback / unspecified
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isBlockedV4(mapped);
  const first = s.split(':')[0];
  if (!first) return true; // begins with "::" → non-global, refuse
  const h = parseInt(first, 16);
  if (Number.isNaN(h)) return false;
  if (((h >> 8) & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if ((h & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** True when `ip` (v4 or v6 literal) is in a range we refuse by default. */
export function isBlockedAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '');
  if (v.includes(':')) return isBlockedV6(v);
  return isBlockedV4(v);
}

/** True when a hostname is loopback-y or a private IP literal (pre-DNS check). */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === 'ip6-localhost' || h.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return isBlockedAddress(h);
  return false;
}

/** Final yes/no for a hostname, honoring the allowlist and the allowPrivate override. */
export function hostAllowed(hostname: string, cfg: ReferenceGuardConfig): boolean {
  const h = hostname.toLowerCase();
  if (cfg.allowHosts?.some((a) => a.toLowerCase() === h)) return true;
  if (cfg.allowPrivateHosts) return true;
  return !isBlockedHost(hostname);
}
