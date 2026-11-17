/**
 * Spool's own thread lines, said the way a person reads them at a glance.
 *
 * The lines stay stored as they are: the step-up rule, `ranOn`, take-over's undo check and the
 * rest read them back by their wording. This only changes what the board and `spool show`
 * display, so old threads and new ones read alike. A line this does not know is shown as it is.
 */

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "sonnet · medium" as "Sonnet, medium effort"; "sonnet" as "Sonnet". */
function modelWords(pick: string): string {
  const [model, effort] = pick.split(' · ').map((x) => x.trim());
  return `${cap(model ?? '')}${effort ? `, ${effort} effort` : ''}`;
}

/** "by its size" as "its size"; "stepped up from haiku: ..." and the rest as they were. */
function whyWords(why: string): string {
  if (why === 'by its size') return 'its size';
  if (why === 'as the thread says') return 'as the thread says';
  return why;
}

/** "sonnet · medium, by its size" as "Sonnet, medium effort (its size)". */
function chosen(rest: string): string {
  const at = rest.lastIndexOf(', ');
  if (at < 0) return modelWords(rest);
  return `${modelWords(rest.slice(0, at))} (${whyWords(rest.slice(at + 2))})`;
}

const flag = (command: string, name: string): string | undefined => new RegExp(`(?:^|\\s)--${name}[ =](\\S+)`).exec(command)?.[1];

const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^builder model: (.*)$/, (m) => `Builder: ${chosen(m[1]!)}`],
  [/^built on ([^;]*?)(?:; Spool suggested (.*))?$/, (m) => `Built on ${modelWords(m[1]!)}${m[2] ? `. Spool would have picked ${chosen(m[2])}` : ''}`],
  [/^started, in its own worktree on \S+$/, () => 'Started, in its own copy of the project'],
  [/^started, taking over from (.+?), who handed it off, in its own worktree on \S+$/, (m) => `Started, taking over from ${m[1]}, in its own copy of the project`],
  [/^started, taking over from (.+?), who handed it off$/, (m) => `Started, taking over from ${m[1]}`],
  [/^started, in its own worktree on \S+$/, () => 'Started, in its own copy of the project'],
  [/^picked up after the last claim went quiet(?:, in its own worktree on \S+)?$/, () => 'Picked up again: the last agent had gone quiet'],
  [/^moved to build, taking over the backlog: weekly (.*)$/, (m) => `Took it from the backlog: usage ${m[1]}`],
  [/^moved to build, taking over the backlog: (.*)$/, (m) => `Took it from the backlog: ${m[1]}`],
  [/^check passed: .* \((\d+)s\)$/, (m) => `Checks passed in ${m[1]}s`],
  [/^landed (\d+) commit\(s\) on (.+)$/, (m) => `Landed: ${plural(Number(m[1]), 'commit')} on ${m[2]}`],
  [/^reverted (\d+) commit\(s\)(.*)$/, (m) => `Undid ${plural(Number(m[1]), 'commit')}${m[2]}`],
  [/^stepped up from (\S+) to (.+?): (.*)$/, (m) => `Moved up from ${cap(m[1]!)} to ${modelWords(m[2]!)}: ${m[3]}`],
  [/^kept on (.+?), the biggest model: (.*)$/, (m) => `Kept on ${modelWords(m[1]!)}, the biggest model: ${m[2]}`],
  [/^(would step up to Fable|is set to Fable), but Fable's weekly usage is at (\d+)%: built on Opus$/, (m) => `Fable is nearly used up (${m[2]}% of the week), so this is built on Opus`],
  [/^handed off(?: to (.+?))?: (.*); back in build$/, (m) => `Handed off${m[1] ? ` to ${m[1]}` : ''}: ${m[2]}. Back in Build`],
  [/^(?:the pass is )?handed to `(.*)`$/, (m) => {
    const model = flag(m[1]!, 'model');
    const effort = flag(m[1]!, 'effort');
    // A custom command is shown by its name, as written.
    return model ? `Handed to an agent on ${modelWords(`${model}${effort ? ` · ${effort}` : ''}`)}` : m[0];
  }],
  [/^agent (.+?) without finishing; back in build$/, (m) => `The agent ${m[1]} without finishing. Back in Build`],
  [/^opened in Claude Code, in session \S+?(, a new one)?$/, (m) => `Opened in Claude Code${m[1] ? ', in a new session' : ''}`],
  [/^handed back from Claude Code; back in build$/, () => 'Handed back from Claude Code, for the agent to finish. Back in Build'],
  [/^stopped in Claude Code; back in build$/, () => 'Closed Claude Code and left it stopped. Back in Build'],
];

/** One of Spool's own lines in plain words, or the line itself where it is not one of them. */
export function plain(what: string): string {
  for (const [re, say] of RULES) {
    const m = re.exec(what);
    if (m) return say(m);
  }
  return what;
}
