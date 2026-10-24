// tree.js: pure navigation-tree logic (no chrome.* calls).
// Shared by the service worker and the side panel, and unit-tested in Node.
//
// Data model
//   trail = { nodes: { [id]: Node }, roots: [id], seq: number, laneSeq: number }
//   Node  = { id, url, title, parent, children: [id], t, last, visits, scroll, via, lastChild,
//             lane,   // which tab-lifetime created this page (colours the map)
//             edge }  // 'nav' = same tab, 'newtab' = opened in a new tab from its parent
//   ptrs  = { [tabId]: nodeId }   ("you are here" pointer per tab)
//
// The key idea: the browser's history is a stack, so going back and clicking a new
// link throws away everything ahead of you. Here every navigation is a node, "back"
// only moves the pointer to the parent, and a new link adds a sibling branch.

export const DEFAULTS = {
  paused: false,
  scroll: false, // remember scroll positions (needs optional host permission)
  maxDays: 30,
  maxNodes: 5000,
  excluded: [],
  iconOpens: 'panel', // what the toolbar icon opens: 'panel' (side panel) or 'map' (full page)
};

const DAY = 86400000;
const REDIRECT_WINDOW_MS = 1500;

export function emptyTrail() {
  return { nodes: {}, roots: [], seq: 0, laneSeq: 0, left: [] };
}

/** Id of the root of the trail a node belongs to. */
export function rootOf(trail, id) {
  let n = trail.nodes[id];
  while (n && n.parent) n = trail.nodes[n.parent];
  return n ? n.id : null;
}

/** Returns a comparable URL (no #fragment), or null for anything that is not http(s). */
export function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

export function isExcluded(url, excluded = []) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return excluded.some((entry) => {
    const d = String(entry).trim().toLowerCase().replace(/^\*?\.?/, '');
    return d && (host === d || host.endsWith('.' + d));
  });
}

function createNode(trail, { url, title, parent, via, now, lane, edge }) {
  const id = 'n' + (++trail.seq).toString(36);
  const node = {
    id,
    url,
    title: title || '',
    parent: parent || null,
    children: [],
    t: now,
    last: now,
    visits: 1,
    scroll: 0,
    via: via || 'link',
    lastChild: null,
    lane: lane || 0,
    edge: edge || 'nav',
  };
  trail.nodes[id] = node;
  if (parent) {
    const p = trail.nodes[parent];
    p.children.push(id);
    p.lastChild = id;
  } else {
    trail.roots.push(id);
  }
  return node;
}

/** Make every ancestor remember which child leads to `node`, so "forward" follows the latest path. */
function markPath(trail, node) {
  let child = node;
  while (child.parent) {
    const p = trail.nodes[child.parent];
    if (!p) break;
    p.lastChild = child.id;
    child = p;
  }
}

function arrive(trail, ptrs, tabId, node, now, action) {
  ptrs[tabId] = node.id;
  node.last = now;
  node.visits = (node.visits || 1) + 1;
  markPath(trail, node);
  clearLeft(trail, node.id);
  return { node, action };
}

function latestByUrl(trail, url) {
  let best = null;
  for (const n of Object.values(trail.nodes)) {
    if (n.url === url && (!best || n.last > best.last)) best = n;
  }
  return best;
}

/** Work out which existing node a back/forward navigation landed on. */
function findHistoryTarget(trail, cur, url) {
  // Back: nearest ancestor with that URL (handles multi-step back and repeated URLs).
  for (let id = cur.parent; id; ) {
    const n = trail.nodes[id];
    if (!n) break;
    if (n.url === url) return { node: n, dir: 'back' };
    id = n.parent;
  }
  // Forward: follow the branch we most recently came from.
  for (let n = cur; n.lastChild && trail.nodes[n.lastChild]; ) {
    n = trail.nodes[n.lastChild];
    if (n.url === url) return { node: n, dir: 'forward' };
  }
  // Any other descendant, nearest first.
  const queue = [...cur.children];
  for (let steps = 0; queue.length && steps < 2000; steps++) {
    const n = trail.nodes[queue.shift()];
    if (!n) continue;
    if (n.url === url) return { node: n, dir: 'forward' };
    queue.push(...n.children);
  }
  return null;
}

/**
 * Record one top-frame navigation. Mutates trail + ptrs.
 * ev = { tabId, url, title?, transitionType?, qualifiers?, openerNode?, resumeNode?, lane?, now? }
 * Returns { node, action } or null when the URL is not trackable.
 * action: new | same | back | forward | resume | redirect | revisit | restore
 */
export function recordNavigation(trail, ptrs, ev) {
  const url = normalizeUrl(ev.url);
  if (!url) return null;
  const q = ev.qualifiers || [];
  const now = ev.now ?? Date.now();
  const tabId = ev.tabId;

  let cur = ptrs[tabId] ? trail.nodes[ptrs[tabId]] : null;
  if (ptrs[tabId] && !cur) delete ptrs[tabId]; // pointer to a pruned node

  // 1. The user clicked a node in the side panel: jump the pointer, add nothing.
  const resume = ev.resumeNode ? trail.nodes[ev.resumeNode] : null;
  if (resume && resume.url === url) return arrive(trail, ptrs, tabId, resume, now, 'resume');

  // 2. Same page again (reload, re-submit, no-op SPA update).
  if (cur && cur.url === url) {
    cur.last = now;
    if (ev.title && !cur.title) cur.title = ev.title;
    return { node: cur, action: 'same' };
  }

  // 3. Back / forward button: move the pointer, never delete anything.
  if (q.includes('forward_back')) {
    const hit = cur ? findHistoryTarget(trail, cur, url) : null;
    const target = hit ? hit.node : cur ? null : latestByUrl(trail, url);
    if (target) {
      const dir = hit ? hit.dir : 'back';
      const res = arrive(trail, ptrs, tabId, target, now, dir);
      // Backing out of a page leaves it behind (unless another tab still has it open).
      if (cur && dir === 'back' && !Object.values(ptrs).includes(cur.id)) noteLeft(trail, cur.id, now);
      return res;
    }
  }

  // 4. Fast client-side redirect: fold into the page that issued it.
  if (cur && q.includes('client_redirect') && now - cur.t < REDIRECT_WINDOW_MS && cur.children.length === 0) {
    cur.url = url;
    cur.title = ev.title || '';
    cur.last = now;
    return { node: cur, action: 'redirect' };
  }

  // 5. A genuinely new page. Where does it hang?
  let parentId = cur ? cur.id : null;
  let edge = 'nav';
  if (!cur) {
    if (ev.openerNode && trail.nodes[ev.openerNode]) {
      parentId = ev.openerNode; // opened from a link in another tab: extends that branch
      edge = 'newtab';
    } else if (ev.transitionType === 'reload' || ev.transitionType === 'auto_toplevel') {
      const known = latestByUrl(trail, url); // browser restart / restored tab
      if (known) return arrive(trail, ptrs, tabId, known, now, 'restore');
    }
  }

  // Clicking the same link twice from the same page reuses that branch instead of duplicating it.
  if (parentId) {
    const parent = trail.nodes[parentId];
    const same = parent.children.map((id) => trail.nodes[id]).find((n) => n && n.url === url);
    if (same) return arrive(trail, ptrs, tabId, same, now, 'revisit');
  }

  const node = createNode(trail, { url, title: ev.title, parent: parentId, via: ev.transitionType, now, lane: ev.lane, edge });
  markPath(trail, node);
  ptrs[tabId] = node.id;
  return { node, action: 'new' };
}

export function setTitle(trail, ptrs, tabId, url, title) {
  const node = ptrs[tabId] ? trail.nodes[ptrs[tabId]] : null;
  if (!node || normalizeUrl(url) !== node.url || node.title === title) return false;
  node.title = title;
  return true;
}

export function setScroll(trail, ptrs, tabId, url, y) {
  const node = ptrs[tabId] ? trail.nodes[ptrs[tabId]] : null;
  if (!node || normalizeUrl(url) !== node.url || node.scroll === y) return false;
  node.scroll = y;
  return true;
}

/** Root-to-node list of nodes. */
export function pathTo(trail, id) {
  const out = [];
  for (let n = trail.nodes[id]; n; n = n.parent ? trail.nodes[n.parent] : null) out.push(n);
  return out.reverse();
}

/** How many branches are saved on this trail relative to a node: everything ahead of it plus
 *  every sibling branch along the path back to the start. Drives the toolbar badge. */
export function savedBranchCount(trail, id) {
  const node = trail.nodes[id];
  if (!node) return 0;
  let n = node.children.length;
  for (let x = node; x.parent; x = trail.nodes[x.parent]) {
    n += trail.nodes[x.parent].children.length - 1;
  }
  return n;
}

export function subtreeIds(trail, id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const n = trail.nodes[stack.pop()];
    if (!n) continue;
    out.push(n.id);
    for (const c of n.children) stack.push(c);
  }
  return out;
}

/** Delete a node and everything below it. Tabs pointing into it are moved to the surviving parent. */
export function removeBranch(trail, ptrs, id) {
  const root = trail.nodes[id];
  if (!root) return 0;
  const ids = subtreeIds(trail, id);
  const gone = new Set(ids);
  for (const [tabId, nid] of Object.entries(ptrs)) {
    if (!gone.has(nid)) continue;
    if (root.parent) ptrs[tabId] = root.parent;
    else delete ptrs[tabId];
  }
  if (root.parent) {
    const p = trail.nodes[root.parent];
    p.children = p.children.filter((c) => c !== id);
    if (p.lastChild === id) p.lastChild = p.children[p.children.length - 1] ?? null;
  } else {
    trail.roots = trail.roots.filter((r) => r !== id);
  }
  for (const x of ids) delete trail.nodes[x];
  if (trail.left) trail.left = trail.left.filter((e) => !gone.has(e.id));
  return ids.length;
}

function activityMap(trail) {
  const act = {};
  for (const r of trail.roots) {
    const stack = [[r, false]];
    while (stack.length) {
      const [id, done] = stack.pop();
      const n = trail.nodes[id];
      if (!n) continue;
      if (!done) {
        stack.push([id, true]);
        for (const c of n.children) stack.push([c, false]);
      } else {
        let m = n.last;
        for (const c of n.children) if (act[c] > m) m = act[c];
        act[id] = m;
      }
    }
  }
  return act;
}

/** { [rootId]: timestamp of the most recent visit anywhere in that trail } */
export function rootActivity(trail) {
  const act = activityMap(trail);
  return Object.fromEntries(trail.roots.map((r) => [r, act[r] ?? 0]));
}

/** Drop old branches and enforce a size cap. Never touches a tab's current path. */
export function pruneTrail(trail, ptrs, { maxDays = DEFAULTS.maxDays, maxNodes = DEFAULTS.maxNodes, now = Date.now() } = {}) {
  const keep = new Set();
  const keepPath = (nid) => {
    for (let n = trail.nodes[nid]; n && !keep.has(n.id); n = n.parent ? trail.nodes[n.parent] : null) keep.add(n.id);
  };
  for (const nid of Object.values(ptrs)) keepPath(nid); // pages open in a tab
  for (const n of Object.values(trail.nodes)) if (n.pin || n.note) keepPath(n.id); // pinned or annotated pages
  for (const r of trail.roots) for (const nid of trail.nodes[r].parked?.nodes || []) keepPath(nid); // parked trails

  let removed = 0;
  const act = activityMap(trail);
  const cutoff = now - maxDays * DAY;
  const stack = [...trail.roots];
  while (stack.length) {
    const id = stack.pop();
    const n = trail.nodes[id];
    if (!n) continue;
    if (act[id] < cutoff && !keep.has(id)) removed += removeBranch(trail, ptrs, id);
    else stack.push(...n.children);
  }

  let count = Object.keys(trail.nodes).length;
  while (count > maxNodes) {
    const leaves = Object.values(trail.nodes)
      .filter((n) => n.children.length === 0 && !keep.has(n.id))
      .sort((a, b) => a.last - b.last);
    if (!leaves.length) break;
    for (const leaf of leaves.slice(0, count - maxNodes)) removed += removeBranch(trail, ptrs, leaf.id);
    count = Object.keys(trail.nodes).length;
  }
  return removed;
}

export function searchNodes(trail, query, limit = 100) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.values(trail.nodes)
    .filter((n) => (n.title || '').toLowerCase().includes(q) || n.url.toLowerCase().includes(q))
    .sort((a, b) => b.last - a.last)
    .slice(0, limit);
}

export function trailStats(trail) {
  return { pages: Object.keys(trail.nodes).length, trails: trail.roots.length };
}

// ---- left behind -------------------------------------------------------------
// Pages you backed out of. Surfaced so a one-click "restore" can bring one back.

const LEFT_MAX = 30;

export function noteLeft(trail, id, now = Date.now()) {
  trail.left = (trail.left || []).filter((e) => e.id !== id);
  trail.left.unshift({ id, t: now });
  if (trail.left.length > LEFT_MAX) trail.left.length = LEFT_MAX;
}

export function clearLeft(trail, id) {
  if (trail.left && trail.left.some((e) => e.id === id)) trail.left = trail.left.filter((e) => e.id !== id);
}

/** Newest first: [{ node, t }]. Skips pages that are open in a tab again, or older than maxAgeMs. */
export function leftBehind(trail, ptrs, { limit = 8, maxAgeMs = DAY, now = Date.now() } = {}) {
  const open = new Set(Object.values(ptrs));
  return (trail.left || [])
    .filter((e) => trail.nodes[e.id] && !open.has(e.id) && now - e.t <= maxAgeMs)
    .slice(0, limit)
    .map((e) => ({ node: trail.nodes[e.id], t: e.t }));
}

// ---- pins and notes ------------------------------------------------------------

export function setPin(trail, id, pin) {
  const n = trail.nodes[id];
  if (!n) return false;
  if (pin) n.pin = true;
  else delete n.pin;
  return true;
}

export function setNote(trail, id, note) {
  const n = trail.nodes[id];
  if (!n) return false;
  const v = String(note ?? '').trim().slice(0, 280);
  if (v) n.note = v;
  else delete n.note;
  return true;
}

/** Pinned or annotated pages, newest first. */
export function savedNodes(trail) {
  return Object.values(trail.nodes)
    .filter((n) => n.pin || n.note)
    .sort((a, b) => b.last - a.last);
}

// ---- parking ---------------------------------------------------------------------
// Park a trail: remember which pages its open tabs are on so the tabs can be closed and
// reopened later. Pure bookkeeping; the service worker closes and reopens the tabs.

/** Returns { tabs, nodes } (open tabs on this trail) or null if none are open. */
export function parkTrail(trail, ptrs, rootId, now = Date.now()) {
  const root = trail.nodes[rootId];
  if (!root) return null;
  const tabs = [];
  const nodes = [];
  for (const [tabId, nid] of Object.entries(ptrs)) {
    if (rootOf(trail, nid) !== rootId) continue;
    tabs.push(Number(tabId));
    if (!nodes.includes(nid)) nodes.push(nid);
  }
  if (!tabs.length) return null;
  root.parked = { t: now, nodes };
  return { tabs, nodes };
}

/** Clears the parked state and returns the node ids to reopen, in order. */
export function unparkTrail(trail, rootId) {
  const root = trail.nodes[rootId];
  if (!root || !root.parked) return [];
  const nodes = root.parked.nodes.filter((id) => trail.nodes[id]);
  delete root.parked;
  return nodes;
}

export function forgetParked(trail, rootId) {
  const root = trail.nodes[rootId];
  if (root) delete root.parked;
}

/** Parked trails, newest first: [{ rootId, root, t, count }]. */
export function parkedTrails(trail) {
  return trail.roots
    .map((id) => trail.nodes[id])
    .filter((r) => r && r.parked)
    .map((r) => ({ rootId: r.id, root: r, t: r.parked.t, count: r.parked.nodes.length }))
    .sort((a, b) => b.t - a.t);
}
