/**
 * The styles of the project switcher and the home view (`projects.js.ts`), put after the page's
 * own by `page.html.ts`. Colours come from the page's variables in `:root`; none is added. Inside
 * the string: no backticks and no `${`.
 */

export const PROJECTS_CSS = String.raw`
  /* the project in the bar, as a switcher: its name and a small caret */
  .pswitch { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; font: inherit; font-weight: 700; background: none; border: 1px solid transparent; padding: 3px 7px; margin: 0 -7px 0 -3px; }
  .pswitch:hover, .pswitch[aria-expanded="true"] { border-color: var(--line); background: var(--bg); }
  .pnow { overflow: hidden; text-overflow: ellipsis; }
  .pcaret { flex: none; width: 7px; height: 7px; margin-top: -3px; border-right: 1.5px solid var(--soft); border-bottom: 1.5px solid var(--soft); transform: rotate(45deg); }
  .pdot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
  .pmenu { position: absolute; top: calc(100% - 4px); left: 14px; z-index: 5; width: min(360px, calc(100vw - 28px)); max-height: 70vh; overflow: auto; padding: 5px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); }
  .pitem { display: grid; gap: 1px; width: 100%; text-align: left; border: 0; border-radius: 7px; padding: 7px 10px; background: none; }
  .pitem:hover { background: var(--chip); }
  .pitem.on { background: var(--bg); box-shadow: inset 3px 0 0 var(--accent); }
  .pitem .pname, .prow .pname { font-weight: 600; overflow-wrap: anywhere; }
  .psub { font-size: 12px; color: var(--soft); font-weight: 400; overflow-wrap: anywhere; }
  .pneeds { margin-left: 8px; font-size: 12px; font-weight: 600; color: var(--warn); white-space: nowrap; }
  .pneeds::before { content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 5px 1px 0; border-radius: 50%; background: currentColor; }
  .psep { height: 1px; margin: 4px 6px; background: var(--line); }
  .elsewhere { font-size: 13px; color: var(--soft); }

  /* the home view: the brief across every project, then a row for each */
  body.at-home :is(.tabs, .search, .builder, .runner, #elsewhere, #brief, #jump, #board, #backlog, #thread, #veil) { display: none !important; }
  #home { max-width: 860px; padding: 14px 20px 40px; }
  .hbrief { background: var(--col); border-radius: 10px; padding: 8px; margin-bottom: 14px; }
  .hbrief .hhead { padding: 4px 6px; font-weight: 600; overflow-wrap: anywhere; }
  .hbrief h2 { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; margin: 12px 6px 6px; display: flex; gap: 8px; color: var(--soft); font-weight: 600; }
  .hbrief h2 .count { background: var(--line); border-radius: 999px; padding: 0 8px; }
  .hline { display: grid; gap: 1px; width: 100%; text-align: left; margin-bottom: 6px; border-color: transparent; box-shadow: var(--shadow); padding: 7px 10px; }
  .hline:hover { border-color: var(--line); }
  .htitle { overflow-wrap: anywhere; }
  .prows { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .prow { background: var(--panel); border-radius: 10px; padding: 4px 12px 10px; box-shadow: var(--shadow); border: 1px solid transparent; }
  .prow:hover { border-color: var(--line); }
  .prow.waits { box-shadow: inset 3px 0 0 var(--warn), var(--shadow); }
  .phead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; width: calc(100% + 16px); margin: 0 -8px; padding: 6px 8px; text-align: left; background: none; border: 0; }
  .phead .pneeds { margin-left: 0; }
  .phead .psub { margin-left: auto; }
  .phead:hover .pname { text-decoration: underline; }
  .hneed { margin-top: 4px; font-size: 13px; color: var(--warn); overflow-wrap: anywhere; }
  .hsprint { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 13px; }
  .hsprint > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbar { flex: 1; max-width: 160px; height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .hbar span { display: block; height: 100%; background: var(--go); }
  @media (max-width: 700px) {
    #home { padding: 12px 16px 32px; }
    .phead .psub { margin-left: 0; flex-basis: 100%; }
  }
`;
