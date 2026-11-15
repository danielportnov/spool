/**
 * Frontmatter: a deliberately small YAML subset.
 *
 * Spool writes every file it reads, so it only needs the YAML it emits — flat
 * `key: value` pairs and flow lists — plus enough tolerance to survive a human
 * or an editor such as Obsidian touching a file (block lists, block scalars,
 * quoted strings, keys it has never heard of). Values come back as strings or
 * string lists; typing is the schema's job, not the parser's, which is what
 * keeps a task titled `no` or `2024` from turning into a boolean or a number.
 */

export type FmValue = string | string[];

export interface Frontmatter {
  /** Parsed values, in file order. */
  data: Map<string, FmValue>;
  /** The untouched source lines of each key, so unknown fields round-trip. */
  raw: Map<string, string>;
  body: string;
  /** False when the text had no frontmatter block. */
  found: boolean;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const data = new Map<string, FmValue>();
  const raw = new Map<string, string>();
  const lines = src.split('\n');
  if (lines[0] !== '---') return { data, raw, body: src, found: false };
  const end = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'));
  if (end < 0) return { data, raw, body: src, found: false };

  let i = 1;
  while (i < end) {
    const m = KEY.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1]!;
    const rest = (m[2] ?? '').trim();
    const start = i++;
    while (i < end && continues(lines[i]!, rest)) i++;
    const chunk = lines.slice(start, i);
    while (chunk.length > 1 && chunk[chunk.length - 1]!.trim() === '') chunk.pop();
    raw.set(key, chunk.join('\n'));
    data.set(key, parseValue(rest, chunk.slice(1)));
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { data, raw, body, found: true };
}

/** Does `line` belong to the value that started on the previous key line? */
function continues(line: string, rest: string): boolean {
  if (line === '' || /^[ \t]/.test(line)) return true;
  return rest === '' && /^-(\s|$)/.test(line);
}

function parseValue(rest: string, cont: string[]): FmValue {
  const block = /^([>|])[+\-0-9]*$/.exec(rest);
  if (block) return blockScalar(block[1] === '>', cont);

  const filled = cont.filter((l) => l.trim() !== '');
  if (rest === '') {
    if (filled.length && filled.every((l) => /^\s*-(\s|$)/.test(l))) {
      return filled.map((l) => scalar(l.replace(/^\s*-\s*/, '')));
    }
    // A nested map or something stranger: keep it as opaque text.
    return filled.map((l) => l.trim()).join(' ');
  }

  const joined = [rest, ...filled.map((l) => l.trim())].join(' ');
  if (joined.startsWith('[') && joined.endsWith(']')) return flowList(joined);
  return scalar(joined);
}

function blockScalar(folded: boolean, cont: string[]): string {
  const filled = cont.filter((l) => l.trim() !== '');
  if (!filled.length) return '';
  const indent = Math.min(...filled.map((l) => /^[ \t]*/.exec(l)![0].length));
  const lines = cont.map((l) => l.slice(indent));
  if (!folded) return lines.join('\n').replace(/\s+$/, '');
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const l of lines) {
    if (l.trim() === '') {
      if (current.length) paragraphs.push(current.join(' '));
      current = [];
    } else {
      current.push(l.trim());
    }
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n');
}

function flowList(text: string): string[] {
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  try {
    const parsed: unknown = JSON.parse(`[${inner}]`);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
  } catch {
    // Not JSON — bare tokens like [t-4kq7, d-7hc3]. Split by hand below.
  }
  const out: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => scalar(s)).filter((s) => s !== '');
}

function scalar(text: string): string {
  const s = text.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

// ---------------------------------------------------------------- writing

const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

/** True when `s` reads back as the same string from any YAML parser, unquoted. */
function plainSafe(s: string): boolean {
  if (s === '' || s !== s.trim()) return false;
  if (!/^[A-Za-z0-9_/(.]/.test(s)) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return false;
  if (RESERVED.test(s)) return false;
  if (!Number.isNaN(Number(s))) return false;
  return true;
}

/** A string as a YAML scalar. JSON strings are valid YAML double-quoted scalars. */
export function quote(s: string): string {
  return plainSafe(s) ? s : JSON.stringify(s);
}

/** Identifiers, hashes, names: bare tokens in a flow list. */
export function flowTokens(values: string[]): string {
  return `[${values.map((v) => (/^[A-Za-z0-9_./-]+$/.test(v) ? v : JSON.stringify(v))).join(', ')}]`;
}

/** Free text in a flow list: always quoted, so commas and brackets are safe. */
export function flowStrings(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}
