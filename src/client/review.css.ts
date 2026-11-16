/**
 * A sprint review's styles: put after the page's own by `page.html.ts`. The ticket's type and the
 * board's surfaces, and no colour of its own. Inside the string: no backticks and no `${`.
 */

export const REVIEW_CSS = String.raw`
  /* a sprint's review: one column, read top to bottom, in the ticket's type */
  .review { max-width: 760px; }
  .review .back { width: auto; padding: 4px 6px; margin: 0 0 6px -6px; }
  .review h2 { font-size: 21px; margin: 0; overflow-wrap: anywhere; }
  .review h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin: 22px 0 8px; }
  .review .rgoal { margin-top: 8px; }
  .review > .about { padding: 8px 0 0; cursor: default; }
  .review > .about:hover { color: var(--soft); }
  .rhead { margin: 14px 0 12px; font-weight: 600; }
  .rthread { padding: 12px 14px; margin-bottom: 10px; }
  .rtop { display: flex; align-items: baseline; gap: 8px; }
  .rtop .push { margin-left: auto; }
  .rtop .chip, .rtop .state { flex: none; }
  .rpart { margin-top: 10px; }
  .rpart .label { font-size: 12px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; color: var(--soft); margin-bottom: 4px; }
  ol.ticks { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  ol.ticks li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; align-items: start; font-size: 13px; overflow-wrap: anywhere; }
  ol.ticks li > span { cursor: pointer; }
  ol.ticks li.on > span { color: var(--soft); text-decoration: line-through; }
  ol.ticks .box { width: 18px; height: 18px; min-height: 0; padding: 0; margin-top: 1px; border-radius: 5px; display: grid; place-items: center; font-size: 12px; line-height: 1; color: var(--go); }
  ol.ticks .box[aria-checked="true"] { background: var(--go); border-color: var(--go); }
  ol.ticks .box[aria-checked="true"]::after { content: '✓'; color: var(--panel); font-weight: 700; }
  .rcall { padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line); font-size: 13px; overflow-wrap: anywhere; }
  .rcall + .rcall { margin-top: 6px; }
  .rcall .note { margin-top: 2px; }
  .rcall .badge { display: inline-block; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--go); }
  .rcall .badge.ask { color: var(--warn); }
  .rthread .meta .act:first-of-type { margin-left: auto; }
  .rundone .note { margin-top: 4px; }
  .review .finish .note { margin-top: 8px; }

  @media (max-width: 700px) {
    ol.ticks .box { width: 22px; height: 22px; }
  }
`;
