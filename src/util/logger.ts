import { makeRedactor } from './redact';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Stderr-only logger. stdout is the MCP protocol channel — logs must NEVER go
 * there. Every argument is passed through the redactor before printing, so a
 * stray secret can't leak into the logs.
 */
export function createLogger(level: Level, secretValues: Iterable<string> = []): Logger {
  const redact = makeRedactor(secretValues);
  const min = ORDER[level];
  const emit = (lvl: Level, args: unknown[]): void => {
    if (ORDER[lvl] < min) return;
    const line = args.map((a) => redact(a)).join(' ');
    process.stderr.write(`[vibecoders] ${lvl.toUpperCase()} ${line}\n`);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}
