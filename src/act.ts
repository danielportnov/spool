/**
 * One command, run in-process as the human.
 *
 * Whatever a face of Spool does for the human is an ordinary command, the same one a person
 * would type: so it can do nothing the command line cannot, and every rule the commands enforce
 * holds for it too. `act` runs one and says whether it worked. `change` is everything the page
 * can ask for, each as its command.
 */

import { run } from './cli.ts';
import type { Ctx } from './context.ts';
import { oneLine } from './model.ts';
import { sprintReview } from './review.ts';
import { review } from './schedule.ts';
import { Workspace } from './store.ts';

/** Run one command as the human, in-process, and say whether it worked. */
export function act(ctx: Ctx, argv: string[]): { ok: boolean; text: string; data: unknown } {
  const out: string[] = [];
  const err: string[] = [];
  // --json goes first: after a `--`, everything is the human's words.
  const code = run(['--json', ...argv], {
    ...ctx,
    env: { ...ctx.env, SPOOL_ACTOR: 'human' },
    // Everything the page does is a click a person made on it.
    human: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: () => '',
    lines: () => {},
    color: false,
    inherit: false,
  });
  let data: unknown = null;
  try {
    data = JSON.parse(out.join('\n'));
  } catch {
    // Not every failure is JSON; the text below carries it.
  }
  const failed = (data as { error?: string } | null)?.error;
  return { ok: code === 0, text: failed ?? err.join('\n') ?? '', data };
}

export type Body = Record<string, unknown>;
export const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** What the page can do. Each is the command a person would have typed. */
export function change(ctx: Ctx, action: string, body: Body, project?: string): { ok: boolean; text: string; id?: string } {
  const id = text(body.id);
  if (action === 'complete-all') {
    // Every finished thread still to check, approved in one go. Only threads: the calls agents made are not swept in.
    const ws = Workspace.open(ctx.cwd, ctx.now);
    let ids: string[];
    try {
      ids = review(ws, project ? ws.project(project) : ws.home).shipped.map((t) => t.id);
    } finally {
      ws.close();
    }
    return ids.length ? act(ctx, ['approve', ...ids]) : { ok: true, text: 'Nothing left to check.' };
  }
  if (action === 'move-many') {
    // "Add to Build" at the foot of the backlog: exactly the threads the page was showing, and no others.
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length || ids.length > 500 || !ids.every((x) => /^t-[a-z0-9]+$/.test(x))) return { ok: false, text: 'which threads?' };
    return act(ctx, ['build', ...ids]);
  }
  if (action === 'add') {
    const words = text(body.text);
    const to = text(body.to);
    if (!words) return { ok: false, text: 'say what to add' };
    if (to !== 'proposed' && to !== 'build') return { ok: false, text: 'a thread can be added to proposed, or to build' };
    // Their words are kept whole as the note; the thread's name is the first line of them. Quick add
    // names it itself, with the #tags and !priority it read out of the words, and passes those on.
    const name = text(body.title) || words.split('\n')[0]!;
    const extra = [
      ...(typeof body.priority === 'number' ? ['-p', String(body.priority)] : []),
      ...(Array.isArray(body.tags) ? body.tags.map((t) => `--tag=${String(t)}`) : []),
    ];
    const captured = act(ctx, ['capture', '--', words]);
    const note = (captured.data as { note?: { id?: string } } | null)?.note?.id;
    if (!captured.ok || !note) return { ok: false, text: captured.text || 'it could not be saved' };
    const filed = act(ctx, ['task', '--from', note, ...extra, '--', oneLine(name, 110)]);
    const task = (filed.data as { task?: { id?: string; status?: string } } | null)?.task;
    if (!filed.ok || !task?.id) return { ok: false, text: filed.text || 'it could not be filed' };
    // Adding it under Build is the human putting it in build; under Proposed it waits, gate or no gate.
    // The new thread's id goes back with it: pictures pasted into the box are attached to it next.
    if (to === 'build' && task.status === 'proposed') return { ...act(ctx, ['build', task.id]), id: task.id };
    if (to === 'proposed' && task.status !== 'proposed') return { ...act(ctx, ['propose', task.id]), id: task.id };
    return { ok: true, text: '', id: task.id };
  }
  if (action === 'note') {
    const words = text(body.text);
    if (!words) return { ok: false, text: 'the note is empty' };
    if (id && !/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    // Their words, exactly, as a note; on a thread, it is attached to it.
    const captured = act(ctx, ['capture', '--', words]);
    const note = (captured.data as { note?: { id?: string } } | null)?.note?.id;
    if (!captured.ok || !note) return { ok: false, text: captured.text || 'the note could not be saved' };
    if (!id) return { ok: true, text: '' };
    const filed = act(ctx, ['file', note, '--into', id]);
    // The thread the reply landed on goes back with it, for the pictures sent with it.
    if (filed.ok || !/already (done|dropped)/.test(filed.text)) return { ...filed, id };
    // A reply on finished work is feedback on it: new work, linked to what it answers, and proposed like any other.
    const next = act(ctx, ['task', '--from', note, '--from', id, '--', oneLine(words.split('\n')[0]!, 110)]);
    const made = (next.data as { task?: { id?: string } } | null)?.task?.id;
    return next.ok ? { ok: true, text: 'That thread is finished, so your reply is a new proposed thread linked to it.', id: made } : next;
  }
  if (action === 'sprint') {
    const name = text(body.name);
    return name ? act(ctx, ['sprint', ...(project ? [`--project=${project}`] : []), '--', name]) : { ok: false, text: 'the sprint needs a name' };
  }
  if (action === 'assign') {
    // Into a sprint, or back to the backlog.
    const sprint = text(body.sprint);
    if (!/^t-[a-z0-9]+$/.test(id) || (sprint && !/^r-[a-z0-9]+$/.test(sprint))) return { ok: false, text: 'which thread, and which sprint?' };
    return act(ctx, ['edit', id, `--sprint=${sprint || 'none'}`]);
  }
  if (action === 'sprint-about') {
    // What a sprint is for, written or changed on the page: its goal, the reason, and when it is done.
    if (!/^r-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which sprint?' };
    const lines = [['Goal', body.goal], ['Why', body.why], ['Done when', body.doneWhen]]
      .map(([label, value]) => [label, text(value).replace(/\s+/g, ' ')])
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}: ${value}`);
    return act(ctx, ['edit', id, `--body=${lines.join('\n')}`]);
  }
  if (action === 'play') {
    // Pressing play on a sprint: everything in it moves to build.
    return /^r-[a-z0-9]+$/.test(id) ? act(ctx, ['play', id]) : { ok: false, text: 'which sprint?' };
  }
  if (action === 'drop-sprint') {
    // The sprint goes; what was in it is back in the backlog, untouched.
    return /^r-[a-z0-9]+$/.test(id) ? act(ctx, ['drop', id]) : { ok: false, text: 'which sprint?' };
  }
  if (action === 'edit') {
    // The ticket's fields. Each is the `spool edit` a person would have typed; the command checks the values.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    const argv = ['edit', id];
    if (typeof body.title === 'string' && body.title.trim()) argv.push(`--title=${body.title.trim()}`);
    if (typeof body.priority === 'number') argv.push(`--priority=${body.priority}`);
    if (typeof body.size === 'string' && body.size) argv.push(`--size=${body.size}`);
    // An empty model or effort is the human handing the choice back to the thread's size.
    if (typeof body.model === 'string') argv.push(`--model=${body.model.trim() || 'none'}`);
    if (typeof body.effort === 'string') argv.push(`--effort=${body.effort.trim() || 'none'}`);
    if (Array.isArray(body.tags)) argv.push(...(body.tags.length ? body.tags.map((t) => `--tag=${String(t)}`) : ['--tag=none']));
    if (typeof body.version === 'string') argv.push(`--version=${body.version.trim() || 'none'}`);
    if (argv.length === 2) return { ok: false, text: 'nothing to change' };
    return act(ctx, argv);
  }
  if (action === 'approve') {
    // "Fine", on a call an agent made, a plan, or a new skill: the human accepting it.
    return /^[dts]-[a-z0-9]+$/.test(id) ? act(ctx, ['approve', id]) : { ok: false, text: 'which one?' };
  }
  if (action === 'approve-calls') {
    // Every call agents made by themselves, accepted in one go. Plans and threads are not swept in.
    const ws = Workspace.open(ctx.cwd, ctx.now);
    let ids: string[];
    try {
      ids = review(ws, project ? ws.project(project) : ws.home).assumptions.map((d) => d.id);
    } finally {
      ws.close();
    }
    return ids.length ? act(ctx, ['approve', ...ids]) : { ok: true, text: 'Nothing left to look at.' };
  }
  if (action === 'approve-sprint') {
    // "Approve the sprint" on its review: its finished threads marked complete, and the calls agents made on them accepted, in one go.
    if (!/^r-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which sprint?' };
    const ws = Workspace.open(ctx.cwd, ctx.now);
    let ids: string[];
    try {
      const { threads, calls } = sprintReview(ws, id).toApprove;
      ids = [...threads, ...calls];
    } finally {
      ws.close();
    }
    return ids.length ? act(ctx, ['approve', ...ids]) : { ok: true, text: 'Nothing in it left to approve.' };
  }
  if (action === 'drop-skill') {
    return /^s-[a-z0-9]+$/.test(id) ? act(ctx, ['drop', id, '--message=dropped on the page']) : { ok: false, text: 'which skill?' };
  }
  if (action === 'note-thread' || action === 'note-aside') {
    // A note nobody filed: make it a thread in the backlog, or set it aside.
    if (!/^n-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which note?' };
    if (action === 'note-aside') return act(ctx, ['file', id, '--drop', '--message=set aside on the page']);
    const title = text(body.title);
    return title ? act(ctx, ['task', '--from', id, '--', oneLine(title.split('\n')[0]!, 110)]) : { ok: false, text: 'it needs a name' };
  }
  if (action === 'undo') {
    // Undo exactly what this thread changed. With their reason it is done again; dropped, it is not.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    const why = text(body.why);
    return act(ctx, ['revert', id, ...(why ? [`--message=${why}`] : []), ...(body.drop === true ? ['--drop'] : [])]);
  }
  if (action === 'archive' || action === 'unarchive') {
    // Out of sight, not dropped; and back again, just as it was.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    return act(ctx, ['archive', ...(action === 'unarchive' ? ['--undo'] : []), id]);
  }
  if (action === 'complete') {
    // "Mark as complete" is the human saying the change is good: the same as approving it.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    return act(ctx, ['approve', id]);
  }
  if (action === 'target') {
    // The usage target, from the header: a whole percent for each limit given, or null to take that one off.
    const argv = ['target'];
    for (const [key, flag] of [['weekly', 'weekly'], ['fiveHour', 'five-hour']] as const) {
      const value = body[key];
      if (value === null) argv.push(`--${flag}=none`);
      else if (typeof value === 'number') argv.push(`--${flag}=${value}`);
      else if (value !== undefined) return { ok: false, text: 'a target is a percent, or none' };
    }
    return argv.length > 1 ? act(ctx, argv) : { ok: false, text: 'which target?' };
  }
  if (action === 'takeover') {
    // The header's switch: the chat that builds takes over the backlog, or no longer does.
    if (typeof body.on !== 'boolean') return { ok: false, text: 'on, or off?' };
    return act(ctx, ['takeover', body.on ? 'on' : 'off']);
  }
  if (action === 'answer') {
    const choice = text(body.choice);
    if (!/^d-[a-z0-9]+$/.test(id) || !choice) return { ok: false, text: 'which question, and what is the answer?' };
    return act(ctx, ['answer', id, '--', choice]);
  }
  return { ok: false, text: `the page cannot ${action}` };
}
