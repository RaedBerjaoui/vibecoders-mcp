/**
 * Secret redaction for logs AND tool responses. Two layers, applied to every
 * scrubbed string:
 *   1) value-based  — scrub the exact secret strings we currently hold
 *   2) pattern-based — scrub anything shaped like a known key/token
 * Never throws; safe to wrap around arbitrary input.
 *
 * GUARANTEE vs BEST-EFFORT: value-scrubbing (layer 1) is the guarantee — any
 * secret in the live set is redacted verbatim, regardless of shape, so a
 * prefix-less managed token (VERCEL_TOKEN, etc.) is still caught. The patterns
 * (layer 2) are best-effort defense-in-depth for tokens that surface in a
 * downstream tool's response before we ever held them; bodies use a permissive
 * [A-Za-z0-9_-] class because modern keys embed `-`/`_` separators.
 */

const SECRET_PATTERNS: RegExp[] = [
  // Anthropic
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  // GitHub — personal, oauth, fine-grained PAT, and server/refresh/user-to-server
  /ghp_[A-Za-z0-9]{16,}/g,
  /gho_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[sru]_[A-Za-z0-9]{16,}/g,
  // Google / Gemini API key (managed by Vibecoders as GEMINI_API_KEY)
  /AIza[0-9A-Za-z_-]{35}/g,
  // Google OAuth — client secret (GOCSPX-) and refresh token (1//…)
  /GOCSPX-[A-Za-z0-9_-]{20,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  // Supabase — personal access token (managed) and JWT anon/service keys
  /sbp_[a-f0-9]{40}/g,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // OpenAI — project-scoped and legacy (body may carry -/_ in newer keys)
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
  // Hugging Face — user access token
  /hf_[A-Za-z0-9]{32,}/g,
  // Slack — bot/user/etc. tokens and app-level (Socket Mode) tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /xapp-[A-Za-z0-9-]{10,}/g,
  // Stripe (live/test secret + restricted keys)
  /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // npm automation token
  /npm_[A-Za-z0-9]{36}/g,
  // AWS access key id
  /AKIA[0-9A-Z]{16}/g,
  // Authorization: Bearer <token>
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function safeStringify(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * Build a redactor that scrubs the given secret values (plus key-shaped
 * patterns). Pass it the live set of resolved secrets.
 */
export function makeRedactor(secretValues: Iterable<string>): (input: unknown) => string {
  const values = [...secretValues].filter((v) => typeof v === 'string' && v.length >= 6);
  return (input: unknown): string => {
    let s = safeStringify(input);
    for (const v of values) {
      if (s.includes(v)) s = s.split(v).join('***');
    }
    for (const re of SECRET_PATTERNS) s = s.replace(re, '***');
    return s;
  };
}

/** Pattern-only redactor for when no secret set is available yet. */
export const defaultRedactor = makeRedactor([]);
