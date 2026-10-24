// Side panel: the main surface. Trail (list or graph), Saved (pins, notes, parked trails), All, plus a
// "left behind" shelf for one-click restore.
import {
  DEFAULTS, emptyTrail, leftBehind, parkedTrails, pathTo, rootActivity, rootOf, savedBranchCount,
  savedNodes, searchNodes, subtreeIds, trailStats,
} from '../tree.js';
import { createMapView } from '../mapview.js';
import { renderDetail } from '../detail.js';
import { ago, agoShort, el, faviconUrl, host, pageTitle } from '../util.js';

const $ = (s) => document.querySelector(s);
const ORIGINS = ['http://*/*', 'https://*/*'];
const CS_ID = 'trailhead-scroll';

const state = {
  trail: emptyTrail(),
  ptrs: {},
  lanes: {},
  settings: { ...DEFAULTS },
  tabs: new Map(),
  tabId: null,
  view: 'trail', // trail | saved | all
  mode: 'list', // list | graph (trail view only)
  scope: 'trail', // trail | browser (graph only)
  query: '',
  collapsed: new Set(),
  openTrails: new Set(),
  expanded: new Set(),
  graphFresh: true,
  leftOpen: false,
  editingNote: null,
  settingsOpen: false,
};
let lastFocusKey = '';
let lastViewKey = '';
let raf = 0;
const send = (msg) => chrome.runtime.sendMessage(msg);

const view = createMapView($('#psvg'), {
  orientation: 'tb',
  onSelect: () => renderGraphDetail(),
  onTab: (tabId) => focusTab(tabId),
  onOpen: (key) => primary(key),
});

// ---- data ------------------------------------------------------------------

async function load() {
  const [local, session, tabs] = await Promise.all([
    chrome.storage.local.get(['trail', 'settings']),
    chrome.storage.session.get('tabstate'),
    chrome.tabs.query({}),
  ]);
  const ts = session.tabstate || {};
  state.trail = local.trail || emptyTrail();
  state.settings = { ...DEFAULTS, ...(local.settings || {}) };
  state.ptrs = ts.ptrs || {};
  state.lanes = ts.lanes || {};
  state.tabs = new Map(tabs.map((t) => [t.id, t]));
}

async function refreshActiveTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = t ? t.id : null;
}

function scheduleRender() {
  // Do not rebuild the DOM under someone who is typing a note.
  const a = document.activeElement;
  if (a && a.closest && a.closest('.noteedit')) return;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(render);
}

function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  return chrome.storage.local.set({ settings: state.settings });
}

const curNodeId = () => state.ptrs[state.tabId];

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function renderStats() {
  const bar = $('#statsbar');
  const { pages, trails } = trailStats(state.trail);
  const left = leftBehind(state.trail, state.ptrs, { limit: 30 }).length;
  const saved = savedNodes(state.trail).length;
  bar.hidden = state.settingsOpen || !pages;
  if (bar.hidden) return;
  bar.replaceChildren();
  for (const [n, label] of [[pages, 'pages'], [trails, 'trails'], [left, 'left behind'], [saved, 'saved']]) {
    bar.append(el('span', {}, el('b', { text: String(n) }), ' ' + label));
  }
}

function renderWelcome(list) {
  list.append(
    el('div', { class: 'welcome' },
      el('h2', { text: 'Your back button, with a memory' }),
      el('p', { text: 'Trailhead records where you go from now on. Try this:' }),
      el('ol', {},
        el('li', { text: 'Open a few pages by clicking links.' }),
        el('li', { text: 'Go back, then click something different. The page you left stays here as a branch.' }),
        el('li', {}, 'Press ', el('kbd', { text: 'Alt+Shift+B' }), ' to bring back the page you just left.'),
        el('li', { text: 'Use Graph above to see every tab as one map.' }),
      ),
    ),
  );
}

// ---- list rows -------------------------------------------------------------

function flatten(rootId, onPath) {
  const out = [];
  const stack = [[rootId, 0]];
  while (stack.length) {
    const [id, depth] = stack.pop();
    const n = state.trail.nodes[id];
    if (!n) continue;
    out.push({ n, depth });
    if (state.collapsed.has(id) && !onPath.has(id)) continue;
    const next = n.children.length > 1 ? depth + 1 : depth;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], next]);
  }
  return out;
}

function favicon(url) {
  const img = el('img', { src: faviconUrl(url), alt: '', loading: 'lazy' });
  img.addEventListener('error', () => (img.style.visibility = 'hidden'));
  return img;
}

function rowFor(n, { depth = 0, onPath = false, isCurrent = false, flat = false } = {}) {
  const cls = 'row' + (isCurrent ? ' current' : '') + (flat ? ' flat' : onPath ? ' onpath' : ' saved');
  const row = el('div', { class: cls, 'data-id': n.id });
  row.style.setProperty('--d', String(Math.min(depth, 8)));

  const collapsible = !flat && n.children.length > 0 && !onPath;
  row.append(
    collapsible
      ? el('button', { class: 'twisty', 'data-act': 'toggle', text: state.collapsed.has(n.id) ? '▸' : '▾', 'aria-label': 'Collapse or expand branch' })
      : el('span', { class: 'twisty none' }),
  );

  const meta = el('span', { class: 'meta' });
  if (isCurrent) meta.append(el('span', { class: 'here', text: 'You are here' }));
  meta.append(`${host(n.url)} · ${agoShort(n.last)}`);
  const title = el('span', { class: 'title' });
  if (n.pin) title.append(el('span', { class: 'pinmark', text: '★' }));
  title.append(pageTitle(n));
  const text = el('span', { class: 'text' }, title, meta);
  if (n.note) text.append(el('span', { class: 'note', text: n.note }));
  row.append(el('button', { class: 'main', 'data-act': 'open', title: n.url }, favicon(n.url), text));

  row.append(
    el(
      'span',
      { class: 'actions' },
      el('button', { 'data-act': 'pin', class: n.pin ? 'on' : '', title: n.pin ? 'Unpin' : 'Pin: keep this page', 'aria-label': n.pin ? 'Unpin' : 'Pin', text: n.pin ? '★' : '☆' }),
      el('button', { 'data-act': 'note', title: 'Add a note', 'aria-label': 'Edit note', text: '✎' }),
      el('button', { 'data-act': 'newtab', title: 'Open in a new tab', 'aria-label': 'Open in a new tab', text: '↗' }),
      el('button', { 'data-act': 'delete', title: 'Forget this page and everything after it', 'aria-label': 'Forget this branch', text: '✕' }),
    ),
  );

  if (state.editingNote === n.id) {
    const input = el('input', { type: 'text', maxLength: 280, value: n.note || '', placeholder: 'Note (Enter to save)', 'aria-label': 'Note' });
    const finish = (save) => {
      if (state.editingNote !== n.id) return;
      state.editingNote = null;
      if (save) send({ type: 'setNote', nodeId: n.id, note: input.value });
      scheduleRender();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    row.append(el('div', { class: 'noteedit' }, input));
    requestAnimationFrame(() => input.focus());
  }
  return row;
}

// ---- left behind -------------------------------------------------------------

function renderLeft() {
  const box = $('#left');
  const items = state.settings.paused ? [] : leftBehind(state.trail, state.ptrs, { limit: 8 });
  box.hidden = !items.length || state.settingsOpen || state.view !== 'trail' || state.mode === 'graph' || !!state.query.trim();
  if (box.hidden) return;
  box.replaceChildren();
  box.append(
    el('div', { class: 'lhead' }, el('strong', { text: 'Left behind' }), el('span', { class: 'hint', text: 'Alt+Shift+B restores the latest' })),
  );
  const shown = state.leftOpen ? items : items.slice(0, 3);
  for (const { node, t } of shown) {
    const row = el('div', { class: 'lrow', 'data-id': node.id });
    row.append(
      favicon(node.url),
      el(
        'span',
        { class: 'ltext' },
        el('span', { class: 'title', text: pageTitle(node) }),
        el('span', { class: 'meta', text: `${host(node.url)} · left ${ago(t)}` }),
      ),
      el('button', { class: 'restore', 'data-act': 'restore', text: 'Restore', title: 'Open this page again in a new tab' }),
      el('button', { class: 'mini', 'data-act': 'lpin', title: 'Pin: keep this page', 'aria-label': 'Pin', text: '☆' }),
      el('button', { class: 'mini', 'data-act': 'ldismiss', title: 'Dismiss', 'aria-label': 'Dismiss', text: '✕' }),
    );
    box.append(row);
  }
  if (items.length > 3) {
    box.append(el('button', { class: 'lmore', 'data-act': 'lmore', text: state.leftOpen ? 'Show fewer' : `Show ${items.length - 3} more` }));
  }
}

// ---- views -------------------------------------------------------------------

function renderTrailList(list) {
  const cur = state.trail.nodes[curNodeId()];
  if (!cur && !state.trail.roots.length && !state.settings.paused) return renderWelcome(list);
  if (!cur) {
    list.append(
      el('p', { class: 'empty', text: state.settings.paused ? 'Recording is paused.' : 'Nothing recorded for this tab yet. Visit a page and it will appear here.' }),
    );
    return;
  }
  const path = pathTo(state.trail, cur.id);
  const onPath = new Set(path.map((n) => n.id));
  const saved = savedBranchCount(state.trail, cur.id);
  list.append(
    el('p', {
      class: 'summary',
      text: saved
        ? `${saved} saved branch${saved === 1 ? '' : 'es'} on this trail. Dimmed pages are ones you left behind.`
        : 'No saved branches yet. Go back, then click something new, and the page you left will stay here.',
    }),
  );
  for (const { n, depth } of flatten(path[0].id, onPath)) {
    list.append(rowFor(n, { depth, onPath: onPath.has(n.id), isCurrent: n.id === cur.id }));
  }
  const key = state.tabId + ':' + cur.id;
  if (key !== lastFocusKey) {
    lastFocusKey = key;
    requestAnimationFrame(() => document.querySelector('.row.current')?.scrollIntoView({ block: 'center' }));
  }
}

function renderSaved(list) {
  const parked = parkedTrails(state.trail);
  const notes = savedNodes(state.trail);
  if (!parked.length && !notes.length) {
    list.append(
      el('p', { class: 'empty', text: 'Nothing saved yet. Pin (☆) or annotate (✎) a page and it stays here, safe from pruning. Park a trail to close its tabs and reopen them later.' }),
    );
    return;
  }
  if (parked.length) {
    list.append(el('h3', { text: 'Parked trails' }));
    for (const p of parked) {
      list.append(
        el(
          'div',
          { class: 'parked', 'data-root': p.rootId },
          el('span', { class: 'ptext' }, el('span', { class: 'title', text: pageTitle(p.root) }), el('span', { class: 'meta', text: `${p.count} tab${p.count === 1 ? '' : 's'} · parked ${ago(p.t)}` })),
          el('button', { class: 'primary', 'data-act': 'unpark', text: 'Reopen' }),
          el('button', { 'data-act': 'unparkforget', text: 'Forget', title: 'Remove the parked marker (pages stay on the trail)' }),
        ),
      );
    }
  }
  if (notes.length) {
    list.append(el('h3', { text: 'Pinned and noted pages' }));
    for (const n of notes) list.append(rowFor(n, { flat: true, isCurrent: n.id === curNodeId() }));
  }
}

function renderAll(list) {
  const { trail } = state;
  if (!trail.roots.length) {
    list.append(el('p', { class: 'empty', text: 'No trails yet.' }));
    return;
  }
  const curId = curNodeId();
  const onPath = new Set(curId ? pathTo(trail, curId).map((n) => n.id) : []);
  const act = rootActivity(trail);
  const groups = trail.roots.map((rootId) => ({ rootId, count: subtreeIds(trail, rootId).length, last: act[rootId] || 0 })).sort((a, b) => b.last - a.last);
  for (const g of groups) {
    const root = trail.nodes[g.rootId];
    const open = state.openTrails.has(g.rootId) || onPath.has(g.rootId);
    list.append(
      el(
        'button',
        { class: 'group', 'data-act': 'trail', 'data-root': g.rootId, 'aria-expanded': String(open) },
        el('span', { text: open ? '▾' : '▸' }),
        el('span', { class: 'title', text: (root.parked ? '⏸ ' : '') + pageTitle(root) }),
        el('span', { class: 'meta', text: `${g.count} page${g.count === 1 ? '' : 's'} · ${agoShort(g.last)}` }),
      ),
    );
    if (open) for (const { n, depth } of flatten(g.rootId, onPath)) list.append(rowFor(n, { depth, onPath: onPath.has(n.id), isCurrent: n.id === curId }));
  }
}

function renderSearch(list, q) {
  const hits = searchNodes(state.trail, q);
  if (!hits.length) {
    list.append(el('p', { class: 'empty', text: 'No matching pages.' }));
    return;
  }
  list.append(el('p', { class: 'summary', text: `${hits.length}${hits.length === 100 ? '+' : ''} match${hits.length === 1 ? '' : 'es'}` }));
  for (const n of hits) list.append(rowFor(n, { flat: true, isCurrent: n.id === curNodeId() }));
}

// ---- graph ---------------------------------------------------------------------

function graphRoots() {
  const { trail, ptrs } = state;
  if (state.scope === 'browser') {
    const live = [...new Set(Object.values(ptrs).map((id) => rootOf(trail, id)).filter(Boolean))];
    const act = rootActivity(trail);
    return live.sort((a, b) => (act[b] || 0) - (act[a] || 0));
  }
  const cur = curNodeId();
  const r = cur && rootOf(trail, cur);
  return r ? [r] : [];
}

function renderGraph() {
  const roots = graphRoots();
  view.update({
    trail: state.trail,
    ptrs: state.ptrs,
    lanes: state.lanes,
    tabs: state.tabs,
    roots,
    hits: new Set(),
    expanded: state.expanded,
    compress: true,
  });
  renderGraphDetail();
  const cur = curNodeId();
  const key = state.scope + ':' + state.tabId + ':' + cur;
  const follow = (k) => {
    const it = view.layout && view.layout.items.find((i) => (i.kind === 'page' ? i.id === cur : i.ids.includes(cur)));
    if (it) view.focusKey(it.key, k);
  };
  if (state.graphFresh) {
    // First view of a trail: show all of it if it stays readable, otherwise centre on the current page.
    state.graphFresh = false;
    lastFocusKey = key;
    requestAnimationFrame(() => {
      view.fit();
      if (view.scale < 0.6 && cur) follow(0.8);
    });
  } else if (cur && key !== lastFocusKey) {
    // Afterwards, follow the page you are on when it changes.
    lastFocusKey = key;
    requestAnimationFrame(() => follow(1));
  }
}

function renderGraphDetail() {
  const box = $('#pdetail');
  const item = view.selected ? view.item(view.selected) : null;
  box.hidden = !item || state.mode !== 'graph';
  if (item) renderDetail(box, { trail: state.trail, item, tabs: state.tabs, actions: graphActions });
}

const graphActions = {
  jump: (tabId) => focusTab(tabId),
  open: (nodeId) => send({ type: 'resume', nodeId, newTab: true, active: true }),
  pin: (nodeId, pin) => send({ type: 'setPin', nodeId, pin }),
  note: (nodeId, note) => send({ type: 'setNote', nodeId, note }),
  forget: (nodeId) => {
    view.select(null);
    forget(nodeId);
  },
  expand(ids) {
    for (const id of ids) state.expanded.add(id);
    view.select(null);
    render();
  },
};

function primary(key) {
  const it = view.item(key);
  if (!it) return;
  if (it.kind === 'run') graphActions.expand(it.ids);
  else if (it.tabs.length) focusTab(it.tabs[0]);
  else graphActions.open(it.id);
}

// ---- render ----------------------------------------------------------------

function render() {
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === state.view);
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === state.mode);
  $('#paused').hidden = !state.settings.paused;

  const q = state.query.trim();
  const settings = state.settingsOpen;
  const trailView = state.view === 'trail' && !q && !settings;
  const graph = trailView && state.mode === 'graph';

  $('#settings').hidden = !settings;
  $('#searchbar').hidden = settings;
  $('#subbar').hidden = !trailView;
  $('#scope').hidden = !graph;
  $('#scope').value = state.scope;
  $('#list').hidden = settings || graph;
  $('#graphwrap').hidden = !graph;
  if (!graph) $('#pdetail').hidden = true;

  const cur = state.trail.nodes[curNodeId()];
  const curRoot = cur ? rootOf(state.trail, cur.id) : null;
  $('#park').hidden = !(trailView && curRoot && Object.values(state.ptrs).some((id) => rootOf(state.trail, id) === curRoot));

  renderLeft();
  renderStats();
  if (settings) return renderSettings();

  if (graph) return renderGraph();
  const list = $('#list');
  // A different view or search starts at the top instead of inheriting the old scroll position.
  const viewKey = [state.view, q ? 'search' : '', state.mode].join('|');
  const viewChanged = viewKey !== lastViewKey;
  lastViewKey = viewKey;
  list.replaceChildren();
  if (q) renderSearch(list, q);
  else if (state.view === 'trail') renderTrailList(list);
  else if (state.view === 'saved') renderSaved(list);
  else renderAll(list);
  if (viewChanged) list.scrollTop = 0;
}

function renderSettings() {
  $('#paused-box').checked = !!state.settings.paused;
  $('#scroll-box').checked = !!state.settings.scroll;
  $('#icon-opens').value = state.settings.iconOpens === 'map' ? 'map' : 'panel';
  $('#days').value = String(state.settings.maxDays);
  const ex = $('#excluded');
  if (document.activeElement !== ex) ex.value = (state.settings.excluded || []).join('\n');
  const { pages, trails } = trailStats(state.trail);
  $('#stats').textContent = `${pages} page${pages === 1 ? '' : 's'} across ${trails} trail${trails === 1 ? '' : 's'} recorded.`;
}

// ---- actions ---------------------------------------------------------------

function focusTab(tabId) {
  const t = state.tabs.get(tabId);
  chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (t) chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
}

function resume(id, newTab) {
  if (curNodeId() === id && !newTab) return;
  send({ type: 'resume', nodeId: id, newTab: newTab || state.tabId == null, tabId: state.tabId });
}

function forget(id) {
  const count = subtreeIds(state.trail, id).length;
  if (count > 1 && !confirm(`Forget this page and the ${count - 1} page${count === 2 ? '' : 's'} after it?`)) return;
  send({ type: 'deleteBranch', nodeId: id });
}

async function enableScroll() {
  const ok = await chrome.permissions.request({ origins: ORIGINS }); // must be the first await (user gesture)
  if (!ok) return false;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CS_ID] });
  } catch {
    /* not registered yet */
  }
  await chrome.scripting.registerContentScripts([
    { id: CS_ID, matches: ORIGINS, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true },
  ]);
  return true;
}

async function disableScroll() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CS_ID] });
  } catch {
    /* already gone */
  }
  await chrome.permissions.remove({ origins: ORIGINS }).catch(() => {});
}

// ---- wiring ----------------------------------------------------------------

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]')?.dataset.id;
  switch (btn.dataset.act) {
    case 'open': resume(id, e.ctrlKey || e.metaKey); break;
    case 'newtab': resume(id, true); break;
    case 'delete': forget(id); break;
    case 'pin': { const on = !state.trail.nodes[id]?.pin; send({ type: 'setPin', nodeId: id, pin: on }); toast(on ? 'Pinned: kept from pruning' : 'Unpinned'); break; }
    case 'note':
      state.editingNote = state.editingNote === id ? null : id;
      render();
      break;
    case 'toggle':
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      scheduleRender();
      break;
    case 'trail': {
      const r = btn.dataset.root;
      state.openTrails.has(r) ? state.openTrails.delete(r) : state.openTrails.add(r);
      scheduleRender();
      break;
    }
    case 'restore': send({ type: 'resume', nodeId: id, newTab: true, active: true }); toast('Restored in a new tab'); break;
    case 'lpin': send({ type: 'setPin', nodeId: id, pin: true }); break;
    case 'ldismiss': send({ type: 'dismissLeft', nodeId: id }); break;
    case 'lmore':
      state.leftOpen = !state.leftOpen;
      render();
      break;
    case 'unpark':
      send({ type: 'unpark', rootId: btn.closest('[data-root]').dataset.root });
      break;
    case 'unparkforget':
      send({ type: 'forgetParked', rootId: btn.closest('[data-root]').dataset.root });
      break;
  }
}
$('#list').addEventListener('click', onClick);
$('#left').addEventListener('click', onClick);
$('#list').addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const btn = e.target.closest('[data-act="open"]');
  if (btn) {
    e.preventDefault();
    resume(btn.closest('[data-id]').dataset.id, true);
  }
});

for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => {
    state.view = b.dataset.view;
    state.settingsOpen = false;
    render();
  });
}
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    state.graphFresh = true;
    lastFocusKey = '';
    render();
  });
}
$('#scope').addEventListener('change', (e) => {
  state.scope = e.target.value;
  state.graphFresh = true;
  lastFocusKey = '';
  view.resetView();
  render();
});
$('#park').addEventListener('click', () => {
  const cur = curNodeId();
  const root = cur && rootOf(state.trail, cur);
  if (!root) return;
  const n = Object.values(state.ptrs).filter((id) => rootOf(state.trail, id) === root).length;
  if (!confirm(`Close ${n} tab${n === 1 ? '' : 's'} on this trail and save them to reopen later?`)) return;
  send({ type: 'park', rootId: root });
  toast(`Parked ${n} tab${n === 1 ? '' : 's'}. Reopen from Saved.`);
  state.view = 'saved';
});
$('#q').addEventListener('input', (e) => {
  state.query = e.target.value;
  scheduleRender();
});
$('#expand').addEventListener('click', () => send({ type: 'openMap' }));
$('#gear').addEventListener('click', () => {
  state.settingsOpen = !state.settingsOpen;
  render();
});
$('#close-settings').addEventListener('click', () => {
  state.settingsOpen = false;
  render();
});
$('#icon-opens').addEventListener('change', (e) => saveSettings({ iconOpens: e.target.value }));
$('#paused-box').addEventListener('change', (e) => saveSettings({ paused: e.target.checked }));
$('#scroll-box').addEventListener('change', async (e) => {
  const box = e.target;
  if (box.checked) {
    const ok = await enableScroll();
    box.checked = ok;
    await saveSettings({ scroll: ok });
  } else {
    await disableScroll();
    await saveSettings({ scroll: false });
  }
});
$('#days').addEventListener('change', (e) => {
  const v = Math.min(365, Math.max(1, Math.round(Number(e.target.value)) || DEFAULTS.maxDays));
  e.target.value = String(v);
  saveSettings({ maxDays: v });
  send({ type: 'prune' });
});
$('#excluded').addEventListener('change', (e) => {
  saveSettings({ excluded: e.target.value.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean) });
});
$('#forget').addEventListener('click', async () => {
  if (!confirm('Forget every recorded trail? This cannot be undone.')) return;
  await send({ type: 'clearAll' });
});

chrome.storage.onChanged.addListener(async () => {
  await load();
  scheduleRender();
});
chrome.tabs.onActivated.addListener(async () => {
  await refreshActiveTab();
  scheduleRender();
});
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.title !== undefined || info.favIconUrl !== undefined) {
    load().then(scheduleRender);
  }
});
chrome.tabs.onRemoved.addListener(() => load().then(scheduleRender));

(async () => {
  await Promise.all([load(), refreshActiveTab()]);
  render();
})();
