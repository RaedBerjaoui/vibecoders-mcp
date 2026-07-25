/** Small helpers for building MCP tool results. */

/**
 * The data-plane redactor (T10). Every tool RESPONSE is returned straight to the
 * model — call_tool JSON.stringifies a downstream result, delegate returns a
 * child's raw stdout, tasks/image/search embed raw child output. Routing the
 * outgoing string of text()/errorText() through this one installable function
 * makes those helpers the single chokepoint that scrubs secrets out of every
 * response built with them. Default is identity (no-op) so nothing changes until
 * a real redactor is installed at boot (src/index.ts), and so the happy path —
 * ordinary non-secret text — is byte-for-byte unchanged.
 */
let responseRedactor: (s: string) => string = (s) => s;

/** Install the response redactor once at boot, from the same secret source the logger uses. */
export function setResponseRedactor(fn: (s: string) => string): void {
  responseRedactor = fn;
}

/** Restore the no-op default (for tests — these helpers are module-global). */
export function resetResponseRedactor(): void {
  responseRedactor = (s) => s;
}

export const text = (s: string) => ({
  content: [{ type: 'text' as const, text: responseRedactor(s) }],
});

export const errorText = (s: string) => ({
  content: [{ type: 'text' as const, text: responseRedactor(s) }],
  isError: true,
});

/** Redact every string leaf while preserving the MCP result's native shape. */
export function redactMcpResult<T>(value: T): T {
  if (typeof value === 'string') return responseRedactor(value) as T;
  if (Array.isArray(value)) return value.map(redactMcpResult) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redactMcpResult(child)]),
    ) as T;
  }
  return value;
}
