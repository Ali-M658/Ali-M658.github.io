import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTrail,
  normalizeUrl,
  isExcluded,
  recordNavigation,
  setTitle,
  setScroll,
  pathTo,
  savedBranchCount,
  removeBranch,
  pruneTrail,
  searchNodes,
} from '../tree.js';

const A = 'https://a.test/';
const B = 'https://b.test/';
const C = 'https://c.test/';
const D = 'https://d.test/';
const E = 'https://e.test/';

function setup() {
  return { trail: emptyTrail(), ptrs: {}, t: 1000 };
}
function nav(s, url, extra = {}) {
  s.t += 1000;
  return recordNavigation(s.trail, s.ptrs, { tabId: 1, url, transitionType: 'link', now: s.t, ...extra });
}
const back = (s, url) => nav(s, url, { qualifiers: ['forward_back'] });
const node = (s, url) => Object.values(s.trail.nodes).find((n) => n.url === url);
const cur = (s, tab = 1) => s.trail.nodes[s.ptrs[tab]];
const kids = (s, url) => node(s, url).children.map((id) => s.trail.nodes[id].url);

test('normalizeUrl drops fragments and rejects non-web URLs', () => {
  assert.equal(normalizeUrl('https://x.test/p#frag'), 'https://x.test/p');
  assert.equal(normalizeUrl('chrome://settings'), null);
  assert.equal(normalizeUrl('file:///etc/hosts'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('isExcluded matches domains and subdomains', () => {
  assert.equal(isExcluded('https://mail.bank.com/x', ['bank.com']), true);
  assert.equal(isExcluded('https://bank.com/', ['*.bank.com']), true);
  assert.equal(isExcluded('https://notbank.com/', ['bank.com']), false);
});

test('linear browsing builds a chain', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  assert.deepEqual(pathTo(s.trail, cur(s).id).map((n) => n.url), [A, B, C]);
  assert.equal(s.trail.roots.length, 1);
});

test('THE CORE CASE: back, then a new link keeps the old branch', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  const r = back(s, B);
  assert.equal(r.action, 'back');
  assert.equal(cur(s).url, B);
  nav(s, D); // browser would now discard C
  assert.deepEqual(kids(s, B), [C, D], 'C must survive as a sibling of D');
  assert.equal(cur(s).url, D);
  assert.equal(savedBranchCount(s.trail, cur(s).id), 1);
  assert.ok(node(s, C), 'C node still exists');
});

test('going back several steps then branching preserves the whole old subtree', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  back(s, B);
  back(s, A);
  nav(s, E);
  assert.deepEqual(kids(s, A), [B, E]);
  assert.deepEqual(kids(s, B), [C]);
  assert.equal(savedBranchCount(s.trail, cur(s).id), 1);
});

test('forward follows the branch you came back from', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  back(s, B);
  const r = back(s, C); // forward is also reported as forward_back
  assert.equal(r.action, 'forward');
  assert.equal(cur(s).url, C);
  assert.equal(s.trail.nodes[node(s, B).id].children.length, 1);
});

test('forward after branching goes to the newest branch, not the old one', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  back(s, B);
  nav(s, D);
  back(s, B);
  assert.equal(back(s, D).action, 'forward');
  assert.equal(cur(s).url, D);
});

test('clicking the same link again reuses the existing branch', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  back(s, B);
  const r = nav(s, C);
  assert.equal(r.action, 'revisit');
  assert.deepEqual(kids(s, B), [C]);
  assert.equal(node(s, C).visits, 2);
});

test('reload and no-op updates stay on the same node', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  const id = cur(s).id;
  assert.equal(nav(s, A, { transitionType: 'reload' }).action, 'same');
  assert.equal(nav(s, 'https://a.test/#section').action, 'same');
  assert.equal(cur(s).id, id);
  assert.equal(Object.keys(s.trail.nodes).length, 1);
});

test('repeated URL on a path: back picks the nearest ancestor', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, A); // a second, distinct visit to A (child of B)
  const a2 = cur(s).id;
  back(s, B);
  assert.equal(cur(s).url, B);
  back(s, A);
  assert.notEqual(cur(s).id, a2, 'went back to the first A, not the later one');
});

test('link opened in a new tab hangs off the node it came from', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  const b = nav(s, B).node;
  const r = recordNavigation(s.trail, s.ptrs, { tabId: 2, url: C, openerNode: b.id, now: 9000 });
  assert.equal(r.node.parent, b.id);
  assert.equal(s.ptrs[2], r.node.id);
  assert.equal(s.ptrs[1], b.id, 'opener tab pointer untouched');
});

test('tab with no pointer and no opener starts a new trail', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  const r = recordNavigation(s.trail, s.ptrs, { tabId: 7, url: B, transitionType: 'typed', now: 5000 });
  assert.equal(r.node.parent, null);
  assert.equal(s.trail.roots.length, 2);
});

test('restored tab (reload with no pointer) reattaches to the known node', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  const b = nav(s, B).node;
  s.ptrs = {}; // browser restarted: tab pointers are gone
  const r = recordNavigation(s.trail, s.ptrs, { tabId: 3, url: B, transitionType: 'reload', now: 9000 });
  assert.equal(r.action, 'restore');
  assert.equal(r.node.id, b.id);
  assert.equal(Object.keys(s.trail.nodes).length, 2);
});

test('fast client redirect is folded into the page that issued it', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  s.t += 200;
  const r = recordNavigation(s.trail, s.ptrs, { tabId: 1, url: B, qualifiers: ['client_redirect'], now: s.t });
  assert.equal(r.action, 'redirect');
  assert.equal(Object.keys(s.trail.nodes).length, 1);
  assert.equal(cur(s).url, B);
});

test('a slow "client redirect" is treated as a real navigation', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  s.t += 10000;
  const r = recordNavigation(s.trail, s.ptrs, { tabId: 1, url: B, qualifiers: ['client_redirect'], now: s.t });
  assert.equal(r.action, 'new');
  assert.equal(Object.keys(s.trail.nodes).length, 2);
});

test('resume jumps the pointer to an old branch without adding nodes', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  back(s, B);
  nav(s, D);
  const c = node(s, C);
  const before = Object.keys(s.trail.nodes).length;
  const r = nav(s, C, { resumeNode: c.id });
  assert.equal(r.action, 'resume');
  assert.equal(cur(s).id, c.id);
  assert.equal(Object.keys(s.trail.nodes).length, before);
});

test('non-web URLs are ignored', () => {
  const s = setup();
  assert.equal(nav(s, 'chrome://settings'), null);
  assert.equal(Object.keys(s.trail.nodes).length, 0);
});

test('titles and scroll only apply to the page the tab is actually on', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  assert.equal(setTitle(s.trail, s.ptrs, 1, A, 'Alpha'), true);
  assert.equal(setTitle(s.trail, s.ptrs, 1, B, 'Wrong'), false);
  assert.equal(setScroll(s.trail, s.ptrs, 1, A, 640), true);
  assert.equal(setScroll(s.trail, s.ptrs, 1, B, 99), false);
  assert.equal(cur(s).title, 'Alpha');
  assert.equal(cur(s).scroll, 640);
});

test('removeBranch deletes a subtree and re-points tabs inside it', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  const b = node(s, B);
  const removed = removeBranch(s.trail, s.ptrs, b.id);
  assert.equal(removed, 2);
  assert.equal(cur(s).url, A);
  assert.equal(node(s, A).children.length, 0);
});

test('removeBranch on a root forgets the whole trail', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  removeBranch(s.trail, s.ptrs, node(s, A).id);
  assert.equal(Object.keys(s.trail.nodes).length, 0);
  assert.equal(s.trail.roots.length, 0);
  assert.equal(s.ptrs[1], undefined);
});

test('pruneTrail drops old branches but never the path a tab is on', () => {
  const s = setup();
  const day = 86400000;
  const now = 100 * day;
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: A, transitionType: 'typed', now: now - 60 * day });
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: B, now: now - 59 * day });
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: C, now: now - 58 * day });
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: B, qualifiers: ['forward_back'], now: now - 57 * day });
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: D, now: now - 56 * day });
  // unrelated old trail in a closed tab
  recordNavigation(s.trail, s.ptrs, { tabId: 9, url: E, transitionType: 'typed', now: now - 50 * day });
  delete s.ptrs[9];

  const removed = pruneTrail(s.trail, s.ptrs, { maxDays: 30, maxNodes: 5000, now });
  assert.equal(removed, 2, 'old trail E and old branch C removed...');
  assert.ok(node(s, A) && node(s, B) && node(s, D), '...but the live path survives');
  assert.equal(node(s, E), undefined);
  assert.equal(node(s, C), undefined, 'stale side branch pruned');
});

test('pruneTrail enforces the node cap by dropping oldest leaves', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  for (let i = 0; i < 20; i++) nav(s, `https://x.test/${i}`);
  s.ptrs = { 1: node(s, 'https://x.test/19').id };
  pruneTrail(s.trail, s.ptrs, { maxDays: 365, maxNodes: 10, now: s.t });
  assert.ok(Object.keys(s.trail.nodes).length <= 21);
  assert.ok(cur(s), 'current node kept');
});

test('searchNodes matches titles and URLs, newest first', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed', title: 'Alpha docs' });
  nav(s, B, { title: 'Beta' });
  assert.deepEqual(searchNodes(s.trail, 'alpha').map((n) => n.url), [A]);
  assert.deepEqual(searchNodes(s.trail, 'b.test').map((n) => n.url), [B]);
  assert.deepEqual(searchNodes(s.trail, '   '), []);
});

// ---- active features -----------------------------------------------------------------
import {
  leftBehind,
  noteLeft,
  setPin,
  setNote,
  savedNodes,
  parkTrail,
  unparkTrail,
  forgetParked,
  parkedTrails,
  rootOf,
} from '../tree.js';

test('backing out of a page leaves it behind; going forward again takes it off the list', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  back(s, B);
  let left = leftBehind(s.trail, s.ptrs, { now: s.t });
  assert.deepEqual(left.map((e) => e.node.url), [C]);
  back(s, C); // forward
  assert.deepEqual(leftBehind(s.trail, s.ptrs, { now: s.t }), []);
});

test('left-behind survives a new branch and orders newest first', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  nav(s, C);
  back(s, B); // leaves C
  nav(s, D);
  back(s, B); // leaves D
  assert.deepEqual(leftBehind(s.trail, s.ptrs, { now: s.t }).map((e) => e.node.url), [D, C]);
});

test('a page still open in another tab is not "left behind"', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  s.ptrs[2] = node(s, B).id; // tab 2 is also on B
  back(s, A);
  assert.deepEqual(leftBehind(s.trail, s.ptrs, { now: s.t }), []);
});

test('left-behind entries age out and vanish when their page is deleted', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  back(s, A);
  assert.equal(leftBehind(s.trail, s.ptrs, { now: s.t }).length, 1);
  assert.equal(leftBehind(s.trail, s.ptrs, { now: s.t + 2 * 86400000 }).length, 0, 'older than a day');
  removeBranch(s.trail, s.ptrs, node(s, B).id);
  assert.equal(s.trail.left.length, 0);
});

test('left list is capped', () => {
  const trail = emptyTrail();
  for (let i = 0; i < 100; i++) noteLeft(trail, 'n' + i, i);
  assert.equal(trail.left.length, 30);
  assert.equal(trail.left[0].id, 'n99');
});

test('pins and notes are stored, listed, trimmed, and protect a page from pruning', () => {
  const s = setup();
  const day = 86400000;
  const now = 100 * day;
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: A, transitionType: 'typed', now: now - 60 * day });
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: B, now: now - 59 * day });
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: C, now: now - 58 * day });
  const b = node(s, B);
  assert.equal(setPin(s.trail, b.id, true), true);
  assert.equal(setNote(s.trail, b.id, '   compare with the other quote  '), true);
  assert.equal(b.note, 'compare with the other quote');
  assert.deepEqual(savedNodes(s.trail).map((n) => n.url), [B]);
  s.ptrs = {}; // everything closed
  pruneTrail(s.trail, s.ptrs, { maxDays: 30, now });
  assert.ok(node(s, A) && node(s, B), 'pinned page and the path to it survive');
  assert.equal(node(s, C), undefined, 'unpinned old page is pruned');
  setPin(s.trail, b.id, false);
  setNote(s.trail, b.id, '');
  assert.deepEqual(savedNodes(s.trail), []);
  assert.equal(setPin(s.trail, 'missing', true), false);
});

test('notes are length-limited', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  setNote(s.trail, node(s, A).id, 'x'.repeat(1000));
  assert.equal(node(s, A).note.length, 280);
});

test('parkTrail records the open pages of one trail only, and unpark returns them', () => {
  const s = setup();
  nav(s, A, { transitionType: 'typed' });
  nav(s, B);
  const b = node(s, B).id;
  recordNavigation(s.trail, s.ptrs, { tabId: 2, url: C, openerNode: b, now: 9000 }); // same trail
  recordNavigation(s.trail, s.ptrs, { tabId: 3, url: D, transitionType: 'typed', now: 9500 }); // other trail
  const root = rootOf(s.trail, b);
  const res = parkTrail(s.trail, s.ptrs, root, 10000);
  assert.deepEqual(res.tabs.sort(), [1, 2]);
  assert.equal(res.nodes.length, 2);
  assert.equal(parkedTrails(s.trail).length, 1);
  assert.equal(parkedTrails(s.trail)[0].count, 2);
  assert.equal(parkTrail(s.trail, { 5: 'nonexistent' }, root), null, 'no open tabs: nothing to park');
  const ids = unparkTrail(s.trail, root);
  assert.equal(ids.length, 2);
  assert.equal(parkedTrails(s.trail).length, 0);
  assert.deepEqual(unparkTrail(s.trail, root), []);
});

test('parked trails are protected from pruning, and forgetParked clears the mark', () => {
  const s = setup();
  const day = 86400000;
  const now = 200 * day;
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: A, transitionType: 'typed', now: now - 90 * day });
  recordNavigation(s.trail, s.ptrs, { tabId: 1, url: B, now: now - 89 * day });
  const root = rootOf(s.trail, node(s, A).id);
  parkTrail(s.trail, s.ptrs, root, now - 88 * day);
  s.ptrs = {};
  pruneTrail(s.trail, s.ptrs, { maxDays: 30, now });
  assert.ok(node(s, A) && node(s, B), 'parked trail survives');
  forgetParked(s.trail, root);
  pruneTrail(s.trail, s.ptrs, { maxDays: 30, now });
  assert.equal(Object.keys(s.trail.nodes).length, 0, 'once unparked it ages out normally');
});
