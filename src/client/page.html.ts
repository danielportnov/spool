/**
 * The page itself: the one document the server sends, whole.
 *
 * The markup is here; the styles (`page.css.ts`) and the script (`page.js.ts`) are put into it,
 * so what is served is still a single page that loads nothing else. Each part of the page with files
 * of its own (the roadmap, a sprint's review, the projects, pictures) is joined after them. The
 * server fills in `__TOKEN__` and `__BUILD__` as it sends it. Inside the string: no backticks, and
 * no `${` but the two that place the styles and the script.
 */

import { CSS } from './page.css.ts';
import { JS } from './page.js.ts';
import { PICTURES_CSS } from './pictures.css.ts';
import { PICTURES_JS } from './pictures.js.ts';
import { PROJECTS_CSS } from './projects.css.ts';
import { PROJECTS_JS } from './projects.js.ts';
import { REVIEW_CSS } from './review.css.ts';
import { REVIEW_JS } from './review.js.ts';
import { ROADMAP_CSS } from './roadmap.css.ts';
import { ROADMAP_JS } from './roadmap.js.ts';

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spool</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🧶%3C/text%3E%3C/svg%3E" id="icon">
<script>
// Light or dark: his pick in this browser, or else the system's, set on the root before anything is
// drawn so the page never shows the other one first. Every colour follows the one attribute.
const SYSTEM_DARK = matchMedia('(prefers-color-scheme: dark)');
function paintTheme() {
  let pick = 'system';
  try { pick = localStorage.getItem('spool-theme') || 'system'; } catch (e) {}
  if (!['system', 'light', 'dark'].includes(pick)) pick = 'system';
  document.documentElement.dataset.theme = pick === 'system' ? (SYSTEM_DARK.matches ? 'dark' : 'light') : pick;
  return pick;
}
paintTheme();
SYSTEM_DARK.addEventListener('change', paintTheme);
</script>
<style>
${CSS + ROADMAP_CSS + REVIEW_CSS + PROJECTS_CSS + PICTURES_CSS}</style>
</head>
<body>
<div class="bar">
  <div class="brand"><span class="name">🧶 <span id="project">Spool</span></span><span class="where" id="where"></span></div>
  <div class="tabs">
    <button class="tab" data-view="board">Board</button>
    <button class="tab" data-view="backlog">Backlog</button>
    <button class="tab" data-view="roadmap">Roadmap</button>
  </div>
  <input class="search" id="search" placeholder="Search threads   /" autocomplete="off">
  <button class="searchbtn" id="searchbtn" title="Search   /" aria-label="Search"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg></button>
  <div class="builder" id="builder" role="group" aria-label="Who builds" hidden><button data-builder="headless">Headless</button><button data-builder="chat">Chat</button></div>
  <button class="roster" id="roster" aria-haspopup="dialog" aria-controls="settings" hidden></button>
  <button class="runner" id="runner" hidden></button>
  <button class="target" id="target" aria-haspopup="dialog" aria-expanded="false" aria-controls="targets" hidden></button>
  <button class="takeover" id="takeover" aria-haspopup="dialog" aria-expanded="false" aria-controls="takeovers" hidden></button>
  <button class="themer notifier" id="notifier" aria-haspopup="dialog" aria-expanded="false" aria-controls="notices" hidden></button>
  <button class="themer gear" id="gear" title="Settings" aria-label="Settings" aria-haspopup="dialog" aria-expanded="false" aria-controls="settings"></button>
  <button class="themer" id="themer"></button>
  <div id="targets" role="dialog" aria-label="Usage target" hidden></div>
  <div id="takeovers" role="dialog" aria-label="Take over the backlog" hidden></div>
  <div id="notices" role="dialog" aria-label="Notifications" hidden></div>
</div>
<div id="away" role="status" hidden></div>
<div class="rule" id="rule" hidden></div>
<div id="quick"></div>
<nav class="jump" id="jump" aria-label="Columns"></nav>
<main id="board"></main>
<main id="backlog" hidden></main>
<main id="roadmap" hidden></main>
<div id="veil" hidden></div>
<aside id="thread" hidden></aside>
<div id="said"></div>
<div id="settingsveil" hidden></div>
<aside id="settings" role="dialog" aria-modal="true" aria-label="Settings" hidden></aside>
<div id="layerveil" hidden></div>
<div id="layer" role="dialog" aria-modal="true" hidden></div>
<script>
${JS + ROADMAP_JS + REVIEW_JS + PROJECTS_JS + PICTURES_JS}</script>
</body>
</html>
`;
