/**
 * MCP tools for capabilities. Each capability resolves a provider at call time
 * and fails CLOSED: if nothing is configured, the tool returns the "set up one
 * of: …" hint instead of erroring vaguely. Today this exposes image_gen; future
 * capabilities (web_search, memory, …) register their tools here too.
 */
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import { getCapability } from './registry';
import { resolveCapability, isProviderConfigured, unconfiguredMessage } from './types';
import { detectContext } from './matrix';
import { loadVibeConfig, pinnedProvider } from './config';
import { runImageGen, type ProviderId } from './image';
import { runWebSearch, type SearchProviderId, type SearchResult } from './search';

/**
 * @param getSecret resolve a secret VALUE (Keychain/env) — used both to detect
 *   which providers are configured and to authenticate the API ones.
 */
export function registerCapabilities(
  server: McpServer,
  getSecret: (key: string) => string | undefined,
  log: Logger,
): Record<string, RegisteredTool> {
  const hasSecret = (key: string): boolean => Boolean(getSecret(key));

  const generateImage = server.registerTool(
    'generate_image',
    {
      description:
        'Generate an image from a text prompt and save it to an absolute file path. ' +
        'Uses your configured image_gen provider (codex CLI on your ChatGPT plan — no API key — ' +
        'or OpenAI/Gemini with your own key). If none is set up, it tells you how to enable one. ' +
        'Pass an absolute out_path; the saved file path is returned.',
      inputSchema: {
        prompt: z.string().describe('natural-language description of the image to generate'),
        out_path: z.string().describe('ABSOLUTE file path to save the PNG to'),
        size: z.string().optional().describe('size hint for API providers, e.g. 1024x1024'),
        model: z.string().optional().describe('override the provider default model'),
        provider: z
          .enum(['codex-cli', 'openai-api', 'gemini-api'])
          .optional()
          .describe('force a specific provider instead of auto-resolving'),
      },
      // Writes a file (not read-only) but only creates the target PNG (not
      // destructive); reaches an external model/service (open-world).
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, out_path, size, model, provider }) => {
      const cap = getCapability('image_gen');
      if (!cap) return errorText('image_gen capability is not registered.');
      if (!isAbsolute(out_path)) return errorText('out_path must be an absolute path.');

      const ctx = detectContext(hasSecret);
      if (provider) {
        const opt = cap.providers.find((p) => p.id === provider);
        if (!opt) return errorText(`Unknown provider "${provider}".`);
        if (!isProviderConfigured(opt, ctx)) {
          return errorText(`Provider "${provider}" is not configured — ${opt.setupHint}.`);
        }
      }

      const cfg = loadVibeConfig();
      const res = resolveCapability(cap, ctx, provider ?? pinnedProvider(cfg, 'image_gen'));
      if (res.status === 'unconfigured') return errorText(unconfiguredMessage(cap));

      log.info(`generate_image → ${res.provider.id}`);
      const r = await runImageGen(
        res.provider.id as ProviderId,
        { prompt, outPath: out_path, size, model },
        { getSecret },
      );
      return r.ok ? text(`${r.message} (via ${res.provider.label})`) : errorText(r.message);
    },
  );

  const webSearch = server.registerTool(
    'web_search',
    {
      description:
        'Search the web for a query and return ranked results (and a synthesized answer when the ' +
        'provider offers one). Uses your configured web_search provider (gemini CLI on your Google ' +
        'plan — no API key — or Gemini/Brave/Tavily with your own key). If none is set up, it tells ' +
        'you how to enable one.',
      inputSchema: {
        query: z.string().describe('the search query'),
        count: z.coerce.number().int().positive().optional().describe('max results to return (default 5)'),
        model: z.string().optional().describe('override the provider default model (gemini routes only)'),
        provider: z
          .enum(['gemini-cli', 'gemini-api', 'brave-api', 'tavily-api'])
          .optional()
          .describe('force a specific provider instead of auto-resolving'),
      },
      // Read-only (returns results, changes nothing) but hits the live web (open-world).
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, count, model, provider }) => {
      const cap = getCapability('web_search');
      if (!cap) return errorText('web_search capability is not registered.');

      const ctx = detectContext(hasSecret);
      if (provider) {
        const opt = cap.providers.find((p) => p.id === provider);
        if (!opt) return errorText(`Unknown provider "${provider}".`);
        if (!isProviderConfigured(opt, ctx)) {
          return errorText(`Provider "${provider}" is not configured — ${opt.setupHint}.`);
        }
      }

      const cfg = loadVibeConfig();
      const res = resolveCapability(cap, ctx, provider ?? pinnedProvider(cfg, 'web_search'));
      if (res.status === 'unconfigured') return errorText(unconfiguredMessage(cap));

      log.info(`web_search → ${res.provider.id}`);
      const r = await runWebSearch(res.provider.id as SearchProviderId, { query, count, model }, { getSecret });
      return r.ok ? text(formatSearch(r, res.provider.label)) : errorText(r.message);
    },
  );

  // Returned so the host-adaptation pass (src/host/adapt.ts) can hide/reframe
  // these tools in the initialize handler, before the client's first tools/list.
  return { generate_image: generateImage, web_search: webSearch };
}

/** Render a SearchResult as readable text: optional answer, then a numbered list. */
function formatSearch(r: SearchResult, providerLabel: string): string {
  const lines: string[] = [`${r.message} (via ${providerLabel})`];
  if (r.answer) lines.push('', r.answer);
  const hits = r.hits ?? [];
  if (hits.length > 0) {
    lines.push('');
    hits.forEach((h, i) => {
      lines.push(`${i + 1}. ${h.title || h.url}`, `   ${h.url}`);
      if (h.snippet) lines.push(`   ${h.snippet}`);
    });
  }
  return lines.join('\n');
}
