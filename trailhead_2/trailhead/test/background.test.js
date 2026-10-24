// Integration test: loads the real background.js against an in-memory fake of the chrome.* APIs
// and replays a browsing session through the event listeners.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = { local: {}, session: {} };
const badges = {};
const tabsDB = {};
let nextTabId = 100;

function evt() {
  const ls = [];
  return { addListener: (f) => ls.push(f), fire: (...a) => Promise.all(ls.map((f) => f(...a))), ls };
}
function area(name) {
  return {
    async get(keys) {
      const ks = typeof keys === 'string' ? [keys] : keys;
      const out = {};
      for (const k of ks) if (k in store[name]) out[k] = structuredClone(store[name][k]);
      return out;
    },
    async set(o) {
      for (const k of Object.keys(o)) store[name][k] = structuredClone(o[k]);
    },
  };
}

const E = {
  onMessage: evt(),
  onInstalled: evt(),
  onStartup: evt(),
  onChanged: evt(),
  onCommitted: evt(),
  onHistoryStateUpdated: evt(),
  onCreatedNavigationTarget: evt(),
  tabsCreated: evt(),
  tabsUpdated: evt(),
  tabsRemoved: evt(),
  tabsActivated: evt(),
  tabsReplaced: evt(),
  onAlarm: evt(),
  onClicked: evt(),
  onCommand: evt(),
};
const panelBehavior = [];
const focused = [];

globalThis.chrome = {
  runtime: {
    id: 'test-ext',
    onMessage: E.onMessage,
    onInstalled: E.onInstalled,
    onStartup: E.onStartup,
    getURL: (p = '') => 'chrome-extension://test-ext/' + String(p).replace(/^\//, ''),
  },
  commands: { onCommand: E.onCommand },
  windows: { update: async (id, o) => void focused.push([id, o]) },
  storage: { local: area('local'), session: area('session'), onChanged: E.onChanged },
  tabs: {
    get: async (id) => tabsDB[id],
    query: async () => Object.values(tabsDB),
    remove: async (ids) => {
      for (const id of [].concat(ids)) {
        delete tabsDB[id];
        void E.tabsRemoved.fire(id); // real Chrome does not wait for listeners
      }
    },
    create: async ({ url, windowId }) => {
      const t = { id: nextTabId++, url: url || 'chrome://newtab/', windowId, incognito: false, status: 'loading', title: '' };
      tabsDB[t.id] = t;
      return t;
    },
    update: async (id, props) => Object.assign(tabsDB[id], props),
    onCreated: E.tabsCreated,
    onUpdated: E.tabsUpdated,
    onRemoved: E.tabsRemoved,
    onActivated: E.tabsActivated,
    onReplaced: E.tabsReplaced,
  },
  webNavigation: {
    onCommitted: E.onCommitted,
    onHistoryStateUpdated: E.onHistoryStateUpdated,
    onCreatedNavigationTarget: E.onCreatedNavigationTarget,
  },
  action: {
    onClicked: E.onClicked,
    setBadgeText: async ({ tabId, text }) => void (badges[tabId] = text),
    setBadgeBackgroundColor: async () => {},
  },
  sidePanel: { setPanelBehavior: async (o) => void panelBehavior.push(o) },
  alarms: { create() {}, onAlarm: E.onAlarm },
};

await import('../background.js');

const U = (c) => `https://${c}.test/`;
let tabSeq = 0;
function newTab(extra = {}) {
  const id = ++tabSeq;
  tabsDB[id] = { id, url: '', incognito: false, status: 'complete', title: '', ...extra };
  return id;
}
async function go(tabId, url, type = 'link', qualifiers = []) {
  tabsDB[tabId].url = url;
  await E.onCommitted.fire({ tabId, frameId: 0, url, transitionType: type, transitionQualifiers: qualifiers });
}
const PANEL = { id: 'test-ext', url: 'chrome-extension://test-ext/sidepanel/panel.html' };
const content = (tabId, url = 'https://x.test/') => ({ id: 'test-ext', tab: { id: tabId }, url });
function message(msg, sender = PANEL) {
  return new Promise((resolve) => {
    const handled = E.onMessage.ls.map((f) => f(msg, sender, resolve));
    if (!handled.some(Boolean)) resolve(undefined);
  });
}
const trail = () => store.local.trail;
const nodeByUrl = (u) => Object.values(trail().nodes).find((n) => n.url === u);
const kidsOf = (u) => nodeByUrl(u).children.map((id) => trail().nodes[id].url);

test('browsing session through the real service worker', async () => {
  const t1 = newTab();
  await go(t1, U('a'), 'typed');
  await go(t1, U('b'));
  await go(t1, U('c'));
  await go(t1, U('b'), 'link', ['forward_back']);
  await go(t1, U('d')); // the moment a normal browser would lose c

  assert.deepEqual(kidsOf(U('b')), [U('c'), U('d')], 'c survives next to d');
  assert.equal(store.session.tabstate.ptrs[t1], nodeByUrl(U('d')).id);
  assert.equal(badges[t1], '1', 'toolbar badge shows one saved branch');
});

test('titles arrive via tabs.onUpdated', async () => {
  const t1 = 1;
  tabsDB[t1].url = U('d');
  await E.tabsUpdated.fire(t1, { title: 'Dee' }, tabsDB[t1]);
  await new Promise((r) => setTimeout(r, 1700)); // debounced save
  assert.equal(nodeByUrl(U('d')).title, 'Dee');
});

test('subframe navigations and incognito tabs are ignored', async () => {
  const before = Object.keys(trail().nodes).length;
  await E.onCommitted.fire({ tabId: 1, frameId: 5, url: U('ad'), transitionType: 'auto_subframe', transitionQualifiers: [] });
  const inc = newTab({ incognito: true });
  await go(inc, U('secret'), 'typed');
  assert.equal(Object.keys(trail().nodes).length, before);
});

test('link opened in a new tab attaches to the source node', async () => {
  const t1 = 1;
  const src = nodeByUrl(U('d'));
  const t2 = newTab();
  await E.onCreatedNavigationTarget.fire({ sourceTabId: t1, tabId: t2, url: U('e') });
  await go(t1, U('zzz')); // opener moves on before the new tab commits
  await go(t2, U('e'));
  assert.equal(nodeByUrl(U('e')).parent, src.id);
});

test('side panel resume in a new tab re-points the pointer and adds no node', async () => {
  const c = nodeByUrl(U('c'));
  const before = Object.keys(trail().nodes).length;
  const res = await message({ type: 'resume', nodeId: c.id, newTab: true, tabId: 1 });
  assert.equal(res.ok, true);
  const created = Object.values(tabsDB).find((t) => t.url === U('c') && t.id >= 100);
  assert.ok(created, 'a tab was opened');
  await go(created.id, U('c'));
  assert.equal(store.session.tabstate.ptrs[created.id], c.id);
  assert.equal(Object.keys(trail().nodes).length, before);
  assert.equal(badges[created.id], '1');
});

test('content scripts cannot call privileged messages', async () => {
  const before = Object.keys(trail().nodes).length;
  const res = await message({ type: 'clearAll' }, content(1));
  assert.equal(res, undefined);
  assert.equal(Object.keys(trail().nodes).length, before);
  const foreign = await message({ type: 'clearAll' }, { id: 'someone-else' });
  assert.equal(foreign, undefined);
});

test('scroll reports are stored and handed back on resume', async () => {
  const t1 = newTab();
  await go(t1, U('p'), 'typed');
  await message({ type: 'scroll', url: U('p'), y: 1234 }, content(t1));
  await message({ type: 'scroll', url: U('wrong'), y: 5 }, content(t1));
  await new Promise((r) => setTimeout(r, 1700));
  const p = nodeByUrl(U('p'));
  assert.equal(p.scroll, 1234);

  const t2 = newTab();
  await message({ type: 'resume', nodeId: p.id, newTab: false, tabId: t2 });
  await go(t2, U('p'));
  const hello = await message({ type: 'hello', url: U('p') }, content(t2));
  assert.equal(hello.restoreY, 1234);
  const again = await message({ type: 'hello', url: U('p') }, content(t2));
  assert.deepEqual(again, {}, 'restore is one-shot');
});

test('pause stops recording; excluded sites clear the pointer', async () => {
  const t = newTab();
  await go(t, U('q'), 'typed');
  const n = Object.keys(trail().nodes).length;

  store.local.settings = { paused: true };
  await E.onChanged.fire({ settings: { newValue: { paused: true } } }, 'local');
  await go(t, U('r'));
  assert.equal(Object.keys(trail().nodes).length, n, 'paused: nothing added');

  store.local.settings = { excluded: ['bank.test'] };
  await E.onChanged.fire({ settings: { newValue: { excluded: ['bank.test'] } } }, 'local');
  await go(t, 'https://www.bank.test/account');
  assert.equal(Object.keys(trail().nodes).length, n, 'excluded: nothing added');
  assert.equal(store.session.tabstate.ptrs[t], undefined);
});

test('deleteBranch and clearAll work from the panel', async () => {
  store.local.settings = {};
  await E.onChanged.fire({ settings: { newValue: {} } }, 'local');
  const c = nodeByUrl(U('c'));
  const res = await message({ type: 'deleteBranch', nodeId: c.id });
  assert.equal(res.ok, true);
  assert.equal(nodeByUrl(U('c')), undefined);
  assert.deepEqual(kidsOf(U('b')), [U('d')]);

  await message({ type: 'clearAll' });
  assert.deepEqual(Object.keys(trail().nodes), []);
  assert.deepEqual(store.session.tabstate.ptrs, {});
});

test('lanes and edge kinds are recorded: new-tab pages get their own lane and a newtab edge', async () => {
  await message({ type: 'clearAll' });
  const a = newTab();
  await go(a, U('m'), 'typed');
  await go(a, U('n'));
  const b = newTab();
  await E.onCreatedNavigationTarget.fire({ sourceTabId: a, tabId: b, url: U('o') });
  await go(b, U('o'));
  const n = nodeByUrl(U('n'));
  const o = nodeByUrl(U('o'));
  assert.equal(o.parent, n.id);
  assert.equal(o.edge, 'newtab');
  assert.equal(n.edge, 'nav');
  assert.ok(n.lane > 0 && o.lane > 0 && n.lane !== o.lane);
  assert.equal(store.session.tabstate.lanes[b], o.lane);

  const c = newTab();
  await go(c, U('p'), 'typed');
  assert.equal(nodeByUrl(U('p')).parent, null, 'typed tab starts its own trail');
});

test('the map page (an extension page running in a tab) is trusted; web pages are not', async () => {
  const mapSender = { id: 'test-ext', tab: { id: 55 }, url: 'chrome-extension://test-ext/map/map.html' };
  const o = nodeByUrl(U('o'));
  const res = await message({ type: 'resume', nodeId: o.id, newTab: true, active: false }, mapSender);
  assert.equal(res.ok, true);
  const created = Object.values(tabsDB).filter((t) => t.url === U('o') && t.id >= 100).pop();
  assert.ok(created, 'map can open a branch in a new tab');

  const evil = { id: 'test-ext', tab: { id: 56 }, url: 'https://evil.test/' };
  const before = Object.keys(trail().nodes).length;
  assert.equal(await message({ type: 'deleteBranch', nodeId: o.id }, evil), undefined);
  assert.equal(Object.keys(trail().nodes).length, before);
});

test('openMap opens the map once, then focuses it instead of opening a second', async () => {
  const mapUrl = 'chrome-extension://test-ext/map/map.html';
  const count = () => Object.values(tabsDB).filter((t) => t.url === mapUrl).length;
  await message({ type: 'openMap' });
  assert.equal(count(), 1);
  const win = 7;
  Object.values(tabsDB).find((t) => t.url === mapUrl).windowId = win;
  await message({ type: 'openMap' });
  assert.equal(count(), 1, 'no duplicate');
  assert.ok(focused.some(([id]) => id === win), 'existing map window focused');
});

test('toolbar icon opens the side panel by default; the setting switches it to the full-page map', async () => {
  const mapUrl = 'chrome-extension://test-ext/map/map.html';
  assert.equal(panelBehavior.at(-1).openPanelOnActionClick, true, 'default: icon opens the side panel');

  store.local.settings = { iconOpens: 'map' };
  await E.onChanged.fire({ settings: { newValue: { iconOpens: 'map' } } }, 'local');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(panelBehavior.at(-1).openPanelOnActionClick, false);

  for (const t of Object.values(tabsDB)) if (t.url === mapUrl) delete tabsDB[t.id];
  await E.onClicked.fire({});
  assert.ok(Object.values(tabsDB).some((t) => t.url === mapUrl), 'icon click opened the map');

  store.local.settings = { iconOpens: 'panel' };
  await E.onChanged.fire({ settings: { newValue: { iconOpens: 'panel' } } }, 'local');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(panelBehavior.at(-1).openPanelOnActionClick, true);

  for (const t of Object.values(tabsDB)) if (t.url === mapUrl) delete tabsDB[t.id];
  await E.onCommand.fire('open-map');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(Object.values(tabsDB).some((t) => t.url === mapUrl), 'keyboard shortcut opens the map regardless');
});

// ---- active features through the service worker ---------------------------------------

test('restoreLast reopens the page you backed out of, on its existing node', async () => {
  await message({ type: 'clearAll' });
  const t = newTab({ windowId: 1 });
  await go(t, U('r1'), 'typed');
  await go(t, U('r2'));
  await go(t, U('r3'));
  await go(t, U('r2'), 'link', ['forward_back']); // backed out of r3
  assert.deepEqual(trail().left.map((e) => trail().nodes[e.id].url), [U('r3')]);

  const before = Object.keys(trail().nodes).length;
  const res = await message({ type: 'restoreLast' });
  assert.equal(res.ok, true);
  const opened = Object.values(tabsDB).filter((x) => x.url === U('r3')).pop();
  assert.ok(opened, 'a tab opened on r3');
  await go(opened.id, U('r3'));
  assert.equal(store.session.tabstate.ptrs[opened.id], nodeByUrl(U('r3')).id);
  assert.equal(Object.keys(trail().nodes).length, before, 'no duplicate node');
  assert.deepEqual(trail().left, [], 'no longer left behind');

  assert.equal((await message({ type: 'restoreLast' })).ok, false, 'nothing left to restore');
});

test('the Alt+Shift+B command restores the most recently left page', async () => {
  const t = newTab({ windowId: 1 });
  await go(t, U('s1'), 'typed');
  await go(t, U('s2'));
  await go(t, U('s1'), 'link', ['forward_back']);
  await E.onCommand.fire('restore-last');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(Object.values(tabsDB).some((x) => x.url === U('s2') && x.id >= 100), 'opened s2');
});

test('pin, note and dismiss messages from the panel', async () => {
  const n = nodeByUrl(U('s1'));
  assert.equal((await message({ type: 'setPin', nodeId: n.id, pin: true })).ok, true);
  assert.equal((await message({ type: 'setNote', nodeId: n.id, note: ' ask Sam ' })).ok, true);
  assert.equal(trail().nodes[n.id].pin, true);
  assert.equal(trail().nodes[n.id].note, 'ask Sam');
  assert.equal((await message({ type: 'setPin', nodeId: n.id, pin: false })).ok, true);
  assert.equal(trail().nodes[n.id].pin, undefined);

  // web pages cannot do this
  assert.equal(await message({ type: 'setNote', nodeId: n.id, note: 'hacked' }, content(1)), undefined);
  assert.equal(trail().nodes[n.id].note, 'ask Sam');

  await message({ type: 'clearAll' });
  const t = newTab({ windowId: 1 });
  await go(t, U('u1'), 'typed');
  await go(t, U('u2'));
  await go(t, U('u1'), 'link', ['forward_back']);
  assert.equal(trail().left.length, 1);
  await message({ type: 'dismissLeft', nodeId: nodeByUrl(U('u2')).id });
  assert.equal(trail().left.length, 0);
});

test('park closes a trail\'s tabs (keeping the window alive), unpark reopens them on the same pages', async () => {
  await message({ type: 'clearAll' });
  for (const id of Object.keys(tabsDB)) delete tabsDB[id];
  const t1 = newTab({ windowId: 1 });
  await go(t1, U('p1'), 'typed');
  await go(t1, U('p2'));
  const t2 = newTab({ windowId: 1 });
  await E.onCreatedNavigationTarget.fire({ sourceTabId: t1, tabId: t2, url: U('p3') });
  await go(t2, U('p3'));
  const other = newTab({ windowId: 2 });
  await go(other, U('q1'), 'typed');
  const root = trail().roots.find((r) => trail().nodes[r].url === U('p1'));
  const nodeCount = Object.keys(trail().nodes).length;

  const res = await message({ type: 'park', rootId: root });
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.ok(!tabsDB[t1] && !tabsDB[t2], 'both tabs closed');
  assert.ok(tabsDB[other], 'other trail untouched');
  assert.ok(Object.values(tabsDB).some((x) => x.windowId === 1), 'window 1 kept alive with a blank tab');
  assert.deepEqual(trail().nodes[root].parked.nodes.length, 2);
  await new Promise((r) => setTimeout(r, 30)); // onRemoved events are processed after the park call
  assert.equal(store.session.tabstate.ptrs[t1], undefined, 'pointers dropped with the tabs');

  const un = await message({ type: 'unpark', rootId: root });
  assert.equal(un.count, 2);
  const reopened = Object.values(tabsDB).filter((x) => x.id >= 100 && (x.url === U('p2') || x.url === U('p3')));
  assert.equal(reopened.length, 2);
  for (const x of reopened) await go(x.id, x.url);
  assert.equal(Object.keys(trail().nodes).length, nodeCount, 'reopened onto the original pages');
  assert.equal(trail().nodes[root].parked, undefined);
  const live = Object.values(store.session.tabstate.ptrs);
  assert.ok(live.includes(nodeByUrl(U('p2')).id) && live.includes(nodeByUrl(U('p3')).id));

  assert.equal((await message({ type: 'park', rootId: 'missing' })).ok, false);
});
