/**
 * One page to a project, wherever it was started: a page up at the top of a folder of projects
 * builds each of them, so a command inside any one of them finds that page and uses it, and no
 * second page is started beside it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { CLI, Sandbox, startPage } from './helpers.ts';

/** `spool page --status`, which says what the page says once it has asked it, run as its own process in `s`'s folder. */
function status(s: Sandbox): string {
  const env = { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined, SPOOL_PAGE_RESUME: undefined };
  return spawnSync(process.execPath, [CLI, '-C', s.dir, 'page', '--status'], { env, encoding: 'utf8' }).stdout.trim();
}

function studio(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio', '--gate');
  s.cd('games/sky_hop').sp('init', '--gate');
  s.cd('apps/tidy_up').sp('init', '--gate');
  return s;
}

test('a command inside a project finds the page started at the top, and starts no second one', async () => {
  const s = studio();
  const game = s.cd('games/sky_hop');
  const page = await startPage(s);
  const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as { runner: { on: boolean } };
  try {
    assert.match(game.sp('status'), new RegExp(`Board: ${page.url} · the page builds \\(Headless\\), agents off`));
    assert.doesNotMatch(game.sp('status'), /not up/);

    // A second start points at the first, and says where it was started.
    const again = game.sp('page', '-d');
    assert.match(again, new RegExp(`^The Spool page is already up for this project: ${page.url}`));
    assert.match(again, /It was started in .*, and builds this project too\./);

    assert.match(status(game), new RegExp(`^Spool page: ${page.url}\\nIt was started in `));

    // The Agents switch it presses is the top page's.
    assert.equal(game.sp('agents', 'on'), 'Agents are on: this page builds what is in Build.');
    assert.equal((await board()).runner.on, true);
    assert.equal(game.sp('agents'), `The page at ${page.url} has its agents on.`);
    assert.equal(game.sp('agents', 'off'), 'Agents are off.');
    assert.equal((await board()).runner.on, false);

    // A project set up below once the page is up is one more it builds, as soon as the page has read it.
    const fresh = s.cd('apps/later');
    fresh.sp('init', '--gate');
    await board();
    assert.equal(fresh.sp('agents'), `The page at ${page.url} has its agents off.`);
    await page.stop();
    assert.match(game.sp('status'), /Board: not up/, 'with the page gone, its record is no more');
  } finally {
    await page.stop();
    s.cleanup();
  }
});

test('a page started at the top for one project is not found from another', async () => {
  const s = studio();
  const page = await startPage(s, '--project', 'games/sky_hop');
  try {
    assert.match(s.cd('games/sky_hop').sp('status'), new RegExp(`Board: ${page.url}`));
    assert.match(s.cd('apps/tidy_up').sp('status'), /Board: not up/);
    assert.match(status(s.cd('apps/tidy_up')), /^No Spool page is up for this project/);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
