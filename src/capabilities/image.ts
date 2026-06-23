/**
 * image_gen executors — one per provider option of the image_gen capability.
 *
 *   codex-cli  → codex's BUILT-IN `image_gen` tool (ChatGPT/Codex plan, no API
 *                key). codex 0.140.0-alpha.19+ has a regression (openai/codex
 *                #28898): image_gen DOES generate — the base64 PNG lands in the
 *                `image_generation_end` event of the session rollout JSONL — but
 *                it no longer writes a file or returns a saved_path, and the
 *                agent often masks the failure by cp-ing a STALE prior image.
 *                So we DON'T trust the agent or the filesystem: we run codex
 *                non-ephemerally (so the rollout is persisted), read the session
 *                id from stdout, and decode the base64 straight out of the
 *                rollout ourselves. Retry if the event isn't there.
 *   openai-api → gpt-image-2 via the OpenAI images API (bring-your-own key).
 *   gemini-api → Nano Banana via the Gemini API (bring-your-own key). Gemini's
 *                CLI can't do image gen, which is why this option is API-only.
 *
 * Every executor returns an ImageResult — it never throws on provider trouble.
 */
import { spawn, type spawn as SpawnFn } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CODEX_AUTH_ENV_UNSET } from '../providers/registry';
import { buildChildEnv, type ChildEnvMode } from '../util/childEnv';
import { loadVibeConfig, delegationEnvMode } from './config';

// Re-exported so image-gen's codex env-stripping shares ONE source of truth with the
// codex delegate provider — adding a var to the provider registry can't silently miss
// image-gen (which would keep billing the OpenAI API instead of the ChatGPT plan).
export { CODEX_AUTH_ENV_UNSET };

export interface ImageRequest {
  prompt: string;
  /** Absolute path to write the final PNG to. */
  outPath: string;
  /** Provider-specific size hint (e.g. '1024x1024'); ignored by codex. */
  size?: string;
  /** Override the provider's default model. */
  model?: string;
}

export interface ImageResult {
  ok: boolean;
  /** On success: a short note incl. the saved path. On failure: an actionable hint. */
  message: string;
  /** The saved file path, on success. */
  path?: string;
}

export type ProviderId = 'codex-cli' | 'openai-api' | 'gemini-api';

/** Secret lookup + injectable fetch/clock so executors stay unit-testable. */
export interface ImageDeps {
  getSecret(key: string): string | undefined;
  fetchImpl?: typeof fetch;
  codex?: CodexImageOptions;
  /** Test seam: override an executor entirely. */
  executors?: Partial<Record<ProviderId, (req: ImageRequest, deps: ImageDeps) => Promise<ImageResult>>>;
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// codex-cli — built-in image_gen tool, with self-verification + retry.
// ---------------------------------------------------------------------------

/** Match codex's pacing — it serialises image jobs with a cooldown. */
export const CODEX_IMAGE_COOLDOWN_MS = 15_000;
let codexLastImageEndedAt = 0;

export interface CodexImageOptions {
  command?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Dir codex persists session rollouts to ($CODEX_HOME/sessions). */
  sessionsDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnImpl?: typeof SpawnFn;
  /** Env-inheritance mode; omit to honor `delegation.envMode` (default 'minimal'). */
  envMode?: ChildEnvMode;
}

function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'sessions');
}

/** Find the rollout JSONL whose filename embeds this session id (recursive). */
export function findRollout(sessionsDir: string, sessionId: string): string | undefined {
  let found: string | undefined;
  const walk = (d: string): void => {
    if (found) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.includes(sessionId) && e.name.endsWith('.jsonl')) found = full;
    }
  };
  walk(sessionsDir);
  return found;
}

/**
 * Decode the LAST `image_generation_end` base64 PNG from a codex rollout JSONL.
 * This is where the generated image actually lives under the #28898 regression.
 */
export function extractImageFromRollout(rolloutPath: string): Buffer | undefined {
  let content: string;
  try {
    content = readFileSync(rolloutPath, 'utf8');
  } catch {
    return undefined;
  }
  let b64: string | undefined;
  for (const line of content.split('\n')) {
    if (!line.includes('image_generation_end')) continue;
    let o: { payload?: { type?: string; result?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload;
    if (p?.type === 'image_generation_end' && typeof p.result === 'string' && p.result.length > 0) {
      b64 = p.result; // keep the last image of the run
    }
  }
  return b64 ? Buffer.from(b64, 'base64') : undefined;
}

function codexPrompt(req: ImageRequest): string {
  return [
    `Use your built-in image_gen tool to generate ONE image. Do NOT write code. Do NOT generate variations.`,
    ``,
    `Image description: ${req.prompt}`,
    ``,
    `When image_gen has produced the image, output exactly: IMAGEGEN_DONE`,
  ].join('\n');
}

/** Pull the codex session id out of its stdout banner. */
export function parseSessionId(out: string): string | undefined {
  return out.match(/session id:\s*([0-9a-fA-F-]{36})/)?.[1];
}

function runCodexOnce(
  prompt: string,
  o: Required<Pick<CodexImageOptions, 'command' | 'timeoutMs'>>,
  spawnImpl: typeof SpawnFn,
  envMode: ChildEnvMode,
): Promise<{ code: number | null; out: string }> {
  // NB: no --ephemeral — we need the session rollout persisted so we can decode
  // the generated image out of it (the file/saved_path is broken upstream).
  const argv = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write'];
  // Build the child env from the secure allowlist (minimal mode drops unrelated
  // secrets) and STRIP the shared API-cred list so codex bills the ChatGPT/Codex
  // plan (OAuth via ~/.codex/auth.json under $HOME), not the metered API. Allow
  // CODEX_HOME through so the child resolves the same session dir we read from.
  // Uses the SAME shared unset-list as the codex delegate provider so the two
  // can never drift — adding a var there closes the leak here too.
  const env = buildChildEnv({
    mode: envMode,
    allow: ['CODEX_HOME'],
    unset: CODEX_AUTH_ENV_UNSET,
  });

  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawnImpl(o.command, argv, { env });
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
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export async function generateViaCodex(
  req: ImageRequest,
  o: CodexImageOptions = {},
): Promise<ImageResult> {
  const command = o.command ?? process.env.VIBECODERS_CODEX_CMD ?? 'codex';
  const timeoutMs = o.timeoutMs ?? 180_000;
  const maxAttempts = o.maxAttempts ?? 3;
  const sessionsDir = o.sessionsDir ?? codexSessionsDir();
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const spawnImpl = o.spawnImpl ?? spawn;
  const envMode = o.envMode ?? delegationEnvMode(loadVibeConfig());
  const prompt = codexPrompt(req);

  ensureDir(req.outPath);
  let lastDetail = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Respect codex's image cooldown so back-to-back jobs don't get dropped.
    const wait = codexLastImageEndedAt + CODEX_IMAGE_COOLDOWN_MS - now();
    if (wait > 0) await sleep(wait);

    const { code, out } = await runCodexOnce(prompt, { command, timeoutMs }, spawnImpl, envMode);
    codexLastImageEndedAt = now();
    lastDetail = out.trim().slice(-300);

    // The real proof of a generation is the base64 PNG in the session rollout —
    // not the agent's word and not a file on disk (both unreliable upstream).
    const sessionId = parseSessionId(out);
    if (sessionId) {
      const rollout = findRollout(sessionsDir, sessionId);
      const img = rollout ? extractImageFromRollout(rollout) : undefined;
      if (img && img.length > 0) {
        writeFileSync(req.outPath, img);
        return { ok: true, message: `Saved generated image to ${req.outPath}`, path: req.outPath };
      }
    }
    if (code === null) lastDetail = `codex timed out after ${timeoutMs}ms`;
    // else: no image_generation_end event this run — retry.
  }
  return {
    ok: false,
    message:
      `codex image_gen produced no image after ${maxAttempts} attempts. ` +
      `Ensure the \`codex\` CLI is signed into a ChatGPT/Codex plan (image_gen needs it). ` +
      `Last output: ${lastDetail || '(none)'}`,
  };
}

// ---------------------------------------------------------------------------
// openai-api — gpt-image-2 (bring-your-own key).
// ---------------------------------------------------------------------------

export async function generateViaOpenAI(req: ImageRequest, deps: ImageDeps): Promise<ImageResult> {
  const key = deps.getSecret('OPENAI_API_KEY');
  if (!key) {
    return { ok: false, message: 'OPENAI_API_KEY is not set (`vibecoders vault set OPENAI_API_KEY`).' };
  }
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // gpt-image-2 (ChatGPT Images 2.0, Apr 2026) — current flagship; the
        // same backend codex's built-in image_gen tool uses. Override via model.
        model: req.model ?? 'gpt-image-2',
        prompt: req.prompt,
        size: req.size ?? '1024x1024',
        n: 1,
      }),
    });
    if (!res.ok) {
      return { ok: false, message: `OpenAI image API error ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const j = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) return { ok: false, message: 'OpenAI returned no image data.' };
    ensureDir(req.outPath);
    writeFileSync(req.outPath, Buffer.from(b64, 'base64'));
    return { ok: true, message: `Saved generated image to ${req.outPath}`, path: req.outPath };
  } catch (e) {
    return { ok: false, message: `OpenAI image request failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// gemini-api — Nano Banana via generateContent (bring-your-own key).
// Gemini's CLI can't do image gen, which is why this option is API-only. The
// current native image models (gemini-3-pro-image "Nano Banana Pro",
// gemini-3.1-flash-image, gemini-2.5-flash-image) return an inline image part
// from generateContent — NOT the older Imagen `:predict` endpoint.
// ---------------------------------------------------------------------------

export async function generateViaGemini(req: ImageRequest, deps: ImageDeps): Promise<ImageResult> {
  const key = deps.getSecret('GEMINI_API_KEY');
  if (!key) {
    return { ok: false, message: 'GEMINI_API_KEY is not set (`vibecoders vault set GEMINI_API_KEY`).' };
  }
  const f = deps.fetchImpl ?? fetch;
  const model = req.model ?? 'gemini-3-pro-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: req.prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    });
    if (!res.ok) {
      return { ok: false, message: `Gemini image API error ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const j = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
    };
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const b64 = parts.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!b64) return { ok: false, message: 'Gemini returned no image data.' };
    ensureDir(req.outPath);
    writeFileSync(req.outPath, Buffer.from(b64, 'base64'));
    return { ok: true, message: `Saved generated image to ${req.outPath}`, path: req.outPath };
  } catch (e) {
    return { ok: false, message: `Gemini image request failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Dispatch by resolved provider id.
// ---------------------------------------------------------------------------

export async function runImageGen(
  providerId: ProviderId,
  req: ImageRequest,
  deps: ImageDeps,
): Promise<ImageResult> {
  const override = deps.executors?.[providerId];
  if (override) return override(req, deps);
  switch (providerId) {
    case 'codex-cli':
      return generateViaCodex(req, deps.codex);
    case 'openai-api':
      return generateViaOpenAI(req, deps);
    case 'gemini-api':
      return generateViaGemini(req, deps);
    default:
      return { ok: false, message: `No image executor for provider "${providerId}".` };
  }
}
