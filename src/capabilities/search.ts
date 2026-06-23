/**
 * web_search executors — one per provider option of the web_search capability.
 *
 *   gemini-cli  → the `gemini` CLI's built-in GoogleSearch tool (bills your
 *                 Google/Gemini plan via OAuth, no API key). We prompt it for a
 *                 strict JSON array and decode that out of stdout — agentic CLIs
 *                 wrap answers in prose, so we never trust the raw text.
 *   gemini-api  → generateContent with the `google_search` grounding tool
 *                 (bring-your-own GEMINI_API_KEY). This is the same capability
 *                 Pioneer's web_search exposes — here it is one option of four.
 *   brave-api   → the Brave Search API (bring-your-own BRAVE_API_KEY).
 *   tavily-api  → the Tavily search API, which also returns a synthesized answer
 *                 (bring-your-own TAVILY_API_KEY).
 *
 * Every executor returns a SearchResult — it never throws on provider trouble,
 * so the capability fails CLOSED with an actionable message instead.
 */
import { spawn, type spawn as SpawnFn } from 'node:child_process';
import { buildChildEnv, type ChildEnvMode } from '../util/childEnv';
import { loadVibeConfig, delegationEnvMode } from './config';

export interface SearchRequest {
  query: string;
  /** Desired number of results; providers may cap this. */
  count?: number;
  /** Override the provider's default model (gemini routes only). */
  model?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  ok: boolean;
  /** On success: a short note. On failure: an actionable hint. */
  message: string;
  hits?: SearchHit[];
  /** A synthesized answer, when the provider offers one (Gemini/Tavily). */
  answer?: string;
}

export type SearchProviderId = 'gemini-cli' | 'gemini-api' | 'brave-api' | 'tavily-api';

/** Secret lookup + injectable fetch/spawn so executors stay unit-testable. */
export interface SearchDeps {
  getSecret(key: string): string | undefined;
  fetchImpl?: typeof fetch;
  cli?: GeminiCliOptions;
  /** Test seam: override an executor entirely. */
  executors?: Partial<
    Record<SearchProviderId, (req: SearchRequest, deps: SearchDeps) => Promise<SearchResult>>
  >;
}

const DEFAULT_COUNT = 5;

/**
 * Pull the first JSON array of hit-shaped objects out of arbitrary text — the
 * gemini CLI wraps its answer in prose and/or ```json fences. We scan for the
 * first '[' and parse from there, tolerating trailing prose after the array.
 */
export function extractJsonArray(out: string): SearchHit[] | undefined {
  const start = out.indexOf('[');
  if (start === -1) return undefined;
  // Try progressively shorter closing points so trailing prose doesn't break us.
  for (let end = out.lastIndexOf(']'); end > start; end = out.lastIndexOf(']', end - 1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const hits = parsed
      .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === 'object')
      .map((h) => ({
        title: String(h.title ?? ''),
        url: String(h.url ?? ''),
        snippet: String(h.snippet ?? ''),
      }))
      .filter((h) => h.url);
    if (hits.length > 0) return hits;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// gemini-api — google_search grounding (bring-your-own key).
// ---------------------------------------------------------------------------

export async function searchViaGeminiApi(req: SearchRequest, deps: SearchDeps): Promise<SearchResult> {
  const key = deps.getSecret('GEMINI_API_KEY');
  if (!key) {
    return { ok: false, message: 'GEMINI_API_KEY is not set (`vibecoders vault set GEMINI_API_KEY`).' };
  }
  const f = deps.fetchImpl ?? fetch;
  const model = req.model ?? 'gemini-3-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: req.query }] }],
        tools: [{ google_search: {} }],
      }),
    });
    if (!res.ok) {
      return { ok: false, message: `Gemini search API error ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const j = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
      }>;
    };
    const cand = j.candidates?.[0];
    const answer = (cand?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    const hits: SearchHit[] = (cand?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => c.web)
      .filter((w): w is { uri?: string; title?: string } => Boolean(w?.uri))
      .map((w) => ({ title: w.title ?? '', url: w.uri ?? '', snippet: '' }));
    return { ok: true, message: `Found ${hits.length} result(s) via Gemini grounding.`, hits, answer };
  } catch (e) {
    return { ok: false, message: `Gemini search request failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// brave-api — Brave Search API (bring-your-own key).
// ---------------------------------------------------------------------------

export async function searchViaBrave(req: SearchRequest, deps: SearchDeps): Promise<SearchResult> {
  const key = deps.getSecret('BRAVE_API_KEY');
  if (!key) {
    return { ok: false, message: 'BRAVE_API_KEY is not set (`vibecoders vault set BRAVE_API_KEY`).' };
  }
  const f = deps.fetchImpl ?? fetch;
  const count = req.count ?? DEFAULT_COUNT;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(req.query)}&count=${count}`;
  try {
    const res = await f(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    });
    if (!res.ok) {
      return { ok: false, message: `Brave search API error ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const j = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const hits: SearchHit[] = (j.web?.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }));
    return { ok: true, message: `Found ${hits.length} result(s) via Brave.`, hits };
  } catch (e) {
    return { ok: false, message: `Brave search request failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// tavily-api — Tavily search, which also returns a synthesized answer.
// ---------------------------------------------------------------------------

export async function searchViaTavily(req: SearchRequest, deps: SearchDeps): Promise<SearchResult> {
  const key = deps.getSecret('TAVILY_API_KEY');
  if (!key) {
    return { ok: false, message: 'TAVILY_API_KEY is not set (`vibecoders vault set TAVILY_API_KEY`).' };
  }
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: req.query,
        max_results: req.count ?? DEFAULT_COUNT,
        include_answer: true,
      }),
    });
    if (!res.ok) {
      return { ok: false, message: `Tavily search API error ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const j = (await res.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const hits: SearchHit[] = (j.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
    return { ok: true, message: `Found ${hits.length} result(s) via Tavily.`, hits, answer: j.answer };
  } catch (e) {
    return { ok: false, message: `Tavily search request failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// gemini-cli — the gemini CLI's built-in GoogleSearch, no API key.
// ---------------------------------------------------------------------------

export interface GeminiCliOptions {
  command?: string;
  timeoutMs?: number;
  spawnImpl?: typeof SpawnFn;
  /** Env-inheritance mode; omit to honor `delegation.envMode` (default 'minimal'). */
  envMode?: ChildEnvMode;
}

function cliPrompt(req: SearchRequest): string {
  const n = req.count ?? DEFAULT_COUNT;
  return [
    `Search the web for: ${req.query}`,
    ``,
    `Return ONLY a JSON array of up to ${n} objects, each with keys "title", "url", "snippet".`,
    `No prose, no markdown, just the JSON array.`,
  ].join('\n');
}

function runGeminiOnce(
  prompt: string,
  o: Required<Pick<GeminiCliOptions, 'command' | 'timeoutMs'>>,
  spawnImpl: typeof SpawnFn,
  envMode: ChildEnvMode,
): Promise<{ code: number | null; out: string }> {
  // Build the child env from the secure allowlist (minimal mode drops unrelated
  // secrets) and STRIP API creds so the CLI bills the OAuth plan (it auths via
  // files under $HOME), not a metered API key. The CLI needs nothing beyond the
  // base allowlist, so `allow` stays empty.
  const env = buildChildEnv({ mode: envMode, unset: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] });
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawnImpl(o.command, ['-p', prompt], { env });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, o.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', () => finish(null));
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('close', (code) => finish(code));
    child.stdin?.end();
  });
}

export async function searchViaGeminiCli(req: SearchRequest, o: GeminiCliOptions = {}): Promise<SearchResult> {
  const command = o.command ?? process.env.VIBECODERS_GEMINI_CMD ?? 'gemini';
  const timeoutMs = o.timeoutMs ?? 120_000;
  const spawnImpl = o.spawnImpl ?? spawn;
  const envMode = o.envMode ?? delegationEnvMode(loadVibeConfig());

  const { code, out } = await runGeminiOnce(cliPrompt(req), { command, timeoutMs }, spawnImpl, envMode);
  if (code === null) {
    return { ok: false, message: `gemini CLI timed out after ${timeoutMs}ms.` };
  }
  const hits = extractJsonArray(out);
  if (!hits) {
    return {
      ok: false,
      message:
        `gemini CLI returned no parseable results. ` +
        `Ensure the \`gemini\` CLI is signed in (it bills your Google plan). ` +
        `Last output: ${out.trim().slice(-300) || '(none)'}`,
    };
  }
  return { ok: true, message: `Found ${hits.length} result(s) via Gemini CLI.`, hits };
}

// ---------------------------------------------------------------------------
// Dispatch by resolved provider id.
// ---------------------------------------------------------------------------

export async function runWebSearch(
  providerId: SearchProviderId,
  req: SearchRequest,
  deps: SearchDeps,
): Promise<SearchResult> {
  const override = deps.executors?.[providerId];
  if (override) return override(req, deps);
  switch (providerId) {
    case 'gemini-cli':
      return searchViaGeminiCli(req, deps.cli);
    case 'gemini-api':
      return searchViaGeminiApi(req, deps);
    case 'brave-api':
      return searchViaBrave(req, deps);
    case 'tavily-api':
      return searchViaTavily(req, deps);
    default:
      return { ok: false, message: `No web_search executor for provider "${providerId}".` };
  }
}
