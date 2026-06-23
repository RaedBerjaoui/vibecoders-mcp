import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../util/logger';
import { text, errorText } from '../util/mcp';
import { fetchGuarded } from './fetch';
import { extractSignal, htmlToText, excerptAround } from './extract';
import type { ReferenceGuardConfig } from './guard';

export interface ReferenceDeps {
  config: ReferenceGuardConfig;
  timeoutMs?: number;
  log: Logger;
}

/**
 * Register the reference (URL-study) tools: understand a page's technique, or
 * pull a focused text excerpt. SSRF-guarded, size-capped, fail-closed. Use these
 * to LEARN from a reference, not to clone it.
 */
export function registerReference(server: McpServer, deps: ReferenceDeps): void {
  const { config, log } = deps;
  const timeoutMs = deps.timeoutMs ?? 15_000;

  server.registerTool(
    'reference_inspect',
    {
      description:
        `Study a web page's technique: title, description, detected frameworks/libraries, ` +
        `headings, and top links. Fetches the live page (SSRF-guarded, size-capped). ` +
        `Use to understand how a reference is built — not to copy it.`,
      inputSchema: { url: z.string().url() },
    },
    async (input) => {
      try {
        const res = await fetchGuarded(input.url, config, { timeoutMs });
        const sig = extractSignal(res.body, res.url);
        return text(
          [
            `# ${sig.title || '(untitled)'} — ${sig.url}`,
            `status ${res.status} · ${res.contentType || 'unknown type'}${res.truncated ? ' · (truncated)' : ''}`,
            sig.description ? `\n${sig.description}` : '',
            sig.frameworks.length ? `\nFrameworks/libs: ${sig.frameworks.join(', ')}` : '\nFrameworks/libs: (none detected)',
            sig.headings.length ? `\nHeadings:\n${sig.headings.map((h) => `- ${h}`).join('\n')}` : '',
            sig.links.length ? `\nLinks:\n${sig.links.map((l) => `- ${l.text || '(link)'} → ${l.href}`).join('\n')}` : '',
            `\n(${sig.textLength} chars of text on the page)`,
          ].filter(Boolean).join('\n'),
        );
      } catch (e) {
        log.warn(`[reference_inspect] ${(e as Error).message}`);
        return errorText(`Could not inspect ${input.url}: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'reference_excerpt',
    {
      description:
        `Fetch a page and return a focused plain-text excerpt — around \`query\` if given, ` +
        `otherwise the head. SSRF-guarded and capped. For reading a specific passage.`,
      inputSchema: {
        url: z.string().url(),
        query: z.string().optional().describe('Center the excerpt on this phrase, if present.'),
        radius: z.number().int().min(100).max(4000).optional().describe('Chars of context each side (default 800).'),
      },
    },
    async (input) => {
      try {
        const res = await fetchGuarded(input.url, config, { timeoutMs });
        const body = htmlToText(res.body);
        const excerpt = excerptAround(body, input.query, input.radius ?? 800);
        return text(`# Excerpt — ${res.url}${input.query ? ` (around "${input.query}")` : ''}\n\n${excerpt}`);
      } catch (e) {
        log.warn(`[reference_excerpt] ${(e as Error).message}`);
        return errorText(`Could not excerpt ${input.url}: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'reference_read_source',
    {
      description:
        'Fetch and return the FULL source of a page (HTML/text), SSRF-guarded and capped. ' +
        'The escape hatch when inspect/excerpt are not enough — requires a `reason`.',
      inputSchema: {
        url: z.string().url(),
        reason: z.string().min(1).describe('Why the full source is needed (required).'),
      },
    },
    async (input) => {
      try {
        const res = await fetchGuarded(input.url, config, { timeoutMs });
        log.info(`[reference_read_source] ${input.url} — ${input.reason}`);
        const note = res.truncated ? ' (truncated at cap)' : '';
        return text(`# Source — ${res.url} (${res.status} ${res.contentType || 'unknown type'})${note}\n\n${res.body}`);
      } catch (e) {
        log.warn(`[reference_read_source] ${(e as Error).message}`);
        return errorText(`Could not read ${input.url}: ${(e as Error).message}`);
      }
    },
  );
}
