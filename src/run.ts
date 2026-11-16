/**
 * What a thread's agent was started with, read back from the thread's log: the model and effort
 * in the command it was handed, why they were chosen, and the session to open it again with.
 *
 * The page's runner writes these lines when it starts an agent ("handed to `claude -p --model
 * opus --effort high`", "fable chose opus · high: …", "session … · open it with `claude --resume
 * …`"). An agent a chat started writes none of them, and then nothing is known.
 */

/** What the latest run of a thread was given. Each part is empty where the log does not say. */
export interface Run {
  model: string;
  effort: string;
  /** Why the router chose as it did, in its words. */
  why: string;
  session: string;
}

// Plain words only: these come from a log anyone can write to, and end up on a page and in a command.
const WORD = /^[a-z0-9][a-z0-9.\-[\]]{0,70}$/i;
const SESSION = /^[\w-]{1,100}$/;

const flag = (command: string, name: string): string => {
  const found = new RegExp(`(?:^|\\s)--${name}[ =](\\S+)`).exec(command)?.[1] ?? '';
  return WORD.test(found) ? found : '';
};

/** Read a thread's log lines ("- 2026-01-01 00:01Z page: handed to `…`") for its latest run, or none. */
export function runOf(log: string[]): Run | null {
  const said = log.map((line) => /^- \S+ \S+ (.+?): (.*)$/.exec(line)).map((m) => (m ? { who: m[1]!, what: m[2]! } : null));
  const handed = said.findLastIndex((l) => l?.what.startsWith('handed to '));
  // Someone took it after the page last handed it on: that run is not the page's, and says nothing.
  const taken = said.findLastIndex((l) => !!l && /^(started|picked up after)/.test(l.what));
  if (handed < 0 || taken > handed) return null;
  const command = /^handed to `(.*)`$/.exec(said[handed]!.what)?.[1] ?? '';
  const chose = said[handed - 1] && /^\S+ chose [^:]*(?:: (.*))?$/.exec(said[handed - 1]!.what);
  let session = '';
  for (const l of said.slice(handed + 1)) {
    const id = l && /^session (\S+)/.exec(l.what)?.[1];
    if (id && SESSION.test(id)) session = id;
  }
  return { model: flag(command, 'model'), effort: flag(command, 'effort'), why: chose ? (chose[1] ?? '') : '', session };
}
