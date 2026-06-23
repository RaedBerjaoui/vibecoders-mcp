/**
 * Pure retrieval math for the memory graph — zero dependencies, zero IO.
 *
 * Recall works with NO API keys: BM25 lexical ranking over the stored corpus.
 * If (and only if) the user configures an embedding provider with THEIR OWN key,
 * the store also keeps per-node vectors and we `blend()` cosine similarity in.
 * Everything here is deterministic and unit-tested.
 */

// A compact English stopword set — enough to stop the ranking being dominated by
// glue words, small enough to stay obviously safe.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into',
  'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then',
  'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with', 'we', 'you', 'your',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and single chars. */
export function tokenize(input: string): string[] {
  return String(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export interface Doc {
  id: string;
  tokens: string[];
}

export interface Scored {
  id: string;
  score: number;
}

/**
 * BM25 ranking. Returns EVERY doc (score 0 allowed) sorted by descending score,
 * so callers can threshold/slice. Okapi BM25 with the standard k1/b defaults.
 */
export function rankBm25(
  queryTokens: string[],
  docs: Doc[],
  { k1 = 1.5, b = 0.75 }: { k1?: number; b?: number } = {},
): Scored[] {
  const N = docs.length;
  if (N === 0) return [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.tokens.length;
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = totalLen / N || 1;
  const qset = [...new Set(queryTokens)];
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = d.tokens.length;
    let score = 0;
    for (const t of qset) {
      const f = tf.get(t);
      if (!f) continue;
      score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    return { id: d.id, score, _i: i };
  });
  scored.sort((a, b2) => b2.score - a.score || a._i - b2._i); // stable on ties
  return scored.map(({ id, score }) => ({ id, score }));
}

/** Cosine similarity; 0 if either vector is empty, zero, or mismatched length. */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Min-max normalize a ranking's scores into [0,1]; flat rankings → all 0. */
function normalize(rows: Scored[]): Map<string, number> {
  const max = rows.reduce((m, r) => Math.max(m, r.score), 0);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.id, max > 0 ? r.score / max : 0);
  return out;
}

/**
 * Hybrid score: `alpha * semantic + (1-alpha) * lexical`, each normalized to
 * [0,1] first so the two scales are comparable. alpha=0 → pure lexical.
 */
export function blend(lexical: Scored[], semantic: Scored[], alpha: number): Scored[] {
  const lex = normalize(lexical);
  const sem = normalize(semantic);
  const ids = new Set([...lex.keys(), ...sem.keys()]);
  const out: Scored[] = [];
  for (const id of ids) {
    out.push({ id, score: alpha * (sem.get(id) ?? 0) + (1 - alpha) * (lex.get(id) ?? 0) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
