/**
 * One "needs you" count everywhere: the brief's headline, a project's row on All projects, the
 * switcher's menu and the browser tab all say the number the server works out for each project.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

type Board = Record<string, any>;

test('a question and two agents that exited are three things that need you, wherever it is counted', async (t) => {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  const tips = s.cd('tips');
  tips.sp('init', '--name', 'tips');
  const asked = tips.id('task', 'Round the tip');
  tips.sp('ask', 'Up or to the nearest?', '--option', 'Up', '--option', 'Nearest', '--for', asked);
  const left = ['Split by three', 'Remember the last tip'].map((title) => tips.id('task', title));
  for (const id of left) tips.sp('build', id);

  // A stand-in agent that leaves at once without finishing: each thread it was given waits on him.
  const agent = path.join(s.root, '.home', 'leaves.sh');
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, '#!/bin/sh\ncat > /dev/null\nexit 0\n');
  fs.chmodSync(agent, 0o755);

  const page = await startPage(s, '--run', '--agent', agent);
  let browser: Browser | undefined;
  try {
    const board = async (query: string): Promise<Board> => (await (await fetch(`${page.url}api/board?${query}`)).json()) as Board;
    await until('both agents have left', () => left.every((id) => /without finishing/.test(tips.item(id))));

    const home = await board('home=1');
    const row = home.workspace.projects.find((p: { name: string }) => p.name === 'tips');
    assert.equal(row.counts.needs, 3, 'the row: the question and the two that were left');
    assert.match(home.workspace.brief.headline, /\b3 need you\b/, 'the brief across every project');
    assert.equal((await board('project=tips')).waitsOnYou, 3, 'the board of the project, which the tab shows');
    assert.equal(home.workspace.projects.find((p: { name: string }) => p.name === 'studio').counts.needs, 0);

    try {
      browser = await openChrome();
    } catch {
      t.skip('no Chrome on this machine to drive');
      return;
    }
    const tab = await browser.newPage();
    await tab.goto(page.url);
    const needs = tab.locator('.prow[data-project="tips"] .pneeds');
    await needs.waitFor();
    assert.equal(await needs.innerText(), '3 need you');
    assert.match(await tab.locator('.hhead').innerText(), /3 need you/);
    await until('the tab counts them', async () => (await tab.title()) === '(3) All projects');
    await tab.locator('.pswitch').click();
    assert.equal(await tab.locator('.pmenu .pitem[data-project="tips"] .pneeds').innerText(), '3 need you');
    assert.equal(await tab.locator('.pmenu .pitem[data-project=""] .pneeds').innerText(), '3 need you');
    // The project's own board, in the tab: the same number.
    await tab.locator('.pmenu .pitem[data-project="tips"]').click();
    await until('the board of tips is up', async () => (await tab.title()) === '(3) tips');
  } finally {
    await browser?.close();
    await page.stop();
    s.cleanup();
  }
});
