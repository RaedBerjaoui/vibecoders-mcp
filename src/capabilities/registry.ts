/**
 * The built-in capability catalogue. Each entry is GENERIC — it ships as code
 * with several provider OPTIONS, and stays inert until a user configures one of
 * them locally. Add capabilities here as they are ported (web_search, memory,
 * Apple/macOS, …); each is just data + (elsewhere) the tool that runs it.
 */
import type { CapabilityDef } from './types';
import { secretSetupHint } from './types';

/**
 * Image generation. The user's headline example: configure ONE of three
 * options. The CLI route bills a subscription (no API key); the API routes are
 * bring-your-own-key. Gemini is API-only on purpose — its CLI does not expose
 * image generation, which is exactly why a capability needs multiple options.
 */
export const IMAGE_GEN: CapabilityDef = {
  id: 'image_gen',
  label: 'Image generation',
  summary: 'Generate an image from a text prompt and save it to a file.',
  providers: [
    {
      id: 'codex-cli',
      label: 'OpenAI Codex CLI',
      requires: [{ kind: 'cli', command: 'codex' }],
      setupHint:
        'install the `codex` CLI and sign in — bills your ChatGPT/Codex plan, no API key',
    },
    {
      id: 'openai-api',
      label: 'OpenAI API (gpt-image-2)',
      requires: [{ kind: 'secret', key: 'OPENAI_API_KEY' }],
      setupHint: secretSetupHint('OPENAI_API_KEY'),
    },
    {
      id: 'gemini-api',
      label: 'Google Gemini API (Nano Banana)',
      requires: [{ kind: 'secret', key: 'GEMINI_API_KEY' }],
      setupHint: secretSetupHint('GEMINI_API_KEY'),
    },
  ],
};

/**
 * Web search. Four options, CLI-first like image_gen: the `gemini` CLI bills an
 * OAuth plan with no key (this is the same Google-grounded search Pioneer's lone
 * web_search exposes — here it is one of four). The API routes are
 * bring-your-own-key: Gemini grounding, Brave, or Tavily (which also synthesizes
 * an answer). Configuring ANY one turns the whole capability on.
 */
export const WEB_SEARCH: CapabilityDef = {
  id: 'web_search',
  label: 'Web search',
  summary: 'Search the web for a query and return ranked results (and, when available, a synthesized answer).',
  providers: [
    {
      id: 'gemini-cli',
      label: 'Gemini CLI (GoogleSearch)',
      requires: [{ kind: 'cli', command: 'gemini' }],
      setupHint: 'install the `gemini` CLI and sign in — bills your Google/Gemini plan, no API key',
    },
    {
      id: 'gemini-api',
      label: 'Google Gemini API (grounding)',
      requires: [{ kind: 'secret', key: 'GEMINI_API_KEY' }],
      setupHint: secretSetupHint('GEMINI_API_KEY'),
    },
    {
      id: 'brave-api',
      label: 'Brave Search API',
      requires: [{ kind: 'secret', key: 'BRAVE_API_KEY' }],
      setupHint: secretSetupHint('BRAVE_API_KEY'),
    },
    {
      id: 'tavily-api',
      label: 'Tavily Search API',
      requires: [{ kind: 'secret', key: 'TAVILY_API_KEY' }],
      setupHint: secretSetupHint('TAVILY_API_KEY'),
    },
  ],
};

export const CAPABILITIES: CapabilityDef[] = [IMAGE_GEN, WEB_SEARCH];

export function getCapability(id: string, caps = CAPABILITIES): CapabilityDef | undefined {
  return caps.find((c) => c.id === id);
}
