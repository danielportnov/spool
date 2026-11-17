/**
 * The page's styles: one string, put between the page's <style> tags by `page.html.ts`.
 *
 * Colours come from the variables in `:root`, light and dark; a rule names a variable, never a
 * colour of its own. Inside the string: no backticks and no `${`.
 */

export const CSS = String.raw`  :root {
    color-scheme: light;
    --bg: #f7f6f3; --panel: #ffffff; --col: #efede8; --ink: #1d1c1a; --soft: #6b6861; --line: #dfdcd5;
    --accent: #c2410c; --go: #15803d; --blue: #1d4ed8; --warn: #b45309; --chip: #eeece6; --hot: #c9372c;
    --shadow: 0 1px 2px rgba(30, 25, 15, .14);
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #151413; --panel: #222120; --col: #1b1a19; --ink: #f1efea; --soft: #a19d95; --line: #353330;
    --accent: #fb923c; --go: #4ade80; --blue: #93c5fd; --warn: #fbbf24; --chip: #2d2b28; --hot: #f87171;
    --shadow: 0 1px 2px rgba(0, 0, 0, .5);
  }
  * { box-sizing: border-box; }
  /* Hidden means gone. Without this, a rule that sets display (the board's grid) keeps a hidden view on screen. */
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  button { font: inherit; cursor: pointer; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 5px 10px; }
  button:hover { border-color: var(--soft); }
  button.go { background: var(--go); border-color: var(--go); color: #fff; font-weight: 600; }
  /* In the dark a filled green is the loudest thing on the page: there it is a tint, with the green
     as its words and edge, so the eye goes to what the page says first. */
  [data-theme="dark"] button.go { background: color-mix(in srgb, var(--go) 14%, var(--panel)); border-color: color-mix(in srgb, var(--go) 45%, var(--panel)); color: var(--go); }
  [data-theme="dark"] button.go:hover { border-color: var(--go); }
  input, select, textarea { font: inherit; color: var(--ink); }

  /* the bar: the project, the two views, and a search */
  .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 18px; padding: 0 20px; height: 52px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .brand { font-size: 17px; font-weight: 700; white-space: nowrap; }
  .where { color: var(--soft); font-size: 13px; font-weight: 400; margin-left: 6px; }
  .tabs { display: flex; gap: 2px; align-self: stretch; }
  .tab { background: none; border: 0; border-bottom: 3px solid transparent; border-radius: 0; padding: 0 12px; color: var(--soft); font-weight: 600; }
  .tab.on { color: var(--ink); border-bottom-color: var(--accent); }
  .search { margin-left: auto; width: min(260px, 40vw); padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
  .searchbtn { display: none; }
  /* Chat mode fills the bar: under a wide screen it packs closer, so the gear and the theme stay in view. */
  @media (min-width: 761px) and (max-width: 1700px) {
    .bar { gap: 10px; }
    .tab { padding: 0 9px; }
    .where { display: none; }
  }
  .runner { white-space: nowrap; color: var(--soft); }
  .runner.on { color: var(--go); border-color: var(--go); font-weight: 600; }
  /* who builds: two picks side by side, the one in force filled in */
  .builder { display: flex; white-space: nowrap; margin-right: -8px; }
  .builder button { color: var(--soft); border-radius: 0; }
  .builder button:first-child { border-radius: 7px 0 0 7px; }
  .builder button:last-child { border-radius: 0 7px 7px 0; margin-left: -1px; }
  .themer { width: 30px; height: 30px; padding: 0; display: inline-grid; place-items: center; color: var(--soft); flex: none; }
  .themer:hover { color: var(--ink); }
  .themer svg { width: 16px; height: 16px; }
  .builder button.on { position: relative; color: var(--ink); background: var(--bg); border-color: var(--soft); font-weight: 600; }
  /* Headless is off for now: greyed, and a click does nothing. It still shows as the pick when the project is set to it. */
  .builder button.off { color: var(--line); cursor: not-allowed; }
  .builder button.off.on { color: var(--soft); }
  /* In Chat mode, the agents that build, in one button: each name and what it is building of its count, greyed while it is not watching. It opens Settings. */
  .roster { display: inline-flex; align-items: center; gap: 0; white-space: nowrap; padding: 5px 4px; }
  .roster .agent { display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; font-weight: 600; color: var(--ink); }
  .roster .agent + .agent { border-left: 1px solid var(--line); }
  .roster .agent .n { font-weight: 400; font-variant-numeric: tabular-nums; color: var(--soft); }
  .roster .agent.off, .roster .agent.off .n { color: var(--soft); font-weight: 400; opacity: .6; }
  /* The usage target, in Chat mode: a small meter of the plan's usage, with a tick where the chat stops. */
  .target { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; color: var(--soft); margin-left: -8px; }
  .target.set { color: var(--ink); }
  .target .meter { position: relative; flex: none; width: 56px; height: 6px; border-radius: 3px; background: var(--line); }
  .target .meter .used { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--blue); }
  .target .meter .mark { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--ink); }
  .target .num { font-weight: 600; font-variant-numeric: tabular-nums; }
  .target .num.fable { font-weight: 500; color: var(--soft); }
  .target .num.fable.capped { font-weight: 600; color: var(--warn); }
  .target.reached { color: var(--warn); border-color: var(--warn); }
  .target.reached .meter .used { background: var(--warn); }
  .target[aria-expanded="true"] { border-color: var(--soft); background: var(--bg); }
  #targets { position: absolute; z-index: 3; top: calc(100% + 6px); right: 20px; width: 360px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, .18); padding: 12px 16px 14px; }
  #targets .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  #targets h3 { margin: 0; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); }
  #targets .shut { border: 0; background: none; color: var(--soft); padding: 2px 6px; font-size: 16px; line-height: 1; }
  #targets .what { margin: 6px 0 4px; font-size: 13px; color: var(--soft); }
  #targets .limit { display: grid; grid-template-columns: 88px minmax(0, 1fr) auto; align-items: center; gap: 2px 12px; padding: 10px 0 8px; border-top: 1px solid var(--line); }
  #targets .name { display: flex; align-items: center; gap: 7px; font-weight: 600; cursor: pointer; }
  #targets .name input { margin: 0; accent-color: var(--accent); }
  #targets .box { display: inline-flex; align-items: center; gap: 3px; color: var(--soft); }
  #targets .box input { width: 54px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); font-variant-numeric: tabular-nums; text-align: right; }
  #targets .now { grid-column: 2 / 4; font-size: 12px; color: var(--soft); }
  #targets .now.reached { color: var(--warn); font-weight: 600; }
  #targets .off input[type="range"], #targets .off .box { opacity: .45; }
  /* The slider's track is the meter: the plan's usage shaded in, and the thumb is the target. */
  #targets input[type="range"] { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; margin: 0; border-radius: 3px; cursor: pointer;
    background: linear-gradient(to right, color-mix(in srgb, var(--blue) 55%, var(--line)) var(--used, 0%), var(--line) var(--used, 0%)); }
  #targets .limit.reached input[type="range"] { background: linear-gradient(to right, color-mix(in srgb, var(--warn) 60%, var(--line)) var(--used, 0%), var(--line) var(--used, 0%)); }
  #targets input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--accent); border: 2px solid var(--panel); box-shadow: 0 0 0 1px var(--accent); }
  #targets input[type="range"]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--accent); border: 2px solid var(--panel); box-shadow: 0 0 0 1px var(--accent); }
  #targets input[type="range"]:disabled { cursor: default; }
  #targets .foot { margin: 6px 0 0; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px; color: var(--soft); }
  /* Taking over the backlog, in Chat mode: a switch in the header that opens its menu. */
  .takeover { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; color: var(--soft); margin-left: -8px; }
  .takeover .knob { position: relative; flex: none; width: 22px; height: 12px; border-radius: 6px; background: var(--line); transition: background .15s; }
  .takeover .knob::after { content: ''; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--panel); transition: left .15s; }
  .takeover.on { color: var(--ink); font-weight: 600; }
  .takeover.on .knob { background: var(--go); }
  .takeover.on .knob::after { left: 12px; }
  .takeover[aria-expanded="true"] { border-color: var(--soft); background: var(--bg); }
  #takeovers { position: absolute; z-index: 3; top: calc(100% + 6px); right: 20px; width: 360px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, .18); padding: 12px 16px 14px; }
  #takeovers .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  #takeovers h3 { margin: 0; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); }
  #takeovers .shut { border: 0; background: none; color: var(--soft); padding: 2px 6px; font-size: 16px; line-height: 1; }
  /* Each setting is an entry of its own: more can be added below without changing these. */
  #takeovers .entry { padding: 10px 0 8px; border-top: 1px solid var(--line); }
  #takeovers .entry:first-of-type { margin-top: 8px; }
  #takeovers .entry .name { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; }
  #takeovers .entry label.name { cursor: pointer; justify-content: flex-start; }
  #takeovers .entry label.name input { margin: 0; accent-color: var(--accent); }
  #takeovers .entry p { margin: 4px 0 0; font-size: 12px; color: var(--soft); }
  #takeovers .entry .now { color: var(--ink); }
  #takeovers .entry .now.not { color: var(--warn); }
  #takeovers .entry button.link { border: 0; background: none; padding: 0; color: var(--accent); font-size: 12px; font-weight: 600; cursor: pointer; }
  #takeovers.off .entry.takes, #takeovers.off .entry.usage { opacity: .55; }
  @media (max-width: 1100px) { .target .label, .takeover .label { display: none; } }
  /* What notifies him: a bell by the theme, and its box of events, each one on or off. */
  .notifier { margin-right: -12px; }
  .notifier[aria-expanded="true"] { color: var(--ink); background: var(--bg); }
  .notifier.quiet svg { opacity: .55; }
  #notices { position: absolute; z-index: 3; top: calc(100% + 6px); right: 20px; width: 320px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, .18); padding: 12px 16px 14px; }
  #notices .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  #notices h3 { margin: 0; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); }
  #notices .shut { border: 0; background: none; color: var(--soft); padding: 2px 6px; font-size: 16px; line-height: 1; }
  #notices .what { margin: 6px 0 8px; font-size: 13px; color: var(--soft); }
  #notices .nrow { display: flex; align-items: center; gap: 9px; padding: 7px 0; border-top: 1px solid var(--line); cursor: pointer; }
  #notices .nrow input { margin: 0; accent-color: var(--accent); }
  #notices .foot { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin: 6px 0 0; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px; color: var(--soft); }
  #notices .foot button { border: 0; background: none; padding: 0; color: var(--soft); text-decoration: underline; font-size: 12px; white-space: nowrap; }
  .live { margin-top: 6px; display: flex; align-items: center; gap: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--soft); }
  .live .now { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live .for { color: var(--blue); white-space: nowrap; }
  .live.quiet .pulse { background: var(--hot); animation: none; }
  .live .quietmark { flex: none; color: var(--hot); font-weight: 600; white-space: nowrap; }
  .live .pulse { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--blue); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .flag { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; font-size: 12px; font-weight: 650; color: var(--soft); }
  .flag::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .flag.you { color: var(--warn); } .flag.thread { color: var(--blue); } .flag.stuck { color: var(--hot); }
  /* Only what waits on the human gets an edge: an answer, or a word after an agent gave up. */
  .card:has(> .flag.you) { box-shadow: inset 3px 0 0 var(--warn), var(--shadow); }
  .card:has(> .flag.stuck) { box-shadow: inset 3px 0 0 var(--hot), var(--shadow); }
  .livelog { max-height: 220px; overflow: auto; margin-top: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; color: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
  .rule { padding: 8px 20px 0; color: var(--warn); font-size: 13px; }
  /* A page that lost its server says so under the bar, and what it shows is dimmed: it may be old. */
  #away { display: flex; align-items: center; gap: 8px; padding: 7px 20px; font-size: 13px; font-weight: 600; color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border-bottom: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line)); white-space: nowrap; }
  #away .icon { flex: none; display: inline-grid; }
  #away .icon svg { width: 15px; height: 15px; }
  #away .words { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .runner.unknown, .builder .unknown { color: var(--soft); opacity: .6; cursor: default; }
  body.away #quick, body.away main { opacity: .6; }
  #quick { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 20px 0; font-size: 13px; min-height: 12px; }
  .pill { border-radius: 999px; padding: 2px 11px; background: var(--panel); border: 1px solid var(--line); color: var(--soft); }
  .pill.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }

  /* the board */
  #board { display: grid; grid-template-columns: repeat(4, minmax(230px, 1fr)); gap: 12px; padding: 12px 20px 32px; align-items: start; overflow-x: auto; }
  @media (max-width: 900px) { #board { grid-template-columns: repeat(4, 82vw); } }
  .col { background: var(--col); border-radius: 10px; padding: 8px; min-height: 140px; border: 2px solid transparent; }
  .over { border-color: var(--go) !important; }
  .col h2 { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; margin: 5px 6px 10px; display: flex; gap: 8px; color: var(--soft); font-weight: 600; }
  .col h2 .count { background: var(--chip); border-radius: 999px; padding: 0 8px; }
  /* In the light theme the chip's grey is the column's own, so a pill on a column was not there to see: it takes the line's, and reads as it does in the dark. */
  [data-theme="light"] :is(.col h2 .count, .ghead .state, .prog) { background: var(--line); }
  .tools { display: flex; gap: 6px; margin: -4px 4px 8px; }
  .tools select { flex: 1; min-width: 0; padding: 2px 4px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--soft); font-size: 12px; cursor: pointer; }
  .tools select:hover { border-color: var(--line); }
  .tools select.set { color: var(--accent); border-color: var(--line); background: var(--panel); }
  .card { background: var(--panel); border: 1px solid transparent; border-radius: 8px; padding: 9px 10px 8px; margin-bottom: 7px; box-shadow: var(--shadow); }
  .card:hover { border-color: var(--line); }
  .card[draggable=true], .row[draggable=true] { cursor: grab; }
  .dragging { opacity: .45; }
  /* Where a card dragged over Build will land. */
  .landing { height: 3px; margin: -5px 2px 2px; border-radius: 2px; background: var(--go); pointer-events: none; }
  .col .hint { margin: -6px 6px 10px; color: var(--soft); font-size: 12px; }
  .card.past { opacity: .7; }
  .title { font-weight: 500; cursor: pointer; overflow-wrap: anywhere; }
  .title:hover { text-decoration: underline; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .chip { background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--soft); }
  .chip.ai { color: var(--blue); }
  .chip.ok { color: var(--go); }
  .chip.check { color: var(--warn); }
  .chip.sprint { color: var(--accent); }
  .chip.worth { color: var(--accent); font-weight: 600; cursor: help; }
  .tag { cursor: pointer; }
  .tag b { font-weight: 400; margin-left: 5px; opacity: .6; }
  .tag b:hover { opacity: 1; }
  .note { margin-top: 6px; font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }
  /* Why a thread exists: one quiet line, cut short, the whole of it on hover. */
  .why { margin-top: 5px; font-size: 12px; color: var(--soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .q { margin-top: 8px; padding: 8px; border-radius: 8px; background: var(--chip); font-size: 13px; }
  .q button { margin: 6px 6px 0 0; }
  button.rec { border-color: var(--go); }
  .meta { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--soft); }
  .key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; }
  .meta .push { margin-left: auto; }
  .meta .new { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--blue) 12%, var(--panel)); color: var(--blue); font-weight: 650; white-space: nowrap; }
  .meta .new::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .prio { font-weight: 800; letter-spacing: -1px; }
  .prio.p0 { color: var(--hot); } .prio.p1 { color: var(--accent); } .prio.p3 { color: var(--blue); }
  .size { border-radius: 999px; background: var(--chip); padding: 0 7px; font-weight: 600; }
  .act { padding: 2px 9px; font-size: 12px; }
  .arch { width: 24px; height: 24px; padding: 0; display: inline-grid; place-items: center; color: var(--soft); }
  .arch:hover { color: var(--ink); }
  .arch svg { width: 14px; height: 14px; }
  .tick { width: 24px; height: 24px; padding: 0; border-radius: 50%; color: var(--go); font-weight: 700; }
  .tick:hover { background: var(--go); border-color: var(--go); color: #fff; }
  .empty { color: var(--soft); font-size: 13px; padding: 8px 6px; }
  .add { width: 100%; text-align: left; border-style: dashed; background: transparent; color: var(--soft); }
  .add:hover { color: var(--ink); }
  .adding textarea, .adding input { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); resize: vertical; }
  .acts { display: flex; gap: 6px; margin-top: 6px; }
  .foot { width: 100%; margin-bottom: 8px; }
  .addall { margin-bottom: 0; }
  .history { background: none; border: 0; padding: 6px; color: var(--soft); font-size: 13px; width: 100%; text-align: left; }
  .col > .cleanup { width: 100%; margin-bottom: 8px; text-align: left; font-size: 13px; }
  .cleanup:disabled { color: var(--soft); cursor: default; }
  .cleanups { display: flex; gap: 6px; margin-bottom: 8px; }
  .cleanups .cleanup { flex: 1; font-size: 13px; text-align: left; }
  .cleanup.waits { color: var(--warn); }
  .cleaning { margin-bottom: 8px; }
  .ghead .cleaning { flex-basis: 100%; margin: 4px 0 0; }
  .cleaning .hint { font-size: 12px; color: var(--soft); margin-bottom: 6px; }
  .history:hover { color: var(--ink); }

  /* the backlog: sprints to fill and play, and everything not in one */
  #backlog { padding: 12px 20px 32px; max-width: 1100px; }
  .group { background: var(--col); border-radius: 10px; padding: 8px; margin-bottom: 14px; border: 2px solid transparent; }
  .ghead { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 4px 6px 9px; }
  .gname { font-weight: 650; font-size: 15px; }
  .gmeta { color: var(--soft); font-size: 13px; }
  .state { border-radius: 4px; padding: 0 7px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: var(--chip); color: var(--soft); }
  .state.running, .state.building { color: var(--blue); }
  .state.build, .state.done { color: var(--go); }
  .prog { flex: 0 0 110px; height: 6px; background: var(--chip); border-radius: 999px; overflow: hidden; }
  .prog i { display: block; height: 100%; background: var(--go); }
  .ghead .push { margin-left: auto; display: flex; gap: 6px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; background: var(--panel); padding: 7px 10px; border-bottom: 1px solid var(--line); }
  .row:first-of-type { border-radius: 8px 8px 0 0; }
  .row:last-of-type { border-radius: 0 0 8px 8px; border-bottom: 0; }
  .row:only-of-type { border-radius: 8px; }
  .row .right { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--soft); white-space: nowrap; }
  .group .add, .group .adding { margin-top: 8px; }
  .about { padding: 0 6px 10px; font-size: 13px; color: var(--soft); cursor: pointer; }
  .about b { color: var(--ink); font-weight: 600; }
  .about:hover { color: var(--ink); }
  .aboutform { padding: 0 6px 10px; display: grid; gap: 6px; max-width: 720px; }
  .aboutform input { padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }

  /* what waits on the human: on its thread, or in the strip at the top of the backlog when it has none */
  .need { background: var(--panel); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; box-shadow: var(--shadow); }
  .need .what { font-weight: 600; overflow-wrap: anywhere; }
  .need .more { color: var(--soft); font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
  .need .chose { margin-top: 6px; }
  .need .acts { flex-wrap: wrap; align-items: center; margin-top: 10px; }
  .say { display: inline-flex; flex: 1 1 260px; gap: 6px; }
  .say input { flex: 1; min-width: 0; padding: 5px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
  .acts.wrap { flex-wrap: wrap; align-items: center; margin-top: 8px; }
  /* A question's options: each grows to fill its line, so options that wrap are one to a line, at one width. */
  div.opts { display: flex; flex-wrap: wrap; gap: 6px; }
  div.opts > button { flex: 1 1 auto; max-width: 100%; margin: 0; }
  .acts > div.opts { flex: 0 1 auto; }
  .notice div.opts { margin-top: 8px; }
  .need ul { margin: 6px 0 0; padding-left: 18px; color: var(--soft); font-size: 13px; }

  /* the ticket */
  /* Settings: one panel over the page, a section a kind of setting, a row each. */
  #settingsveil { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 5; }
  #settings { position: fixed; z-index: 6; top: 5vh; left: 50%; transform: translateX(-50%); width: min(720px, calc(100vw - 32px)); max-height: 90vh; overflow-y: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 24px 64px rgba(0, 0, 0, .3); padding: 18px 22px 22px; }
  #settings .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  #settings h2 { margin: 0; font-size: 19px; }
  #settings .shut { border: 0; background: none; color: var(--soft); padding: 2px 6px; font-size: 18px; line-height: 1; }
  #settings .what { margin: 4px 0 6px; font-size: 13px; color: var(--soft); }
  #settings .ssec h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin: 20px 0 4px; }
  #settings .srow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 18px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
  #settings .srow.slim { padding: 6px 0; }
  #settings .srow.dim .stext { opacity: .55; }
  #settings .sname { font-weight: 600; }
  #settings .stext p { margin: 2px 0 0; font-size: 12px; color: var(--soft); }
  #settings .stext p:empty { display: none; }
  #settings .cmd { display: inline-block; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--soft); background: var(--chip); border-radius: 4px; padding: 1px 5px; }
  #settings .sctl { display: flex; justify-content: flex-end; }
  #settings input[type=checkbox] { appearance: none; width: 34px; height: 20px; border-radius: 10px; background: var(--line); position: relative; cursor: pointer; margin: 0; flex: none; transition: background .15s; }
  #settings input[type=checkbox]::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: var(--shadow); transition: left .15s; }
  #settings input[type=checkbox]:checked { background: var(--go); }
  #settings input[type=checkbox]:checked::after { left: 16px; }
  #settings input[type=checkbox]:disabled { opacity: .5; cursor: default; }
  #settings input[type=checkbox]:focus-visible, #settings button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  #settings input[type=number] { width: 64px; text-align: right; }
  #settings .unit { display: inline-flex; align-items: center; gap: 8px; color: var(--soft); font-size: 13px; }
  #settings .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  #settings .seg button { border: 0; border-radius: 0; background: none; padding: 5px 12px; color: var(--soft); }
  #settings .seg button + button { border-left: 1px solid var(--line); }
  #settings .seg button.on { background: var(--chip); color: var(--ink); font-weight: 600; }
  #settings .seg button[aria-disabled=true] { opacity: .45; cursor: not-allowed; }
  #settings .agents { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  #settings .count { display: inline-flex; align-items: center; gap: 6px; }
  #settings .count .name { min-width: 64px; text-align: right; color: var(--soft); font-size: 13px; }
  #settings .count button { width: 26px; height: 26px; padding: 0; }
  #settings .count .n { min-width: 18px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
  #settings .coming { margin: 0; padding: 8px 0 0; border-top: 1px solid var(--line); font-size: 12px; color: var(--soft); font-style: italic; }
  #settings .coming.via { font-style: normal; }
  @media (max-width: 760px) {
    #settings { top: 0; bottom: 0; max-height: none; width: 100vw; border: 0; border-radius: 0; padding: 16px; }
    #settings .srow { grid-template-columns: 1fr; }
    #settings .sctl, #settings .agents { justify-content: flex-start; align-items: flex-start; }
  }
  #veil { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 3; }
  #thread { position: fixed; z-index: 4; top: 5vh; left: 50%; transform: translateX(-50%); width: min(1000px, 96vw); max-height: 90vh; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow-y: auto; padding: 22px 24px 26px; box-shadow: 0 24px 64px rgba(0, 0, 0, .3); }
  .ticket { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 28px; }
  @media (max-width: 760px) { .ticket { grid-template-columns: 1fr; } #thread { top: 0; bottom: 0; max-height: none; border: 0; border-radius: 0; width: 100vw; padding: 18px 16px 24px; } }
  #thread .key { font-size: 12px; color: var(--soft); margin: 0 40px 6px 0; cursor: default; }
  #thread h2 { font-size: 21px; margin: 0 0 6px -4px; overflow-wrap: anywhere; border-radius: 6px; padding: 2px 4px; outline: none; cursor: text; }
  #thread h2:hover, #thread h2:focus { background: var(--chip); }
  #thread h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin: 22px 0 8px; }
  #thread .x { position: absolute; top: 14px; right: 16px; }
  #thread .title { cursor: text; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 6px 0; }
  textarea { width: 100%; min-height: 54px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); resize: vertical; }
  .side { border-left: 1px solid var(--line); padding-left: 22px; }
  @media (max-width: 760px) { .side { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); } }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin-bottom: 5px; }
  .field select, .field input { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .field .val { font-size: 14px; }
  .field .hint { margin-top: 4px; font-size: 12px; color: var(--soft); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .feed { margin-top: 18px; }
  .post { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 18px; }
  .post::before { content: ''; position: absolute; left: 19px; top: 44px; bottom: 2px; width: 2px; background: var(--line); }
  .post:last-child::before { display: none; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 15px; color: #fff; background: var(--soft); flex: none; }
  .avatar.you { background: var(--ink); color: var(--bg); overflow: hidden; }
  .avatar.you svg, .avatar.who22.you svg { width: 100%; height: 100%; }
  .avatar.claude { background: #fbf3ea; border: 1px solid #ecd9c6; }
  .avatar.codex { background: var(--chip); color: var(--ink); }
  .avatar svg { width: 26px; height: 26px; }
  .avatar.who22 { width: 22px; height: 22px; font-size: 11px; }
  .avatar.who22 svg { width: 15px; height: 15px; }
  .byline { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; min-height: 20px; }
  .byline b { font-weight: 650; }
  .byline .model { background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--soft); }
  .byline .at, .sep { color: var(--soft); font-size: 13px; }
  .byline .stop { margin-left: auto; align-self: center; }
  .livepost .session { margin-top: 6px; display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--soft); }
  .note .ran { white-space: nowrap; }
  .post pre { margin: 2px 0 0; line-height: 1.5; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; background: var(--chip); border-radius: 4px; padding: 0 4px; overflow-wrap: anywhere; }
  /* What an agent wrote in Markdown: a block of code, a list, a link out. */
  pre pre.code { margin: 6px 0; padding: 8px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre; overflow-x: auto; }
  pre ul, pre ol { margin: 4px 0; padding-left: 22px; }
  pre li + li { margin-top: 2px; }
  a.out { color: var(--blue); }
  /* The agent at work: a calm pulse on its avatar, and a caret after what it is doing now. */
  .avatar { position: relative; }
  .avatar .pulse { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border-radius: 50%; background: var(--blue); border: 2px solid var(--panel); animation: pulse 1.6s ease-in-out infinite; }
  .livenow { margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
  .caret { display: inline-block; width: 7px; height: 14px; margin-left: 3px; vertical-align: -2px; background: var(--blue); animation: blink 1.1s steps(2, start) infinite; }
  @keyframes blink { to { visibility: hidden; } }
  .typing .dots { color: var(--soft); font-style: italic; }
  .typing .dots span { animation: typing 1.2s infinite; }
  .typing .dots span:nth-child(2) { animation-delay: .2s; }
  .typing .dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes typing { 0%, 60%, 100% { opacity: .2; } 30% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .pulse, .caret, .typing .dots span { animation: none !important; } }
  .post .badge { display: inline-block; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--go); }
  .post .badge.ask { color: var(--warn); }
  .event { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 10px; font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }
  .event::before { content: ''; position: absolute; left: 19px; top: 0; bottom: 0; width: 2px; background: var(--line); }
  .event .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); margin: 6px auto 0; position: relative; box-shadow: 0 0 0 3px var(--panel); }
  .event .sep { margin: 0 5px; }
  .fold { justify-self: start; background: none; border: 0; padding: 0; color: var(--soft); font-size: 13px; }
  .fold:hover { color: var(--ink); text-decoration: underline; }
  .feed > .empty { padding: 0 0 14px 52px; }
  .compose { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; margin-top: 6px; }
  .compose textarea { min-height: 44px; }
  .compose .acts { margin-top: 8px; align-items: center; justify-content: flex-end; gap: 12px; }
  .compose .hint { font-size: 12px; color: var(--soft); }
  .compose button:disabled { opacity: .45; cursor: default; }
  /* Where the keyboard is, in the ticket: one quiet ring, the palette's blue. */
  #thread button:focus-visible, #thread a:focus-visible, #thread summary:focus-visible, #thread select:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
  #thread textarea:focus, #thread input:focus { outline: none; border-color: var(--blue); }
  .notice { margin: 12px 0 0; padding: 10px 14px 12px; border-radius: 10px; background: var(--chip); border-left: 3px solid var(--soft); overflow-wrap: anywhere; }
  .notice .head { font-weight: 650; }
  .notice.you { border-left-color: var(--warn); } .notice.you .head { color: var(--warn); }
  .notice.thread { border-left-color: var(--blue); }
  .notice.stuck { border-left-color: var(--hot); } .notice.stuck .head { color: var(--hot); }
  .notice .what { margin-top: 2px; }
  .notice .soft { margin-top: 6px; font-size: 13px; color: var(--soft); }
  .notice button { margin: 8px 6px 0 0; }
  .notice a { display: block; margin-top: 4px; color: var(--ink); text-decoration: none; }
  .notice a:hover { text-decoration: underline; }
  #thread .notice a .key { margin: 0; font-size: 12px; color: var(--soft); cursor: pointer; }
  details.desc { margin: 12px 0 0; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  details.desc summary { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); cursor: pointer; }
  details.desc .kind { margin: 10px 0 4px; font-weight: 600; }
  details.desc .kind span { font-weight: 400; color: var(--soft); }
  details.desc .part { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; padding: 9px 0 0; margin-top: 9px; border-top: 1px solid var(--line); }
  details.desc .part .icon { font-size: 18px; line-height: 1.2; text-align: center; }
  details.desc .part .label { font-size: 12px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; color: var(--soft); }
  details.desc .part pre { margin: 2px 0 0; }
  details.desc .part.why .label { color: var(--go); }
  details.desc .part.done .label { color: var(--blue); }
  .lineage-sections section { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
  .lineage-sections h4 { font-size: 12px; color: var(--soft); margin: 0; }
  .lineage-sections pre { line-height: 1.45; }
  .changes { margin-top: 12px; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .plus { color: var(--go); } .minus { color: var(--hot); }
  .changes .sum { margin-top: 10px; font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
  .changes .commits { margin: 4px 0 10px; font-size: 12px; color: var(--soft); }
  .changes .commits .mono { margin-right: 4px; }
  .changes .file { border: 1px solid var(--line); border-radius: 8px; margin-top: 6px; overflow: hidden; min-width: 0; }
  .changes .filehead { display: flex; align-items: center; gap: 10px; padding: 6px 10px; font-size: 13px; cursor: pointer; user-select: none; }
  .changes .filehead:hover { background: var(--chip); }
  .changes .twist { color: var(--soft); width: 10px; }
  .changes .path { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .changes .dir { color: var(--soft); }
  .changes .word { font-size: 11px; color: var(--soft); background: var(--chip); border-radius: 6px; padding: 1px 6px; }
  .changes .stat { display: inline-flex; gap: 1px; }
  .changes .stat i { width: 7px; height: 7px; border-radius: 1px; background: var(--line); }
  .changes .stat i.plus { background: var(--go); } .changes .stat i.minus { background: var(--hot); }
  .changes .filebody { border-top: 1px solid var(--line); background: var(--bg); }
  .changes .filebody .note { padding: 6px 10px; }
  .changes .scroll { max-height: 520px; overflow: auto; }
  .changes table.lines { border-collapse: collapse; min-width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; tab-size: 4; }
  .changes table.lines td { padding: 0; white-space: pre; }
  .changes td.num { width: 1%; min-width: 34px; padding: 0 6px; text-align: right; color: var(--soft); opacity: 0.7; user-select: none; }
  .changes td.sign { width: 1%; padding: 0 4px; user-select: none; }
  .changes td.code { padding-right: 10px; }
  .changes tr.plus td.sign { color: var(--go); } .changes tr.minus td.sign { color: var(--hot); }
  .changes tr.plus, .changes tr.minus { color: var(--ink); }
  .changes tr.plus { background: color-mix(in srgb, var(--go) 14%, transparent); }
  .changes tr.minus { background: color-mix(in srgb, var(--hot) 14%, transparent); }
  .changes tr.none td.code { color: var(--soft); font-style: italic; }
  .changes tr.at td { color: var(--soft); background: var(--chip); padding: 1px 10px; }
  .undo { margin-top: 12px; display: grid; gap: 8px; }
  .undo input { padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .proposals { margin-top: 18px; }
  .proposal { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--line); }
  .proposal .ptext { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .proposal .pn { color: var(--soft); font-variant-numeric: tabular-nums; }
  .proposal .acts { margin-top: 0; flex: none; }
  .proposal .acts button { min-width: 56px; padding: 9px 14px; }
  .proposal .said { flex: none; font-size: 12px; font-weight: 600; color: var(--soft); }
  .proposal .said.yes { color: var(--go); }
  @media (max-width: 700px) { .proposal { flex-wrap: wrap; } .proposal .acts { width: 100%; } .proposal .acts button { flex: 1; } }
  .finish { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line); }
  .finish button { width: 100%; padding: 10px; font-size: 15px; }
  .finish .ok { color: var(--go); font-weight: 600; }
  #said { position: fixed; z-index: 5; left: 50%; bottom: 18px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 999px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #said.on { opacity: 1; }

  /* The keyboard: the thread it is on, and the small boxes it opens over the page. They are one
     family with the ticket: its radius, its border, its shadow and its veil. */
  .card.kfocus, .row.kfocus { outline: 2px solid var(--blue); outline-offset: 1px; }
  #layerveil { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 6; }
  /* Over an open ticket its veil is already down: a second one would only darken the page. */
  #veil:not([hidden]) ~ #layerveil { background: transparent; }
  #layer { position: fixed; z-index: 7; top: 12vh; left: 50%; transform: translateX(-50%); width: min(560px, calc(100vw - 32px)); max-height: 76vh; overflow-y: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 24px 64px rgba(0, 0, 0, .3); padding: 14px 16px; }
  #layer h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin: 4px 0 10px; }
  #layer .keyrow { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 10px; padding: 3px 0; font-size: 13px; }
  #layer kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--chip); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  #layer textarea, #layer input { display: block; width: 100%; min-height: 0; border: 0; border-radius: 0; background: transparent; padding: 4px 2px; font-size: 15px; outline: none; resize: none; }
  #layer .chips:empty { display: none; }
  #layer .hits { margin: 8px -8px 0; padding-top: 6px; border-top: 1px solid var(--line); }
  #layer .hit { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
  #layer .hit.on { background: var(--chip); }
  #layer .hit .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #layer .hit .soft { color: var(--soft); font-size: 12px; white-space: nowrap; }
  #thread .copyid { cursor: pointer; }
  .copyid:hover, .copylink:hover { color: var(--ink); }
  .copylink { background: none; border: 0; padding: 0 0 0 6px; color: var(--soft); vertical-align: -2px; }
  .copylink svg { width: 13px; height: 13px; }
  #layer .foot { margin: 10px 0 0; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px; color: var(--soft); }
  /* On a phone: the bar in two rows, one column of the board at a time, and nothing to tap under 36px. */
  .jump { display: none; }
  @media (max-width: 700px) {
    /* The first row is the project's name and the views; the second, the search, who builds, the
       agents and the theme. The search is a button there, and its box opens over that row. */
    .bar { flex-wrap: wrap; height: auto; gap: 0 8px; padding: 0 16px; }
    .bar::after { content: ''; order: 4; flex-basis: 100%; }
    /* Where the row is short (a narrow phone, a wide font), the version gives way first, whole: it
       wraps to a second line that is never shown. Only then is the name cut, at its end. */
    .brand { order: 1; flex: 1 1 0; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; height: 1.5em; line-height: 1.5; overflow: hidden; font-size: 16px; }
    .brand .name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .where { margin-left: 4px; }
    .tabs { order: 2; height: 44px; }
    .searchbtn { order: 5; display: inline-grid; place-items: center; width: 36px; padding: 0; margin: 0 0 8px; color: var(--soft); }
    .searchbtn svg { width: 16px; height: 16px; }
    .search { display: none; }
    .bar.searching .search { display: block; position: absolute; z-index: 1; left: 16px; right: 16px; bottom: 8px; width: auto; margin: 0; background: var(--panel); }
    .builder { order: 6; margin: 0 0 8px; }
    .roster { order: 6; margin: 0 0 8px; }
    .runner { order: 7; margin-bottom: 8px; }
    .themer { order: 8; margin: 0 0 8px auto; width: 36px; height: 36px; }
    .gear + .themer { margin-left: 0; }
    /* No room for the bell on either row: on a phone, what notifies him is said to the chat. */
    .notifier { display: none; }
    #notices { left: 16px; right: 16px; width: auto; }
    /* In Chat mode the usage target is a row of its own: the meter runs the width of the phone. */
    .target { order: 9; flex: 1 0 100%; margin: 0 0 8px; justify-content: flex-start; }
    .target .label { display: inline; }
    .target .meter { flex: 1 1 auto; width: auto; }
    #targets { left: 16px; right: 16px; width: auto; }
    .rule, #away { padding-left: 16px; padding-right: 16px; }
    #quick { padding: 8px 16px 0; }
    .jump { display: flex; gap: 6px; padding: 8px 16px 0; }
    .jump button { flex: 1 1 0; min-width: 0; padding: 0 6px; font-size: 13px; color: var(--soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .jump button.on { color: var(--ink); border-color: var(--soft); font-weight: 600; }
    #board { grid-template-columns: repeat(4, 100%); padding: 8px 16px 32px; scroll-snap-type: x mandatory; scroll-padding: 0 16px; overscroll-behavior-x: contain; }
    #board .col { scroll-snap-align: start; }
    #backlog { padding: 12px 16px 32px; }
    .row { grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .row .right { flex-wrap: wrap; white-space: normal; }
    button, .search { min-height: 36px; }
    .tick, .arch { width: 36px; height: 36px; }
  }
  #said.undoable { pointer-events: auto; }
  #said button { margin-left: 12px; padding: 0; border: 0; background: none; color: inherit; font-weight: 650; text-decoration: underline; }
`;
