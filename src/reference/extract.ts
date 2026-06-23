/**
 * Pure HTML → signal extraction for the reference tools. No DOM, no dependency —
 * just enough regex to surface a page's technique (title, description, headings,
 * links, detected frameworks) and plain text for excerpting. Deliberately
 * conservative: this reads pages to learn from them, it does not clone them.
 */

const FRAMEWORK_SIGNALS: Array<[string, RegExp]> = [
  ['next', /__NEXT_DATA__|\/_next\/static|id="__next"/],
  ['nuxt', /__NUXT__|\/_nuxt\//],
  ['react', /data-reactroot|react(?:\.production|\.development)?(?:\.min)?\.js|react-dom/i],
  ['vue', /__vue__|data-v-[0-9a-f]{6,}|vue(?:\.runtime)?(?:\.min)?\.js/i],
  ['svelte', /svelte-[0-9a-z]{4,}|\.svelte\b/i],
  ['angular', /ng-version=|angular(?:\.min)?\.js/i],
  ['astro', /astro-island|\/_astro\//i],
  ['gsap', /\bgsap\b|TweenMax|greensock/i],
  ['three', /\bthree(?:\.min)?\.js\b|THREE\.[A-Z]/],
  ['framer-motion', /framer-motion|framerusercontent/i],
  ['tailwind', /tailwind(?:css)?(?:\.min)?\.js|cdn\.tailwindcss/i],
  ['jquery', /jquery(?:-\d|\.min)?\.js|\bjQuery\b/i],
  ['lottie', /lottie(?:-web|\.min)?\.js|lottiefiles/i],
];

/** Frameworks/libraries detectable from raw markup. Sorted, de-duped. */
export function detectFrameworks(html: string): string[] {
  const hits = new Set<string>();
  for (const [name, re] of FRAMEWORK_SIGNALS) if (re.test(html)) hits.add(name);
  return [...hits].sort();
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** Strip scripts/styles/comments/tags, decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** A window of text around the first `query` match, or the head if not found. */
export function excerptAround(text: string, query: string | undefined, radius: number): string {
  if (query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - radius);
      const end = Math.min(text.length, idx + query.length + radius);
      return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }
  }
  const head = text.slice(0, radius * 2);
  return head + (text.length > head.length ? '…' : '');
}

export interface Signal {
  url: string;
  title: string;
  description: string;
  frameworks: string[];
  headings: string[];
  links: Array<{ href: string; text: string }>;
  textLength: number;
}

function firstMatch(re: RegExp, s: string): string {
  const m = s.match(re);
  return m?.[1] ? decodeEntities(m[1].trim()) : '';
}

/** Structured "what is this page made of" signal — capped for context safety. */
export function extractSignal(html: string, url: string): Signal {
  const title = firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  const description =
    firstMatch(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i, html) ||
    firstMatch(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i, html) || // reversed attrs
    firstMatch(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i, html) ||
    firstMatch(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i, html);

  const headings: string[] = [];
  for (const m of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const t = htmlToText(m[1] ?? '');
    if (t) headings.push(t);
    if (headings.length >= 12) break;
  }

  const links: Array<{ href: string; text: string }> = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] ?? '').trim();
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
    links.push({ href, text: htmlToText(m[2] ?? '').slice(0, 80) });
    if (links.length >= 20) break;
  }

  return {
    url,
    title,
    description,
    frameworks: detectFrameworks(html),
    headings,
    links,
    textLength: htmlToText(html).length,
  };
}
