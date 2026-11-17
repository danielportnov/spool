import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leaning, pickFor, stepUp } from '../src/agent.ts';
import type { Item } from '../src/model.ts';
import { Sandbox, startPage } from './helpers.ts';

/** A git project built by chats, with one small thread in Build. */
function chatProject(): { s: Sandbox; small: string } {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.gitInit();
  s.write('.gitignore', '.home/\n');
  s.commitAll('start');
  s.sp('builder', 'chat');
  const small = s.id('task', 'Tidy the score screen', '--size', 's');
  s.sp('build', small);
  return { s, small };
}

/** The MODEL line a chat signed as `as` would be given for the next thread. */
const modelFor = (s: Sandbox, as: string): string => s.json('next', '--as', as).model.model;

test('each agent slides from usage to development on its own, and the brief names the model its slider gives', () => {
  const { s, small } = chatProject();
  try {
    // Balanced to start with: what each brand has always given a small thread.
    assert.equal(modelFor(s, 'Claude Opus 5.5'), 'sonnet');
    assert.equal(modelFor(s, 'Codex GPT-6'), 'gpt-6.1-terra');
    // At usage, Claude's small threads go to Haiku; Codex's are not moved.
    assert.match(s.sp('builder', '--agent', 'Claude', '--lean', 'usage'), /\n {2}Claude, leaning usage: xs haiku, s haiku, m sonnet, l opus, xl opus·high/);
    assert.equal(modelFor(s, 'Claude Opus 5.5'), 'haiku');
    assert.equal(modelFor(s, 'Codex GPT-6'), 'gpt-6.1-terra');
    // Slid to development, the same thread goes to a bigger model.
    s.sp('builder', '--agent', 'Claude', '--lean', 'dev');
    assert.equal(modelFor(s, 'Claude Opus 5.5'), 'opus');
    // Codex's slider moves Codex's ladder: Luna at usage, Sol at development.
    s.sp('builder', '--agent', 'Codex', '--lean', 'usage');
    assert.equal(modelFor(s, 'Codex GPT-6'), 'gpt-6-luna');
    s.sp('builder', '--agent', 'Codex', '--lean', 'development');
    assert.equal(modelFor(s, 'Codex GPT-6'), 'gpt-6.1-sol');
    assert.match(s.sp('status'), /Claude 3 at once, leaning development, not watching · Codex 3 at once, leaning development/);
    // The thread's own Model still wins.
    s.sp('edit', small, '--model', 'haiku');
    assert.equal(modelFor(s, 'Claude Opus 5.5'), 'haiku');
    // The claim says it, for the chat to start its subagent on.
    s.sp('edit', small, '--model', 'none');
    s.sp('builder', '--agent', 'Claude', '--lean', 'usage');
    assert.match(s.sp('next', '--claim', '--as', 'Claude Opus 5.5'), /MODEL — haiku · medium, by its size/);
    assert.match(s.fails('builder', '--agent', 'Claude', '--lean', 'reckless'), /"reckless" is not a lean/);
    assert.match(s.fails('builder', '--lean', 'usage'), /--lean goes with --agent/);
  } finally {
    s.cleanup();
  }
});

test('the user’s own table by size stays as they set it; Codex steps up its own ladder; Fable’s cap still applies on top', () => {
  const thread = (size: string, log: string[] = []): Item => {
    const lines = log.map((what, i) => `- 2026-01-01 00:${String(i).padStart(2, '0')}Z page: ${what}`);
    return { size, body: `Do it.\n\n## Log\n${lines.join('\n')}` } as unknown as Item;
  };
  const usage = leaning({ s: { model: 'opus' } }, 'Claude', 'usage');
  assert.equal(pickFor(thread('s'), usage).model, 'opus', 'a size set by hand is kept');
  assert.equal(pickFor(thread('xs'), usage).model, 'haiku');
  assert.equal(leaning(false, 'Claude', 'usage'), false, 'no suggestion stays no suggestion');
  const codex = leaning(undefined, 'Codex', 'usage');
  const up = stepUp(thread('s', ['builder model: gpt-6-luna · medium, by its size', 'agent exited 1 without finishing']), codex);
  assert.equal(up?.model, 'gpt-6.1-terra');
  const dev = leaning(undefined, 'Claude', 'development');
  assert.equal(pickFor(thread('xl'), dev).model, 'fable');
  assert.equal(pickFor(thread('xl'), dev, undefined, 95).model, 'opus', 'Fable at its cap goes to Opus');
});

test('the board shows each agent’s slider and what each size gets, and the slider is set from the page', async () => {
  const { s, small } = chatProject();
  const page = await startPage(s);
  try {
    const board = async (): Promise<any> => (await fetch(`${page.url}api/board`)).json();
    const claude = (await board()).runner.agents[0];
    assert.equal(claude.lean, 'balanced');
    assert.deepEqual(claude.table[1], { size: 's', model: 'sonnet', effort: 'medium' });
    const res = await fetch(`${page.url}api/roster`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify({ agent: 'Claude', lean: 'usage' }) });
    assert.match(((await res.json()) as any).text, /Claude saves usage/);
    const now = await board();
    assert.equal(now.runner.agents[0].lean, 'usage');
    assert.equal(now.runner.agents[0].table[1].model, 'haiku');
    assert.equal(now.runner.agents[1].lean, 'balanced');
    // The card's own model box says what leaving it gives: Haiku now.
    const card = Object.values(now.columns).flat().find((c: any) => c.id === small) as any;
    assert.equal(card.suggest.model, 'haiku');
    const bad = await fetch(`${page.url}api/roster`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify({ agent: 'Claude', lean: 'wild' }) });
    assert.equal(bad.status, 400);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
