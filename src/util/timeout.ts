/**
 * Race a promise against a wall-clock deadline. On timeout the returned promise
 * rejects with a clear, labelled error; the timer is always cleared so it can't
 * keep the event loop alive. Used to stop a hung or malicious downstream MCP
 * server from blocking the gateway forever.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Don't let the timer itself keep the process alive.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
