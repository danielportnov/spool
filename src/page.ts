/**
 * The Spool page: the project's spool as a board in a browser.
 *
 * `spool page` starts a small server on this machine and opens a kanban board
 * of every thread: backlog, build, building, done. A second view is the
 * backlog itself, with sprints to fill and play. It is where the user plans
 * and steers. They drag a thread into build, or press play on it, and
 * that is the only way anything gets built; they add a thread at the foot of a
 * column; they open a card and read its thread: what they asked, what was done
 * and by which agent, and everything that happened in between; they write a
 * note on it and it lands there in their words; they answer a question and
 * work moves again; and they mark finished work complete when they have
 * looked at it.
 * Agents read the same spool and keep working while the page is open.
 *
 * Everything the page does is an ordinary command run in-process, as the
 * user: `build`, `propose`, `order`, `capture`, `task`, `file`, `edit`, `answer`, `approve`,
 * `sprint`, `play`, `drop`, `revert`, `archive`. So the page can do
 * nothing the command line cannot, and every rule the commands enforce holds
 * here too.
 *
 * The code is in files of their own. This one only passes their names on, so that whatever
 * imports from here still finds them:
 *
 *   - `board.ts`    the board as data: every card, its thread, what waits on the user
 *   - `act.ts`      one command run as the user, and each thing the page can ask for
 *   - `session.ts`  one agent on one thread: started, heard and ended
 *   - `engine.ts`   the runner: which thread is built next, where, and how it is settled
 *   - `upkeep.ts`   the page rebuilding Spool, and restarting onto new code
 *   - `server.ts`   the HTTP server, and the `spool page` command
 *   - `client/`     the page the browser gets: its markup, its styles and its script
 */

export { aboutOf, board, diffOf, identicon, liveNow } from './board.ts';
export { Runner, stoppedInBuild } from './engine.ts';
export { servePage, startPage } from './server.ts';
export { Upkeep, buildId } from './upkeep.ts';
