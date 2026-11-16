/**
 * A stand-in for Claude Code, for tests of what Spool does only with `claude -p`.
 *
 * It is a shell script named `claude`, which is what makes Spool treat it as the real one, and it
 * speaks lines that were recorded from the real one: the files in `fixtures/claude-stream/`, each
 * one run of Claude Code with what was written to it and what it printed (see docs/claude-stream.md).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from '../src/context.ts';
import { CLI, type Sandbox } from './helpers.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/claude-stream/', import.meta.url));

/** One line of a recording: written to Claude's stdin (`>`), or printed by it on stdout (`<`) or stderr (`!`). */
export interface Recorded {
  dir: '>' | '<' | '!';
  /** The line as it was, with the session it was recorded in written as SESSION. */
  line: string;
  /** The line read as JSON, where it is JSON. */
  event: Record<string, any> | null;
}

/** A recorded run of Claude Code, by the name of its file. */
export function recorded(name: string): Recorded[] {
  const text = fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
  const session = /--(?:session-id|resume) ([0-9a-f-]{36})/.exec(text)?.[1] ?? 'no session in the recording';
  return text
    .split('\n')
    .map((raw) => /^([<>!]) \d+\.\d (.*)$/.exec(raw))
    .filter((found): found is RegExpExecArray => !!found)
    .map((found) => {
      const line = found[2]!.split(session).join('SESSION');
      let event: Recorded['event'] = null;
      try {
        event = JSON.parse(line) as Recorded['event'];
      } catch {
        // Not JSON: a line of stderr.
      }
      return { dir: found[1] as Recorded['dir'], line, event };
    });
}

/** The lines Claude printed in a recording that `pick` wants, as text. */
export function printed(name: string, pick: (event: Record<string, any>) => boolean): string[] {
  return recorded(name)
    .filter((r) => r.dir === '<' && r.event && pick(r.event))
    .map((r) => r.line);
}

export interface StandIn {
  /** The agent command to give Spool. */
  agent: string;
  /** The flags each run of it was started with, oldest first. */
  args: () => string[];
  /** The lines run `n` of it read from its input with `hear`, each as the JSON it is. */
  heard: (n: number) => Record<string, any>[];
  /** The words run `n` of it was started with: its first message. */
  prompt: (n: number) => string;
  /** A file the stand-in wrote beside itself, or nothing if it has not. */
  read: (name: string) => string;
}

/**
 * Write the stand-in. `script` is what it does once started, in shell, with these to hand:
 *
 *   - `$n`, which run of it this is, from 1; `$sid`, the session it was put in; `$resumed`, set where it was told to pick one up;
 *   - `say <part>`, which prints the lines of one of `parts`, in that session;
 *   - `hear`, which waits for the next line written to it and leaves it in `$heard`, or fails once its input is closed.
 *     The first is its prompt: Spool gives a `claude -p` the prompt as a message, and keeps its input open;
 *   - `spool`, the real CLI; and `$here`, a folder of its own to leave files in.
 */
export function claude(s: Sandbox, script: string, parts: Record<string, string[]> = {}): StandIn {
  const here = path.join(s.root, 'claude-bin');
  fs.mkdirSync(here, { recursive: true });
  for (const [name, lines] of Object.entries(parts)) fs.writeFileSync(path.join(here, `${name}.jsonl`), lines.map((l) => `${l}\n`).join(''));
  const file = path.join(here, 'claude');
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      `spool() { "${process.execPath}" "${CLI}" "$@"; }`,
      `here="${here}"`,
      'echo "$*" >> "$here/args.txt"',
      'n=$(wc -l < "$here/args.txt" | tr -d " ")',
      'sid=""; resumed=""; last=""',
      'for arg in "$@"; do',
      '  case "$last" in --session-id) sid="$arg";; --resume) sid="$arg"; resumed=yes;; esac',
      '  last="$arg"',
      'done',
      'say() { sed "s/SESSION/$sid/g" "$here/$1.jsonl"; }',
      'hear() { IFS= read -r heard || return 1; printf "%s\\n" "$heard" >> "$here/heard-$n.jsonl"; }',
      script,
      '',
    ].join('\n'),
  );
  fs.chmodSync(file, 0o755);
  const read = (name: string): string => {
    try {
      return fs.readFileSync(path.join(here, name), 'utf8');
    } catch {
      return '';
    }
  };
  const heard = (n: number): Record<string, any>[] =>
    read(`heard-${n}.jsonl`)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  return {
    agent: `${file} -p`,
    args: () => read('args.txt').trim().split('\n').filter(Boolean),
    heard,
    prompt: (n) => String(heard(n)[0]?.message?.content ?? ''),
    read,
  };
}

/** The world a Runner held by a test is given: the sandbox's folder and home, and the real clock. */
export function engineCtx(s: Sandbox): Ctx {
  return {
    cwd: s.root,
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined, SPOOL_NOTIFY: undefined },
    out: () => {},
    err: () => {},
    now: () => new Date(),
    stdin: () => '',
    lines: () => {},
    color: false,
    inherit: false,
  };
}
