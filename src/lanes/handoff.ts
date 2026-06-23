import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Lane } from './lane';

export interface HandoffInput {
  goal?: string;
  state?: string;
  decisions?: string;
  nextAction?: string;
}

/** Root for all Vibecoders state. Overridable for tests via VIBECODERS_HOME. */
function baseDir(): string {
  return process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
}

function laneDir(lane: Lane): string {
  return join(baseDir(), 'lanes', lane.id);
}

/** Absolute path to this lane's handoff file (whether or not it exists yet). */
export function handoffPath(lane: Lane): string {
  return join(laneDir(lane), 'handoff.md');
}

const field = (label: string, value?: string): string =>
  `## ${label}\n${value?.trim() || '_(none)_'}\n`;

export function writeHandoff(lane: Lane, input: HandoffInput, now: string): string {
  const dir = laneDir(lane);
  mkdirSync(dir, { recursive: true });
  const md = [
    `# Handoff — ${lane.label}`,
    `\n_lane ${lane.id} · ${lane.cwd} · updated ${now}_\n`,
    field('Goal', input.goal),
    field('State', input.state),
    field('Decisions / constraints', input.decisions),
    field('Next action', input.nextAction),
  ].join('\n');
  const file = handoffPath(lane);
  writeFileSync(file, md, 'utf8');
  return file;
}

export function readHandoff(lane: Lane): string | undefined {
  const file = handoffPath(lane);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}
