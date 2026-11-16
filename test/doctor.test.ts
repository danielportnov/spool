import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

interface Finding {
  id: string;
  status: 'ok' | 'advice' | 'wrong';
  label: string;
  fix?: string[];
}

const byId = (s: Sandbox, env: Record<string, string> = {}): Record<string, Finding> => {
  const result = s.exec(['doctor', '--json'], { env });
  return Object.fromEntries((JSON.parse(result.out).checks as Finding[]).map((f) => [f.id, f]));
};

/** A stand-in agent: a script that exists and can run. */
function agentScript(s: Sandbox): string {
  s.write('bin/agent.sh', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(s.dir, 'bin', 'agent.sh'), 0o755);
  return path.join(s.dir, 'bin', 'agent.sh');
}

test('a fresh init says what is missing, with the line that fixes each', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo');
  const result = s.exec(['doctor'], { env: { PATH: '' } });
  assert.equal(result.code, 1);
  assert.match(result.out, /^✗ not a git repository: undo and "what changed" need one\n {4}git init && git add -A && git commit/m);
  assert.match(result.out, /^! the build gate is off: .*\n {4}spool init --gate$/m);
  assert.match(result.out, /^! no check: .*\n {4}spool checks "npm test"$/m);
  assert.match(result.out, /^✗ the agent command starts claude, which is not on the PATH \(claude -p\)$/m);
  assert.match(result.out, /^! no notifier: /m);
  assert.match(result.out, /^! the Spool skills are not installed for your agent\n {4}spool install$/m);
  assert.match(result.out, /^✓ Node \d+\./m);
  assert.match(result.out, /\n\n\d+ wrong, \d+ only advice\. Nothing was changed\.$/);
  assert.deepEqual(s.exec(['doctor'], { env: { PATH: '' } }), result, 'asking again changes nothing');
});

test('no spool here is the first thing said', () => {
  const s = new Sandbox();
  const result = s.exec(['doctor']);
  assert.equal(result.code, 1);
  assert.match(result.out, /^✗ no spool here\n {4}spool init$/m);
  assert.doesNotMatch(result.out, /build gate/);
});

test('with a check named, git started and an agent that exists, those lines turn fine', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  s.gitInit();
  s.write('README.md', 'hi\n');
  s.commitAll('First commit');
  s.sp('checks', 'npm test');
  const agent = agentScript(s);
  const found = byId(s, { SPOOL_AGENT: agent, SPOOL_NOTIFY: 'true' });
  for (const id of ['spool', 'git', 'gate', 'check', 'agent', 'builder', 'notify', 'node']) assert.equal(found[id]!.status, 'ok', `${id}: ${found[id]!.label}`);
  assert.match(found.check!.label, /npm test/);
  assert.match(found.agent!.label, /SPOOL_AGENT/);

  const result = s.exec(['doctor'], { env: { SPOOL_AGENT: agent, SPOOL_NOTIFY: 'true' } });
  assert.equal(result.code, 0, 'only advice left, which never fails it');
  assert.match(result.out, /^✓ a git repository with commits$/m);
  assert.match(result.out, /\nNothing a run needs is missing; 1 only advice\.$/);
});

test('a git repository with no commit is not enough', () => {
  const s = new Sandbox();
  s.sp('init');
  s.gitInit();
  assert.match(byId(s).git!.label, /no commit yet/);
  assert.deepEqual(byId(s).git!.fix, ['git add -A && git commit -m "First commit"']);
});

test('an agent command whose program does not exist is reported with its name', () => {
  const s = new Sandbox();
  s.sp('init');
  const result = s.exec(['doctor'], { env: { SPOOL_AGENT: 'no-such-agent-xyz --fast' } });
  assert.equal(result.code, 1);
  assert.match(result.out, /^✗ the agent command starts no-such-agent-xyz, which is not on the PATH \(no-such-agent-xyz --fast\)$/m);
  assert.equal(byId(s, { SPOOL_AGENT: './nope.sh' }).agent!.status, 'wrong', 'a path is looked at where it points');
  // The agent in the user's config is read, the environment winning over it.
  s.write('.home/.config/spool/config.json', JSON.stringify({ agent: 'from-the-config' }));
  assert.match(byId(s).agent!.label, /starts from-the-config/);
  assert.match(byId(s, { SPOOL_AGENT: 'from-the-env' }).agent!.label, /starts from-the-env/);
});

test('claude -p with no permission flags is said to read but not edit, with the config line', () => {
  const s = new Sandbox();
  s.sp('init');
  s.write('bin/claude', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(s.dir, 'bin', 'claude'), 0o755);
  const env = { PATH: path.join(s.dir, 'bin') };
  const bare = byId(s, env).agent!;
  assert.equal(bare.status, 'wrong');
  assert.match(bare.label, /can read but not edit files or commit/);
  assert.match(bare.fix!.join('\n'), /"agent": "claude -p --permission-mode acceptEdits --allowedTools/);
  s.write('.home/.config/spool/config.json', JSON.stringify({ agent: 'claude -p --permission-mode acceptEdits' }));
  assert.equal(byId(s, env).agent!.status, 'ok');
});

test('who builds: a chat with no watch up is advice, headless is fine', () => {
  const s = new Sandbox();
  s.sp('init');
  assert.equal(byId(s).builder!.status, 'ok');
  s.write('.home/.config/spool/config.json', JSON.stringify({ builder: { [s.dir]: 'chat' } }));
  const chat = byId(s).builder!;
  assert.equal(chat.status, 'advice');
  assert.match(chat.label, /no spool watch is up/);
});

test('the skills turn fine once installed, and stale ones are said to be', () => {
  const s = new Sandbox();
  s.sp('init');
  s.sp('install');
  assert.equal(byId(s).skills!.status, 'ok');
  const file = path.join(s.dir, '.home', '.claude', 'skills', 'spool-loop', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/<!-- spool \S+ /, '<!-- spool 0.0.1 '));
  const stale = byId(s).skills!;
  assert.equal(stale.status, 'advice');
  assert.match(stale.label, /older version/);
  assert.deepEqual(stale.fix, ['spool install']);
});

test('--json gives the same as data', () => {
  const s = new Sandbox();
  s.sp('init');
  const result = s.exec(['doctor', '--json'], { env: { SPOOL_AGENT: 'no-such-agent-xyz' } });
  assert.equal(result.code, 1);
  const data = JSON.parse(result.out);
  assert.equal(data.ok, false);
  assert.equal(data.wrong, (data.checks as Finding[]).filter((c) => c.status === 'wrong').length);
  assert.ok(data.checks.every((c: Finding) => ['ok', 'advice', 'wrong'].includes(c.status) && c.label));
  assert.doesNotMatch(result.out, /\x1b/);
});
