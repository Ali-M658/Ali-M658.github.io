// Full-page map: the same graph as the side panel, laid out left to right with room to roam.
import { DEFAULTS, emptyTrail, rootOf, rootActivity, searchNodes, subtreeIds } from '../tree.js';
import { createMapView } from '../mapview.js';
import { renderDetail } from '../detail.js';
import { el, host } from '../util.js';

const DAY_MS = 86400000;
const $ = (sel) => document.querySelector(sel);

const state = {
  trail: emptyTrail(),
  ptrs: {},
  lanes: {},
  settings: { ...DEFAULTS },
  tabs: new Map(),
  selfTabId: null,
  filter: 'open',
  query: '',
  compress: true,
  expanded: new Set(),
  hits: new Set(),
};

const view = createMapView($('#svg'), {
  orientation: 'lr',
  onSelect: () => renderDetailBar(),
  onTab: (tabId) => focusTab(tabId),
  onOpen: (key) => primaryAction(key),
  onFirstLayout: initialView,
});

// ---- data --------------------------------------------------------------------

async function load() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['trail', 'settings']),
    chrome.storage.session.get('tabstate'),
  ]);
  const ts = session.tabstate || {};
  state.trail = local.trail || emptyTrail();
  state.settings = { ...DEFAULTS, ...(local.settings || {}) };
  state.ptrs = ts.ptrs || {};
  state.lanes = ts.lanes || {};
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  state.tabs = new Map(tabs.map((t) => [t.id, t]));
}

let timer = 0;
function refresh(delay = 120) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await Promise.all([load(), loadTabs()]);
    render();
  }, delay);
}

function visibleRoots() {
  const { trail, ptrs } = state;
  const liveRoots = new Set(Object.values(ptrs).map((id) => rootOf(trail, id)).filter(Boolean));
  const act = rootActivity(trail);
  let ids = trail.roots.slice();

  const q = state.query.trim();
  if (q) {
    const hits = searchNodes(trail, q, 500);
    state.hits = new Set(hits.map((n) => n.id));
    const hitRoots = new Set(hits.map((n) => rootOf(trail, n.id)));
    ids = ids.filter((r) => hitRoots.has(r));
  } else {
    state.hits = new Set();
    if (state.filter === 'open') ids = ids.filter((r) => liveRoots.has(r));
    else if (state.filter === 'day') ids = ids.filter((r) => liveRoots.has(r) || act[r] > Date.now() - DAY_MS);
  }
  // Trails with open tabs first, then most recent.
  return ids.sort((a, b) => (liveRoots.has(b) ? 1 : 0) - (liveRoots.has(a) ? 1 : 0) || act[b] - act[a]);
}

function render() {
  view.update({
    trail: state.trail,
    ptrs: state.ptrs,
    lanes: state.lanes,
    tabs: state.tabs,
    roots: visibleRoots(),
    hits: state.hits,
    expanded: state.expanded,
    compress: state.compress,
  });
  const L = view.layout;
  $('#empty').hidden = !!(L && L.groups.length);
  $('#empty-hint').textContent = state.query.trim()
    ? 'No recorded page matches that search.'
    : state.filter === 'open'
      ? 'None of your open tabs are on a recorded trail yet. Browse a few pages (they are recorded from now on), or switch the filter to "All trails".'
      : 'Pages are recorded from the moment Trailhead is installed. Browse a few pages, go back, click something new, and branches will appear here.';
  renderTray();
  renderDetailBar();
}

function renderTray() {
  const loose = [...state.tabs.values()].filter(
    (t) => t.id !== state.selfTabId && state.ptrs[t.id] === undefined && !(t.url || '').startsWith(chrome.runtime.getURL('')),
  );
  $('#tray').hidden = loose.length === 0;
  const list = $('#tray-list');
  list.replaceChildren();
  for (const t of loose) {
    const img = el('img', { alt: '' });
    if (t.favIconUrl) img.src = t.favIconUrl;
    else img.style.visibility = 'hidden';
    img.addEventListener('error', () => (img.style.visibility = 'hidden'));
    const b = el('button', { class: 'tray-item', title: t.url || '' }, img, el('span', { text: t.title || host(t.url || '') || 'Tab' }));
    b.addEventListener('click', () => focusTab(t.id));
    list.append(b);
  }
}

// ---- detail bar --------------------------------------------------------------

const send = (msg) => chrome.runtime.sendMessage(msg);

const actions = {
  jump: (tabId) => focusTab(tabId),
  open: (nodeId) => send({ type: 'resume', nodeId, newTab: true, active: true }),
  pin: (nodeId, pin) => send({ type: 'setPin', nodeId, pin }),
  note: (nodeId, note) => send({ type: 'setNote', nodeId, note }),
  forget(nodeId) {
    const count = subtreeIds(state.trail, nodeId).length;
    const msg = count > 1 ? `Forget this page and the ${count - 1} page${count === 2 ? '' : 's'} after it?` : 'Forget this page?';
    if (!confirm(msg)) return;
    view.select(null);
    send({ type: 'deleteBranch', nodeId });
  },
  expand(ids) {
    for (const id of ids) state.expanded.add(id);
    view.select(null);
    render();
  },
};

function renderDetailBar() {
  const bar = $('#detail');
  const item = view.selected ? view.item(view.selected) : null;
  bar.hidden = !item;
  if (item) renderDetail(bar, { trail: state.trail, item, tabs: state.tabs, actions });
}

// ---- actions -----------------------------------------------------------------

function focusTab(tabId) {
  const t = state.tabs.get(tabId);
  chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (t) chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
}

function primaryAction(key) {
  const it = view.item(key);
  if (!it) return;
  if (it.kind === 'run') actions.expand(it.ids);
  else if (it.tabs.length) focusTab(it.tabs[0]);
  else actions.open(it.id);
}

function initialView(v) {
  v.fit();
  if (v.scale >= 0.45) return;
  // Too big to read at once: start at the tab you were most recently using.
  let best = null;
  let bestT = -1;
  for (const it of v.layout.items) {
    for (const t of it.tabs) {
      if (t === state.selfTabId) continue;
      const la = (state.tabs.get(t) || {}).lastAccessed || 0;
      if (la > bestT) {
        bestT = la;
        best = it.key;
      }
    }
  }
  if (best) v.focusKey(best, 1);
}

// ---- wiring ------------------------------------------------------------------

$('#zoom-in').addEventListener('click', () => view.zoomBy(1.25));
$('#zoom-out').addEventListener('click', () => view.zoomBy(0.8));
$('#fit').addEventListener('click', () => view.fit());
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  if (e.key === '0') view.fit();
  else if (e.key === '+' || e.key === '=') view.zoomBy(1.25);
  else if (e.key === '-') view.zoomBy(0.8);
  else if (e.key === 'Escape' && view.selected) view.select(null);
});

$('#filter').addEventListener('change', (e) => {
  state.filter = e.target.value;
  view.resetView();
  render();
});
$('#q').addEventListener('input', (e) => {
  state.query = e.target.value;
  view.resetView();
  render();
});
$('#compress').addEventListener('change', (e) => {
  state.compress = e.target.checked;
  render();
});

chrome.storage.onChanged.addListener(() => refresh());
for (const ev of ['onCreated', 'onRemoved', 'onActivated', 'onReplaced']) chrome.tabs[ev].addListener(() => refresh(200));
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title !== undefined || info.favIconUrl !== undefined || info.discarded !== undefined || info.status === 'complete') refresh(200);
});

(async () => {
  const me = await chrome.tabs.getCurrent();
  state.selfTabId = me ? me.id : null;
  await Promise.all([load(), loadTabs()]);
  render();
})();
