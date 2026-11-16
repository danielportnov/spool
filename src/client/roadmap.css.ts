/**
 * The Roadmap view's styles: put after the page's own by `page.html.ts`. They use the page's colours,
 * surfaces and type as they are, and add none. Inside the string: no backticks and no `${`.
 */

export const ROADMAP_CSS = String.raw`
  /* the roadmap: the goals, then the sprints in a row, reached, playing and to come */
  #roadmap { padding: 12px 20px 32px; }
  .rgoals { max-width: 760px; margin: 0 0 16px; padding: 0 6px; }
  .rgoals h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); font-weight: 600; margin: 0 0 6px; }
  .rgoals .rfor { font-weight: 600; overflow-wrap: anywhere; }
  .rgoals .rlabel { color: var(--soft); font-weight: 400; }
  .rgoals .rtowards { margin: 4px 0 0; padding-left: 18px; font-size: 13px; overflow-wrap: anywhere; }
  .rgoals .rtowards li + li { margin-top: 2px; }
  .rgoals .rtowards li::marker { color: var(--soft); }
  .lane .serves { font-size: 12px; color: var(--soft); overflow-wrap: anywhere; }
  .rgoals.none { color: var(--soft); font-size: 13px; }
  .lanes { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 4px; }
  .lane { flex: 1 1 240px; min-width: 220px; background: var(--col); border-radius: 10px; padding: 10px 10px 12px; border: 2px solid transparent; }
  .lane.now { flex: 2 1 380px; min-width: 320px; background: var(--panel); border-color: var(--line); box-shadow: var(--shadow); }
  .lane.past { flex: 0 1 190px; min-width: 170px; }
  .lane.past .gname { font-size: 14px; }
  .lane.past, .lane.past .gmeta { color: var(--soft); }
  .lane > * + * { margin-top: 8px; }
  .lhead { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .lhead .push { margin-left: auto; }
  .lane .about { padding: 0; cursor: default; }
  .lane .about:hover { color: var(--soft); }
  blockquote.vision { margin: 8px 0 0; padding: 2px 0 2px 12px; border-left: 3px solid var(--line); color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; }
  .rprog { display: flex; align-items: center; gap: 10px; }
  .rprog .prog { flex: 1 1 auto; max-width: 260px; }
  .rrows { display: grid; }
  .lane.now .rrow + .rrow { border-top: 1px solid var(--line); }
  .lane:not(.now) .rrows { gap: 4px; }
  .rrow { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 9px; background: var(--panel); font-size: 13px; cursor: pointer; }
  .lane:not(.now) .rrow { border-radius: 7px; }
  .rrow:hover .rtitle { text-decoration: underline; }
  .rrow.kfocus { outline: 2px solid var(--blue); outline-offset: -2px; }
  .rrow .state { flex: none; display: inline-flex; align-items: center; gap: 5px; }
  .rrow .rtitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state.you { color: var(--warn); }
  .state .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--blue); animation: pulse 1.6s ease-in-out infinite; }
  .lane .acts { margin-top: 10px; }
  /* In the light theme the chip's grey is the lane's own, as on the board's columns: it takes the line's. */
  [data-theme="light"] :is(.lane.now .prog, .lane .size, .lane:not(.now) .state) { background: var(--line); }

  @media (max-width: 700px) {
    #roadmap { padding: 12px 16px 32px; }
    /* Three views in the bar: each tab a little narrower, so the project's name still has room. */
    .tab { padding: 0 6px; }
    .lanes { flex-direction: column; align-items: stretch; overflow-x: visible; }
    .lane, .lane.now, .lane.past { flex: none; min-width: 0; }
  }
`;
