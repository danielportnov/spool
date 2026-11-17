/**
 * Pictures and files on the page: put after the page's own script by `page.html.ts`.
 *
 * A file (a PDF, or plain text) goes the way a picture does: pasted, dropped on the box or anywhere on
 * a thread, or picked with the 📎 button. It waits under the box by its name, and in the conversation
 * it is a link that opens it in a tab of its own.
 *
 * A picture pasted or dropped into the reply box, + Add or quick add waits under the box as a small
 * thumbnail, and goes with what is typed: it is sent to `/api/attach` once the reply is posted or the
 * thread exists, as its raw bytes, and the server runs `spool attach` on it. In a thread's
 * conversation a picture shows under the words it came with, and a click opens it full size, over
 * the ticket. A finished thread's before and after are shown together under its result. Inside the
 * string: no backticks and no `${`.
 */

export const PICTURES_JS = String.raw`
// ---- pictures: pasted or dropped into a box, kept with the thread, shown in its conversation

// The server's own limit, said here too so a picture too big is refused before it is sent.
const PICTURE_MAX = 5 * 1024 * 1024;
// What waits under each box to be sent: the reply box by its thread's id, + Add by its column, quick add as 'quick'.
const pending = new Map();
const pendingOf = (key) => pending.get(key) || [];

// What a thread keeps: a picture, a PDF, or plain text. The server reads the bytes to be sure; this only spares a wasted send.
const isImage = (file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type);
const keeps = (file) => isImage(file) || file.type === 'application/pdf' || /\.(pdf|txt|md|csv|json|log)$/i.test(file.name || '');
const KEEPS = 'Only a picture (PNG, JPEG, GIF, WebP), a PDF or a text file (.txt .md .csv .json .log) can be kept.';
const PICK = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,.txt,.md,.csv,.json,.log';

function addPictures(key, files) {
  const list = pendingOf(key).slice();
  for (const file of files) {
    if (!keeps(file)) { say(KEEPS); continue; }
    if (file.size > PICTURE_MAX) { say('That ' + (isImage(file) ? 'picture' : 'file') + ' is too big: keep it under 5 MB.'); continue; }
    list.push({ file, url: isImage(file) ? URL.createObjectURL(file) : '' });
  }
  pending.set(key, list);
  fillTrays(key);
}
function unpend(key, from) {
  const list = pendingOf(key);
  for (const p of list.slice(0, from)) if (p.url) URL.revokeObjectURL(p.url);
  if (list.length > from) pending.set(key, list.slice(from)); else pending.delete(key);
  fillTrays(key);
}

// The tray under a box: each picture waiting to go, with a ✕ to take it off before it is sent.
// It is drawn again in place when a picture comes or goes, since the ticket is not redrawn for that.
function trayNode(key, changed) {
  const node = el('div', { class: 'tray', 'data-tray': key });
  node.fill = () => {
    node.replaceChildren(...pendingOf(key).map((p, i) => el('div', { class: 'pending' + (p.url ? '' : ' file'), title: p.url ? null : p.file.name },
      p.url ? el('img', { src: p.url, alt: 'A picture to send' }) : el('span', {}, '📄 ' + p.file.name),
      el('button', { class: 'off', title: 'Take it off', 'aria-label': 'Take it off',
        onclick: () => { const list = pendingOf(key).slice(); const gone = list.splice(i, 1)[0]; if (gone.url) URL.revokeObjectURL(gone.url); if (list.length) pending.set(key, list); else pending.delete(key); fillTrays(key); } }, '✕'))));
    if (changed) changed();
  };
  node.fill();
  return node;
}
function fillTrays(key) {
  for (const node of document.querySelectorAll('.tray')) if (node.dataset.tray === key && node.fill) node.fill();
}

// A box takes a picture or a file pasted into it, or dropped on it. Pasted words still paste as words.
// A whole thread takes a drop too (dropOn), into its reply box.
function takePictures(box, key) {
  box.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addPictures(key, files);
  });
  dropOn(box, key);
}
function dropOn(node, key) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    node.classList.add('dropping');
  });
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove('dropping'); });
  node.addEventListener('drop', (e) => {
    node.classList.remove('dropping');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    // Taken once: a drop on the box is not taken again by the thread around it.
    e.preventDefault();
    e.stopPropagation();
    addPictures(key, [...e.dataTransfer.files]);
  });
}
// The 📎 button beside a box: pick pictures or files from this machine, to wait under the box.
function pickNode(key) {
  const input = el('input', { type: 'file', multiple: true, accept: PICK, hidden: true,
    onchange: () => { addPictures(key, [...input.files]); input.value = ''; } });
  return [input, el('button', { class: 'pick', type: 'button', title: 'Add a picture or a file', 'aria-label': 'Add a picture or a file', onclick: () => input.click() }, '📎')];
}

// One picture to the server, as its bytes: it attaches it to the thread as spool attach would.
async function upload(id, file) {
  const chosen = chosenProject();
  const at = () => fetch('/api/attach?id=' + encodeURIComponent(id) + (file.name ? '&name=' + encodeURIComponent(file.name) : '') + (chosen ? '&project=' + encodeURIComponent(chosen) : ''),
    { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-spool-token': token }, body: file });
  try {
    let res = await at();
    if (res.status === 403) { await freshToken(); res = await at(); }
    return await res.json();
  } catch (e) {
    return { ok: false, text: 'The page lost its server. Run spool page again.' };
  }
}
// Send what waits under a box to the thread it is for, once that thread has the words. What could not
// be sent stays under the box, so nothing pasted is lost.
async function sendPictures(id, key) {
  const list = pendingOf(key);
  if (!list.length || typeof id !== 'string') return true;
  for (let i = 0; i < list.length; i++) {
    const out = await upload(id, list[i].file);
    if (!out.ok) {
      unpend(key, i);
      say(out.text || 'It could not be kept.');
      load(true);
      return false;
    }
  }
  unpend(key, list.length);
  load(true);
  return true;
}

const pictureSrc = (id, name) => '/api/picture?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name);
const SIDE = { before: 'Before', after: 'After' };
function pictureNode(c, pic, cls) {
  const words = pic.caption || (pic.as ? SIDE[pic.as] : 'A picture');
  return el('button', { class: 'picture' + (cls ? ' ' + cls : ''), title: 'Open it full size', onclick: () => openPicture(c.id, pic) },
    el('img', { src: pictureSrc(c.id, pic.name), alt: words, loading: 'lazy' }));
}

// A file: a link that opens it in a tab of its own, by the name it came with.
function fileName(name) {
  const m = /^\d+(?:-(?:before|after))?(?:\.([a-z0-9-]+))?\.([a-z]+)$/.exec(name);
  if (!m) return name;
  return m[1] ? m[1] + '.' + m[2] : m[2] === 'pdf' ? 'A PDF' : 'A text file';
}
const fileNode = (c, pic) => el('a', { class: 'file', href: pictureSrc(c.id, pic.name), target: '_blank', rel: 'noopener', title: 'Open it' }, '📄 ', fileName(pic.name));

// A before or an after says which it is under it.
const sideNode = (c, pic) => el('figure', {}, pictureNode(c, pic), el('figcaption', {}, SIDE[pic.as], pic.caption && [' · ', pic.caption]));

// Under a post's words: the pictures it came with. (A finished thread's before and after are under its result instead: the board leaves them out of the posts.)
function picturesNode(c, p) {
  const pics = (p.pictures || []).map((name) => c.thread.pictures.find((x) => x.name === name)).filter(Boolean);
  return pics.length > 0 && el('div', { class: 'pictures' }, pics.map((pic) => (pic.kind === 'file' ? fileNode(c, pic) : pic.as ? sideNode(c, pic) : pictureNode(c, pic))));
}

// The proof under a finished thread's result: its last before and its last after side by side, or whichever it has.
function proofNode(c) {
  const sides = c.thread.pictures.filter((x) => x.as && x.kind !== 'file');
  if (!sides.length) return null;
  const before = sides.filter((x) => x.as === 'before').at(-1);
  const after = sides.filter((x) => x.as === 'after').at(-1);
  const shown = [before, after].filter(Boolean);
  const rest = sides.filter((x) => !shown.includes(x));
  return el('div', { class: 'proof' + (before && after ? ' pair' : '') }, [...shown, ...rest].map((pic) => sideNode(c, pic)));
}

// The small mark on a finished thread in the brief that has pictures to look at.
const pictureMark = (n) => n > 0 && el('span', { class: 'chip picmark', title: n === 1 ? 'It has a picture' : 'It has ' + n + ' pictures' }, 'has pictures');

// A picture full size, over everything, framed as the ticket is: under it, who attached it, when,
// and what they said with it. Esc, the ✕ or a click outside closes it.
let pictureOpen = null;
function openPicture(id, pic) {
  closePicture();
  const words = [pic.as && SIDE[pic.as], pic.caption].filter(Boolean).join(' · ');
  const who = pic.by ? speaker(pic.by).name : '';
  const when = pic.at && stamp(pic.at);
  pictureOpen = el('div', { id: 'picture', role: 'dialog', 'aria-modal': 'true', 'aria-label': words || 'A picture',
    onclick: (e) => { if (e.target === pictureOpen) closePicture(); } },
    el('div', { class: 'frame' },
      el('img', { src: pictureSrc(id, pic.name), alt: words || 'A picture' }),
      el('div', { class: 'about' },
        el('span', {}, who && el('b', {}, who), [words, when].filter(Boolean).map((part) => [el('span', { class: 'sep' }, ' · '), part]).flat().slice(who ? 0 : 1)),
        el('button', { class: 'x', onclick: closePicture, title: 'Close' }, '✕'))));
  document.body.append(pictureOpen);
  pictureOpen.querySelector('.x').focus();
}
function closePicture() {
  if (pictureOpen) pictureOpen.remove();
  pictureOpen = null;
}
// Esc closes the picture first, before the ticket under it: this is heard before the page's own keys are.
window.addEventListener('keydown', (e) => {
  if (pictureOpen && e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); closePicture(); }
}, true);
`;
