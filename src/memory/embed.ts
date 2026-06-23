/**
 * OPTIONAL semantic embeddings for memory recall. Off by default — the memory
 * graph is fully functional with lexical BM25 and zero keys. If the user turns
 * embeddings on AND has set THEIR OWN provider key, recall blends in cosine
 * similarity. Every failure path falls back to lexical (returns null), so a bad
 * key or a network blip never breaks `memory_recall`.
 *
 * Nothing here is ever billed to the author — it uses the user's own key,
 * resolved through the same Keychain/env path as every other secret.
 */

export interface MemoryConfig {
  /** Turn semantic recall on. Default false (lexical-only, no key needed). */
  embeddings?: boolean;
  /** Which provider to embed with — uses that provider's own key. */
  embedProvider?: 'openai' | 'gemini';
  embedModel?: string;
  /** Default scope for `memory_store` when the caller doesn't specify one. */
  defaultScope?: 'project' | 'global';
  /** Hybrid mix for recall: 0 = pure lexical, 1 = pure semantic. Default 0.5. */
  alpha?: number;
}

export type Embedder = (text: string) => Promise<number[] | null>;
type GetSecret = (name: string) => string | undefined;

const DEFAULT_MODEL = {
  openai: 'text-embedding-3-small',
  gemini: 'text-embedding-004',
} as const;

async function openaiEmbed(text: string, key: string, model: string): Promise<number[] | null> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const v = json.data?.[0]?.embedding;
  return Array.isArray(v) ? v : null;
}

async function geminiEmbed(text: string, key: string, model: string): Promise<number[] | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { embedding?: { values?: number[] } };
  const v = json.embedding?.values;
  return Array.isArray(v) ? v : null;
}

/**
 * Build an embedder, or `undefined` if embeddings are disabled or the chosen
 * provider has no key. The returned function never throws — it resolves to null
 * on any failure so callers degrade to lexical recall.
 */
export function makeEmbedder(cfg: MemoryConfig, getSecret: GetSecret): Embedder | undefined {
  if (!cfg.embeddings) return undefined;
  const provider = cfg.embedProvider ?? 'openai';
  const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
  const key = getSecret(keyName);
  if (!key) return undefined;
  const model = cfg.embedModel ?? DEFAULT_MODEL[provider];
  return async (text: string): Promise<number[] | null> => {
    const clipped = text.slice(0, 8000); // keep requests bounded
    try {
      return provider === 'openai'
        ? await openaiEmbed(clipped, key, model)
        : await geminiEmbed(clipped, key, model);
    } catch {
      return null; // fail-closed → lexical
    }
  };
}
