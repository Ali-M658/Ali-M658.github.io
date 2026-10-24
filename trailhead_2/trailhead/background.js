// Trailhead service worker. All state changes go through one promise queue so that
// bursts of navigation events can never interleave.

import {
  DEFAULTS,
  emptyTrail,
  normalizeUrl,
  isExcluded,
  recordNavigation,
  setTitle,
  setScroll,
  savedBranchCount,
  removeBranch,
  pruneTrail,
  leftBehind,
  setPin,
  setNote,
  clearLeft,
  parkTrail,
  unparkTrail,
  forgetParked,
} from './tree.js';

const TRAIL = 'trail'; // chrome.storage.local: the tree (persists)
const TABS = 'tabstate'; // chrome.storage.session: tab pointers (tab ids die with the browser session)
const SETTINGS = 'settings'; // chrome.storage.local: written by the side panel

let mem = null;
let chain = Promise.resolve();
let saveTimer = null;
let navsSincePrune = 0;

function enqueue(fn) {
  const run = chain.then(async () => {
    await load();
    return fn();
  });
  chain = run.catch((err) => console.error('[Trailhead]', err));
  return run;
}

async function load() {
  if (mem) return;
  const [local, session] = await Promise.all([
    chrome.storage.local.get([TRAIL, SETTINGS]),
    chrome.storage.session.get(TABS),
  ]);
  const s = session[TABS] || {};
  mem = {
    trail: local[TRAIL] || emptyTrail(),
    settings: { ...DEFAULTS, ...(local[SETTINGS] || {}) },
    ptrs: s.ptrs || {},
    pendingOpener: s.pendingOpener || {},
    pendingResumes: s.pendingResumes || (s.pendingResume ? [s.pendingResume] : []),
    lanes: s.lanes || {}, // tabId -> lane id (colours that tab's pages on the map)
    restore: {}, // tabId -> { url, y }, consumed by the content script's "hello"
  };
}

function persistTabs() {
  return chrome.storage.session.set({
    [TABS]: { ptrs: mem.ptrs, pendingOpener: mem.pendingOpener, pendingResumes: mem.pendingResumes, lanes: mem.lanes },
  });
}

function laneFor(tabId) {
  if (!mem.lanes[tabId]) mem.lanes[tabId] = mem.trail.laneSeq = (mem.trail.laneSeq || 0) + 1;
  return mem.lanes[tabId];
}

function wantsMap() {
  return mem.settings.iconOpens === 'map' || !chrome.sidePanel;
}

async function applyActionBehavior() {
  if (chrome.sidePanel) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !wantsMap() }).catch(() => {});
  }
}

/** Reopen the page you most recently backed out of, in a new tab. */
async function restoreLast() {
  const [first] = leftBehind(mem.trail, mem.ptrs, { limit: 1 });
  if (!first) return { ok: false };
  await openNode(first.node, { active: true });
  await persist();
  return { ok: true, nodeId: first.node.id };
}

async function openMap() {
  const url = chrome.runtime.getURL('map/map.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(url));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

async function persist() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await Promise.all([chrome.storage.local.set({ [TRAIL]: mem.trail }), persistTabs()]);
}

// Titles and scroll positions change constantly; batch those writes.
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    enqueue(persist);
  }, 1500);
}

async function updateBadge(tabId) {
  const id = mem.ptrs[tabId];
  const n = id ? savedBranchCount(mem.trail, id) : 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    if (n) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6f4f' });
  } catch {
    /* tab may be gone */
  }
}

async function updateAllBadges() {
  for (const tabId of Object.keys(mem.ptrs)) await updateBadge(Number(tabId));
}

async function runPrune() {
  const removed = pruneTrail(mem.trail, mem.ptrs, {
    maxDays: mem.settings.maxDays,
    maxNodes: mem.settings.maxNodes,
  });
  if (removed) {
    await persist();
    await updateAllBadges();
  }
  return removed;
}

/** Open a recorded page on purpose. The next navigation to its URL re-points to the existing node. */
async function openNode(node, { active = true, tabId = null } = {}) {
  const entry = { url: node.url, nodeId: node.id, expires: Date.now() + 20000, tabId };
  mem.pendingResumes.push(entry);
  await persistTabs();
  if (tabId != null) {
    await chrome.tabs.update(tabId, { url: node.url });
    return null;
  }
  const t = await chrome.tabs.create({ url: node.url, active });
  entry.tabId = t.id;
  return t;
}

// ---- navigation ------------------------------------------------------------

function onNavigation(d) {
  if (d.frameId !== 0) return;
  return enqueue(async () => {
    const now = Date.now();
    const url = normalizeUrl(d.url);

    // Left the web (chrome://, file://, new tab page...): the next page starts a fresh trail.
    if (!url) {
      if (mem.ptrs[d.tabId] !== undefined) {
        delete mem.ptrs[d.tabId];
        await persistTabs();
        await updateBadge(d.tabId);
      }
      return;
    }
    if (mem.settings.paused) return;

    const tab = await chrome.tabs.get(d.tabId).catch(() => null);
    if (!tab || tab.incognito) return;

    if (isExcluded(url, mem.settings.excluded)) {
      delete mem.ptrs[d.tabId];
      await persistTabs();
      await updateBadge(d.tabId);
      return;
    }

    // A node we opened on purpose (restore, resume, reopen a parked trail) lands on its existing
    // page instead of creating a new one.
    let resumeNode = null;
    mem.pendingResumes = mem.pendingResumes.filter((p) => p.expires > now);
    const pi = mem.pendingResumes.findIndex((p) => p.url === url && (p.tabId == null || p.tabId === d.tabId));
    if (pi >= 0) {
      resumeNode = mem.pendingResumes[pi].nodeId;
      mem.pendingResumes.splice(pi, 1);
    }

    const res = recordNavigation(mem.trail, mem.ptrs, {
      tabId: d.tabId,
      url,
      title: tab.status === 'complete' ? tab.title : '',
      transitionType: d.transitionType,
      qualifiers: d.transitionQualifiers,
      openerNode: mem.pendingOpener[d.tabId],
      resumeNode,
      lane: laneFor(d.tabId),
      now,
    });
    delete mem.pendingOpener[d.tabId];

    if (res && res.action === 'resume' && res.node.scroll > 0) {
      mem.restore[d.tabId] = { url: res.node.url, y: res.node.scroll };
    }
    if (++navsSincePrune >= 100) {
      navsSincePrune = 0;
      pruneTrail(mem.trail, mem.ptrs, { maxDays: mem.settings.maxDays, maxNodes: mem.settings.maxNodes });
    }
    await persist();
    await updateBadge(d.tabId);
  });
}

chrome.webNavigation.onCommitted.addListener(onNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(onNavigation); // SPA pushState / popstate

// Remember which node a link-opened tab came from, before the opener navigates away.
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) =>
  enqueue(async () => {
    const src = mem.ptrs[d.sourceTabId];
    if (src && !mem.pendingOpener[d.tabId]) {
      mem.pendingOpener[d.tabId] = src;
      await persistTabs();
    }
  }),
);
chrome.tabs.onCreated.addListener((tab) =>
  enqueue(async () => {
    const src = tab.openerTabId != null ? mem.ptrs[tab.openerTabId] : null;
    if (src && !mem.pendingOpener[tab.id]) {
      mem.pendingOpener[tab.id] = src;
      await persistTabs();
    }
  }),
);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.title === undefined) return;
  return enqueue(async () => {
    if (setTitle(mem.trail, mem.ptrs, tabId, tab.url, info.title)) scheduleSave();
  });
});

chrome.tabs.onRemoved.addListener((tabId) =>
  enqueue(async () => {
    delete mem.ptrs[tabId];
    delete mem.pendingOpener[tabId];
    delete mem.lanes[tabId];
    delete mem.restore[tabId];
    await persistTabs();
  }),
);

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
  enqueue(async () => {
    if (mem.ptrs[removedTabId] !== undefined) {
      mem.ptrs[addedTabId] = mem.ptrs[removedTabId];
      delete mem.ptrs[removedTabId];
    }
    if (mem.lanes[removedTabId] !== undefined) {
      mem.lanes[addedTabId] = mem.lanes[removedTabId];
      delete mem.lanes[removedTabId];
    }
    await persistTabs();
  }),
);

chrome.tabs.onActivated.addListener(({ tabId }) => enqueue(() => updateBadge(tabId)));

// ---- messages --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  // Content scripts run inside web pages and are untrusted. Our own pages (side panel, map)
  // are recognised by their chrome-extension:// URL; the map runs in a tab, so sender.tab alone
  // cannot tell them apart.
  const trusted = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  const fromPage = !trusted;

  if (fromPage) {
    if (!sender.tab) return false;
    if (msg.type === 'scroll' && typeof msg.y === 'number') {
      enqueue(async () => {
        if (setScroll(mem.trail, mem.ptrs, sender.tab.id, msg.url, Math.max(0, Math.round(msg.y)))) scheduleSave();
      });
      return false;
    }
    if (msg.type === 'hello') {
      enqueue(async () => {
        const r = mem.restore[sender.tab.id];
        if (r && r.url === normalizeUrl(msg.url)) {
          delete mem.restore[sender.tab.id];
          return { restoreY: r.y };
        }
        return {};
      }).then(sendResponse, () => sendResponse({}));
      return true;
    }
    return false;
  }

  // Everything below comes from our own extension pages only.
  switch (msg.type) {
    case 'openMap':
      enqueue(openMap).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;

    case 'resume':
      enqueue(async () => {
        const node = mem.trail.nodes[msg.nodeId];
        if (!node) return { ok: false };
        await openNode(node, msg.newTab ? { active: msg.active !== false } : { tabId: msg.tabId });
        await persist();
        return { ok: true };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'setPin':
      enqueue(async () => {
        const ok = setPin(mem.trail, msg.nodeId, !!msg.pin);
        await persist();
        return { ok };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'setNote':
      enqueue(async () => {
        const ok = setNote(mem.trail, msg.nodeId, msg.note);
        await persist();
        return { ok };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'dismissLeft':
      enqueue(async () => {
        clearLeft(mem.trail, msg.nodeId);
        await persist();
        return { ok: true };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'restoreLast':
      enqueue(restoreLast).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'park':
      enqueue(async () => {
        const res = parkTrail(mem.trail, mem.ptrs, msg.rootId);
        if (!res) return { ok: false };
        await persist();
        // Closing every tab in a window would close the window (or the browser): keep one blank tab.
        const closing = new Set(res.tabs);
        const all = await chrome.tabs.query({});
        const remaining = new Map();
        for (const t of all) remaining.set(t.windowId, (remaining.get(t.windowId) || 0) + (closing.has(t.id) ? 0 : 1));
        for (const [windowId, n] of remaining) {
          if (n === 0) await chrome.tabs.create({ windowId });
        }
        await chrome.tabs.remove(res.tabs);
        return { ok: true, count: res.tabs.length };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'unpark':
      enqueue(async () => {
        const ids = unparkTrail(mem.trail, msg.rootId);
        for (let i = 0; i < ids.length; i++) await openNode(mem.trail.nodes[ids[i]], { active: i === 0 });
        await persist();
        return { ok: true, count: ids.length };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'forgetParked':
      enqueue(async () => {
        forgetParked(mem.trail, msg.rootId);
        await persist();
        return { ok: true };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'deleteBranch':
      enqueue(async () => {
        const n = removeBranch(mem.trail, mem.ptrs, msg.nodeId);
        await persist();
        await updateAllBadges();
        return { ok: true, removed: n };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'clearAll':
      enqueue(async () => {
        mem.trail = emptyTrail();
        mem.ptrs = {};
        mem.pendingOpener = {};
        mem.pendingResumes = [];
        mem.lanes = {};
        mem.restore = {};
        await persist();
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) await chrome.action.setBadgeText({ tabId: t.id, text: '' }).catch(() => {});
        return { ok: true };
      }).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case 'prune':
      enqueue(runPrune).then((removed) => sendResponse({ ok: true, removed }), () => sendResponse({ ok: false }));
      return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS] && mem) {
    mem.settings = { ...DEFAULTS, ...(changes[SETTINGS].newValue || {}) };
    enqueue(applyActionBehavior);
  }
});

// ---- housekeeping ----------------------------------------------------------

// Toolbar icon: opens the full-page map by default, or the side panel if the user prefers it.
// (When the panel opens on click, Chrome never fires action.onClicked.)
enqueue(applyActionBehavior);
chrome.action.onClicked.addListener(() =>
  enqueue(async () => {
    if (wantsMap()) await openMap();
  }),
);
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-map') enqueue(openMap);
  if (cmd === 'restore-last') enqueue(restoreLast);
});
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('prune', { periodInMinutes: 1440 }));
chrome.runtime.onStartup.addListener(() => enqueue(runPrune));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'prune') enqueue(runPrune);
});
