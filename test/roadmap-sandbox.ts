/**
 * A project with one sprint of each kind, for the Roadmap view's tests and the sprint review's: one
 * reached, with a call an agent made and a thread that was undone and done again; one being played;
 * one planned; and a thread in no sprint.
 */

import { Sandbox } from './helpers.ts';

export interface Roadmap {
  s: Sandbox;
  polish: string;
  worlds: string;
  later: string;
  jump: string;
  coins: string;
  map: string;
  boss: string;
  shop: string;
  daily: string;
  loose: string;
  call: string;
}

/** Claim a thread and commit a change under its trailer, then finish it with steps to check. */
function ship(s: Sandbox, id: string, file: string, summary: string, steps: string[]): void {
  s.sp('start', id);
  s.write(file, `${summary}\n`);
  s.commitAll(`${summary}\n\nSpool: ${id}`);
  s.sp('done', id, '-m', summary, ...steps.flatMap((step) => ['--steps', step]));
}

export function roadmapSandbox(): Roadmap {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.gitInit();
  s.write('README.md', 'a game\n');
  s.commitAll('Start');
  s.sp('goals', '--edit', 'For: a platformer that feels good on a phone\n\n- Controls that feel tight\n- A world worth exploring');

  // Reached: two threads finished, one of them undone once and done again, and a call made on the other.
  const polish = s.json('sprint', 'Polish', '--goal', 'Everything looks finished', '--why', 'players notice', '--done-when', 'nothing looks placeholder', '--serves', 'Controls that feel tight').sprint.id;
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '--sprint', 'Polish');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs', '--sprint', 'Polish');
  s.exec(['play', 'Polish'], { tty: true });
  ship(s, jump, 'src/jump.txt', 'The jump is snappier', ['Open level 1', 'Jump the first gap: you land on it']);
  s.exec(['revert', jump, '-m', 'still floaty'], { tty: true });
  ship(s, jump, 'src/jump.txt', 'The jump is snappier, for real', ['Open level 1', 'Jump the first gap: you land on it']);
  s.sp('start', coins);
  const call = s.json('assume', 'Outline the coins, or turn them teal?', '--chose', 'Outline them', '--why', 'teal clashes with water', '--for', coins).decision.id;
  s.write('src/coins.txt', 'outlined\n');
  s.write('src/palette.txt', 'rim\n');
  s.commitAll(`Outline the coins\n\nSpool: ${coins}`);
  s.sp('done', coins, '-m', 'Coins have a dark rim', '--steps', 'Play level 3 at sunset');

  // Being played: one thread done, one in build, one still in the backlog after play.
  const worlds = s.json('sprint', 'Worlds', '--vision', 'I want a second world that feels like night', '--goal', 'A second world', '--done-when', 'you can play world 2 to the end').sprint.id;
  const map = s.id('task', 'Draw the world 2 map', '-s', 'm', '--sprint', 'Worlds');
  const boss = s.id('task', 'A boss at the end of world 2', '-s', 'l', '--sprint', 'Worlds');
  s.exec(['play', 'Worlds'], { tty: true });
  ship(s, map, 'src/map.txt', 'World 2 has a map', ['Open the world select: world 2 is there']);
  const shop = s.id('task', 'A shop between worlds', '-s', 's', '--sprint', 'Worlds');

  // Planned: two threads waiting for play.
  const later = s.json('sprint', 'Daily', '--goal', 'A reason to come back').sprint.id;
  const daily = s.id('task', 'A daily challenge level', '-s', 'm', '--sprint', 'Daily');
  s.id('task', 'A streak counter', '-s', 's', '--sprint', 'Daily');

  const loose = s.id('task', 'A Grand Prix mode', '-s', 'l');
  return { s, polish, worlds, later, jump, coins, map, boss, shop, daily, loose, call };
}
