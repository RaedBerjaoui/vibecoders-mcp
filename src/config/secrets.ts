/**
 * macOS Keychain-backed secret store. Secrets live in the login Keychain —
 * never in the repo, never in a plaintext file we write. On non-macOS or when
 * an entry is absent, reads return `undefined` so callers can fall back to env.
 *
 * Note: `security add-generic-password -w <value>` passes the value as a process
 * argument (briefly visible to `ps`). That's an accepted tradeoff for
 * non-interactive setup; we never persist the value to disk ourselves.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/**
 * Injectable exec seam (mirrors device/tools.ts `ExecRunner`) so the Keychain
 * wrapper is unit-testable with a fake `security` instead of the real binary.
 */
export type ExecRunner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRun: ExecRunner = async (cmd, args) => {
  const { stdout } = await pexec(cmd, args);
  return { stdout: stdout.toString() };
};

/** Keychain service name under which all Vibecoders secrets are grouped. */
export const SERVICE = 'vibecoders-mcp';

export async function keychainGet(
  name: string,
  run: ExecRunner = defaultRun,
): Promise<string | undefined> {
  try {
    const { stdout } = await run('security', [
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      name,
      '-w',
    ]);
    const value = stdout.replace(/\n$/, '');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function keychainSet(name: string, value: string): Promise<void> {
  // -U updates an existing entry instead of erroring on duplicate.
  await pexec('security', [
    'add-generic-password',
    '-s',
    SERVICE,
    '-a',
    name,
    '-w',
    value,
    '-U',
  ]);
}

export async function keychainDelete(name: string): Promise<void> {
  try {
    await pexec('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
  } catch {
    /* absent — nothing to delete */
  }
}
