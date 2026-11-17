/**
 * A board with something in every section, for the tests of the terminal interface: built by
 * hand, so its ids and times are the same every run and a screen can be compared as text.
 */

import type { Board, Card } from '../src/board.ts';
import type { Brief } from '../src/brief.ts';
import { type State, start } from '../src/tui.ts';

/** The moment the fixture's screens are drawn at. */
export const NOW = Date.parse('2026-01-01T12:00:00Z');

export function card(id: string, title: string, column: Card['column'], over: Partial<Card> = {}): Card {
  return {
    id,
    n: null,
    title,
    difficulty: '',
    priority: 'Normal',
    urgent: false,
    type: 'change',
    note: '',
    why: '',
    suggested: '',
    size: '',
    model: '',
    effort: '',
    suggest: { model: '', effort: '', why: '' },
    p: 2,
    tags: [],
    version: '',
    sprint: '',
    column,
    created: '2026-01-01T08:00:00Z',
    updated: '2026-01-01T11:00:00Z',
    archived: '',
    done: column === 'done',
    complete: false,
    steps: [],
    thread: { said: [], spec: '', about: [], steps: [], feed: [], report: '', by: '', checked: '', summary: '', commits: [], cameFrom: [], parts: [], questions: [], pictures: [] },
    question: null,
    proposals: [],
    live: null,
    worktree: '',
    run: null,
    waiting: null,
    ...over,
  };
}

/** The lines the agent on the first building thread has said so far. */
export const JUMP_LINES = [
  'Reading the jump code first.',
  '→ Read: src/player/jump.ts',
  '→ Edit: src/player/jump.ts',
  'Gravity is up from 28 to 34 at the top of the arc.',
  '→ Bash: npm test',
  '✗ 1 test failed: "clears the small platform"',
  'The small platform is 3px too far now. Shortening the hang time instead.',
];

export function fixture(): Board {
  const thread = card('', '', 'build').thread;
  const building = [
    card('t-4kq7', 'Tighter jump', 'building', {
      size: 'm',
      difficulty: 'Medium',
      sprint: 'r-f331',
      why: 'The jump feels floaty at the top of the arc.',
      live: { since: '2026-01-01T11:53:48Z', note: '' },
      worktree: '.spool/worktrees/t-4kq7',
      run: { model: 'opus', effort: 'high', why: '', session: '3b7f38ef-1c2d-4e5f-8a9b-0c1d2e3f4a5b' },
      thread: {
        ...thread,
        about: [
          { key: 'what', label: 'What changes', text: 'More gravity at the top of the arc, so the fall starts sooner.' },
          { key: 'done', label: 'Done when', text: 'A full jump takes under 600ms and still clears the small platform.' },
        ],
      },
    }),
    card('t-b81c', 'Coins at sunset', 'building', { size: 's', difficulty: 'Small', live: { since: '2026-01-01T11:57:50Z', note: '' }, worktree: '.spool/worktrees/t-b81c', run: { model: 'sonnet', effort: 'medium', why: '', session: '9c41d0aa-77b2-4c1e-9f00-5a6b7c8d9e0f' } }),
  ];
  const build = [
    card('t-c0de', 'Double jump', 'build', { size: 'm', difficulty: 'Medium', sprint: 'r-f331', why: 'One jump is not enough to reach the high ledges.' }),
    card('t-e2b7', 'Credits screen', 'build', { size: 'xs', difficulty: 'Tiny' }),
  ];
  const done = [
    card('t-5aa1', 'Coyote time', 'done', {
      size: 's',
      difficulty: 'Small',
      why: 'A jump pressed just after leaving a ledge should still count.',
      steps: ['Run npm start and walk off the first ledge.', 'Press jump a moment after leaving it: the jump still happens.'],
      thread: {
        ...thread,
        by: 'claude',
        summary: 'A jump within 90ms of leaving a ledge counts as if still on it.',
        commits: ['3f9c2ab'],
        steps: [
          { at: '2026-01-01 10:41Z', who: 'page', what: 'handed to `claude -p --model sonnet`' },
          { at: '2026-01-01 10:58Z', who: 'claude', what: 'done: A jump within 90ms of leaving a ledge counts as if still on it.' },
        ],
      },
    }),
    card('t-0b2c', 'Fix wall clip', 'done', { size: 'xs', difficulty: 'Tiny', thread: { ...thread, by: 'claude', summary: 'The player no longer slides through the left wall.' } }),
  ];
  const proposed = [
    card('t-7c1d', 'Pause menu', 'proposed', { size: 'm', difficulty: 'Medium', why: 'There is no way to stop the game without losing the run.' }),
    card('t-3e9a', 'Leaderboard', 'proposed', { size: 'l', difficulty: 'Large' }),
    card('t-1f3e', 'Sunset palette', 'proposed', { size: 's', difficulty: 'Small', sprint: 'r-f331' }),
    card('t-aa90', 'Save slots', 'proposed', { size: 'l', difficulty: 'Large', sprint: 'r-f331' }),
    card('t-d44e', 'Gamepad support', 'proposed', { size: 'm', difficulty: 'Medium', waiting: { kind: 'hold', text: 'After the demo.', on: [], said: '', refused: [] } }),
  ];
  return {
    project: 'skyhop',
    you: '',
    version: '0.16.0',
    build: '',
    notice: '',
    gate: true,
    locked: false,
    tags: [],
    versions: [],
    history: 0,
    needs: {
      questions: [{ id: 'd-9d2a', title: 'Which font for the HUD?', options: ['Pixel', 'Rounded', 'Mono'], recommend: 1, why: 'The score is hard to read at small sizes.', holds: ['HUD shows the coin count'], threads: ['t-3e9a'] }],
      plans: [],
      calls: [],
      skills: [],
      notes: [],
    },
    waitsOnYou: 1,
    runner: {
      builder: 'headless',
      watching: false,
      agents: [],
      on: true,
      agent: 'claude -p',
      parallel: 3,
      running: [
        { id: 't-4kq7', seconds: 372, lines: JUMP_LINES, listens: true, asking: null },
        { id: 't-b81c', seconds: 130, lines: ['→ Read: src/world/coins.ts', 'The coins use the noon sprite at every hour.'], listens: true, asking: null },
      ],
      stopped: ['t-e2b7'],
      recent: [],
      typing: [],
    },
    usage: { agent: 'Claude', target: {}, own: {}, cannotRead: false, read: null, reached: [], fableCap: null },
    notices: { on: ['question', 'empty', 'stuck', 'budget'], default: true, notifier: '' },
    sprints: [{ id: 'r-f331', name: 'Feel', status: 'running', goal: 'The game feels tight to play.', why: 'Players drop off in the first minute.', doneWhen: 'Five people finish level one without asking how to jump.', serves: '', vision: '', version: '', started: '2026-01-01T09:00:00Z', reached: '', total: 7, done: 2, waiting: 2 }],
    columns: { proposed, build, building, done },
    archived: [],
    also: { assumptions: 0, skills: 0, inbox: 0 },
    brief: null,
    goals: null,
  };
}

/** What `spool brief` would say of a morning after: something shipped, something to check, something that needs him. */
export function briefFixture(): Brief {
  return {
    since: null,
    spent: null,
    headline: '3 threads shipped since you last looked, over 2h · 2 need you',
    shipped: 3,
    took: 7_200_000,
    needsYou: {
      questions: [{ id: 'd-9d2a', title: 'Which font for the HUD?', options: ['Pixel', 'Rounded', 'Mono'], recommend: 1, blocks: 1, project: 'skyhop' }],
      plans: [],
      stopped: [{ id: 't-e2b7', title: 'Credits screen', why: 'stopped from the page', when: '2026-01-01T11:20:00Z', lastSaid: 'Laying out the names in two columns.', project: 'skyhop' }],
      proposals: [],
    },
    worthALook: [
      {
        id: 't-5aa1',
        title: 'Coyote time',
        summary: 'A jump within 90ms of leaving a ledge counts as if still on it.',
        steps: ['Run npm start and walk off the first ledge.', 'Press jump a moment after leaving it: the jump still happens.'],
        size: 's',
        files: 9,
        reasons: ['the check failed once first', '9 files changed'],
        project: 'skyhop',
        pictures: 0,
      },
    ],
    alsoShipped: [
      { sprint: null, threads: [{ id: 't-0b2c', title: 'Fix wall clip', summary: 'The player no longer slides through the left wall.', project: 'skyhop' }] },
      { sprint: { id: 'r-f331', title: 'Feel' }, threads: [{ id: 't-61fa', title: 'Faster respawn', summary: null, project: 'skyhop' }] },
    ],
    noThread: [],
    calls: [{ id: 'd-71c0', question: 'Coyote time: how long?', chose: '90ms, as most platformers do', for: ['t-5aa1'], project: 'skyhop' }],
    approve: 'spool approve --all',
    board: 'spool page',
  };
}

/** The interface's state for a screen of the fixture, with the page at :4747. */
export function stateOf(cols: number, rows: number, over: Partial<State> = {}): State {
  return { ...start({ url: 'http://127.0.0.1:4747/', started: false, lost: false }, cols, rows, NOW), sizes: { 't-5aa1': '+38 -12', 't-0b2c': '+6 -2' }, ...over };
}
