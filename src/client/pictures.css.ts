/**
 * The styles of pictures on the page: put after the page's own by `page.html.ts`. They use the
 * page's colours and surfaces as they are, and add none: the full-size picture is framed as the
 * ticket is, over the same veil. Inside the string: no backticks and no `${`.
 */

export const PICTURES_CSS = String.raw`
  /* under a box: the pictures waiting to go with what is typed */
  .tray:empty { display: none; }
  .tray { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .tray .pending { position: relative; width: 64px; height: 64px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); overflow: hidden; }
  .tray .pending img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tray .off { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; padding: 0; display: grid; place-items: center; font-size: 11px; line-height: 1; border-radius: 50%; }
  textarea.dropping { border-color: var(--blue) !important; }

  /* in the conversation: under the words, at a size that reads, a click from full size */
  .pictures { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  button.picture { padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); overflow: hidden; cursor: zoom-in; line-height: 0; max-width: 100%; }
  button.picture:hover { border-color: var(--soft); }
  button.picture img { display: block; max-width: min(100%, 360px); max-height: 240px; object-fit: contain; }

  .pictures figure { margin: 0; min-width: 0; }
  .pictures figcaption { margin-top: 4px; font-size: 12px; color: var(--soft); }

  /* full size, over everything */
  #picture { position: fixed; inset: 0; z-index: 8; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, .35); }
  #picture .frame { position: relative; max-width: 100%; max-height: 100%; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px; box-shadow: 0 24px 64px rgba(0, 0, 0, .3); }
  #picture img { display: block; max-width: min(1400px, calc(100vw - 64px)); max-height: calc(100vh - 110px); object-fit: contain; border-radius: 6px; }
  #picture .about { display: flex; align-items: center; gap: 12px; margin: 10px 0 0 2px; font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }
  #picture .about > span { flex: 1; min-width: 0; }
  #picture .about b { color: var(--ink); font-weight: 650; }
  #picture .x { flex: none; }
`;
