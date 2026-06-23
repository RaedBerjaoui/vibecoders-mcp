/**
 * Run a delegation provider's CLI non-interactively and capture its output.
 * Uses spawn (never a shell) so the prompt — passed via stdin or a single argv
 * entry — can't be interpreted as shell. Always resolves to a result object;
 * it never throws on a misbehaving downstream CLI.
 *
 * The child env is adjusted per provider so each CLI authenticates via its own
 * subscription/OAuth (API-key vars stripped). On timeout the child is killed.
 *
 * `startDelegate` is the low-level form: it spawns the child and returns it
 * (for live management — steer/interrupt by the task registry) alongside a
 * `done` promise and a `peek()` for streamed output. `runDelegate` is the
 * fire-and-await convenience wrapper used by the synchronous `delegate` tool.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegateMode, ProviderDef } from './registry';
import { buildChildEnv, type ChildEnvMode } from '../util/childEnv';
import { loadVibeConfig, delegationEnvMode } from '../capabilities/config';

/** Default wall-clock budget for a single delegated call (ms). */
export const DEFAULT_DELEGATE_TIMEOUT_MS = 600_000;

export interface DelegateOptions {
  mode?: DelegateMode;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Env-inheritance mode for the spawned CLI. Omit to honor the user config
   * (`delegation.envMode`, default 'minimal' — drops unrelated secrets). Threaded
   * through DelegateOptions so the background-task path inherits it unchanged.
   */
  envMode?: ChildEnvMode;
}

export interface DelegateResult {
  ok: boolean;
  /** clean answer on success; an actionable error string on failure. */
  output: string;
}

export interface StartedDelegate {
  /** The live child — used to steer (stdin) or interrupt (kill) a background task. */
  child: ChildProcess;
  /** Resolves once the child settles (success, failure, or timeout). Never rejects. */
  done: Promise<DelegateResult>;
  /** Live-accumulated stdout (+ stderr) so far, for background progress peeks. */
  peek: () => string;
}

/**
 * Spawn a delegate and return the live child + a settle promise. The child is
 * spawned synchronously before returning so callers can manage it immediately.
 */
export function startDelegate(
  def: ProviderDef,
  prompt: string,
  opts: DelegateOptions = {},
  spawnFn: typeof spawn = spawn,
): StartedDelegate {
  const timeout = opts.timeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS;
  const mode = opts.mode ?? 'read';

  // A temp file for providers that write their final message to disk.
  let tmpDir: string | undefined;
  let outFile: string | undefined;
  if (def.readsOutputFromFile) {
    tmpDir = mkdtempSync(join(tmpdir(), 'vibecoders-'));
    outFile = join(tmpDir, 'out.txt');
  }

  const argv = def.args({ prompt, mode, model: opts.model, cwd: opts.cwd, outFile });

  // Build the child env from the secure allowlist (or full inheritance if the
  // operator opted in). Delegation CLIs authenticate via files under $HOME, so
  // they need nothing beyond the base allowlist — `allow` stays empty here.
  // `unset` carries the provider's strip list (e.g. codex/claude API-key removal
  // so the CLI bills the subscription/OAuth, not a metered API).
  const envMode = opts.envMode ?? delegationEnvMode(loadVibeConfig());
  const childEnv = buildChildEnv({ mode: envMode, unset: def.env?.unset ?? [] });
  // Provider-forced vars (e.g. Gemini's GOOGLE_GENAI_USE_GCA) go on top in BOTH
  // modes — they're set BY us, not inherited, so they're safe to apply last.
  Object.assign(childEnv, def.env?.set ?? {});

  let out = '';
  let err = '';

  const child = spawnFn(def.command, argv, { cwd: opts.cwd, env: childEnv });

  const done = new Promise<DelegateResult>((resolve) => {
    let settled = false;

    const cleanup = (): void => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    };
    const finish = (r: DelegateResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, output: `${def.label} timed out after ${timeout}ms` });
    }, timeout);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        output:
          e.code === 'ENOENT'
            ? `${def.label} CLI "${def.command}" is not installed.`
            : `${def.label} failed: ${e.message}`,
      });
    });

    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      err += d;
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = (err || out).trim().slice(0, 4000);
        finish({ ok: false, output: `${def.label} failed (exit ${code}): ${detail}` });
        return;
      }
      let answer = '';
      if (def.readsOutputFromFile && outFile) {
        try {
          answer = readFileSync(outFile, 'utf8').trim();
        } catch {
          /* fall back to stdout below */
        }
      }
      if (!answer) answer = def.parseStdout ? def.parseStdout(out) : out.trim();
      finish({ ok: true, output: answer });
    });

    if (def.promptVia === 'stdin') {
      child.stdin?.write(prompt);
    }
    child.stdin?.end();
  });

  return { child, done, peek: () => (err ? `${out}\n${err}` : out) };
}

export function runDelegate(
  def: ProviderDef,
  prompt: string,
  opts: DelegateOptions = {},
): Promise<DelegateResult> {
  return startDelegate(def, prompt, opts).done;
}
