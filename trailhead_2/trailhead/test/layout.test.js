import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrail, recordNavigation, rootOf } from '../tree.js';
import { layoutMap, GEO, GEO_COMPACT, MAX_STRIPS } from '../layout.js';

const U = (c) => `https://${c}.test/`;

function session() {
  const trail = emptyTrail();
  const ptrs = {};
  let t = 1000;
  const lanes = {};
  const nav = (tabId, url, extra = {}) => {
    t += 1000;
    lanes[tabId] ||= ++trail.laneSeq;
    return recordNavigation(trail, ptrs, { tabId, url, transitionType: 'link', lane: lanes[tabId], now: t, ...extra });
  };
  const back = (tabId, url) => nav(tabId, url, { qualifiers: ['forward_back'] });
  return { trail, ptrs, nav, back };
}
const byUrl = (trail, url) => Object.values(trail.nodes).find((n) => n.url === url);

test('a link opened in a new tab extends the source branch with a new-tab edge and a new lane', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  const d = s.nav(1, U('d')).node;
  const e = s.nav(2, U('e'), { openerNode: d.id }).node;
  assert.equal(e.parent, d.id);
  assert.equal(e.edge, 'newtab');
  assert.notEqual(e.lane, d.lane, 'new tab gets its own colour lane');
  assert.equal(rootOf(s.trail, e.id), rootOf(s.trail, d.id), 'same trail');
});

test('a blank or typed tab is a separate trail', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  s.nav(2, U('f'), { transitionType: 'typed' });
  assert.equal(s.trail.roots.length, 2);
  const L = layoutMap(s.trail, s.ptrs);
  assert.equal(L.groups.length, 2);
  assert.ok(L.groups[1].top > L.groups[0].top + L.groups[0].height - 1, 'clusters do not overlap');
});

test('branches stack vertically at the same depth; the new-tab child sits on the source row band', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  s.nav(1, U('b'));
  s.nav(1, U('c'));
  s.back(1, U('b'));
  const d = s.nav(1, U('d')).node;
  s.nav(2, U('e'), { openerNode: d.id });

  const L = layoutMap(s.trail, s.ptrs);
  const at = (c) => L.index[byUrl(s.trail, U(c)).id];
  assert.equal(at('c').x, at('d').x, 'siblings share a column');
  assert.notEqual(at('c').y, at('d').y, 'siblings get different rows');
  assert.equal(at('e').x, at('d').x + GEO.XSTEP, 'new-tab page is one column right of its source');
  assert.equal(L.edges.find((e) => e.to === at('e').key).kind, 'newtab');
  assert.equal(L.edges.find((e) => e.to === at('d').key).kind, 'nav');
  assert.deepEqual(at('d').tabs, [1]);
  assert.deepEqual(at('e').tabs, [2]);
  assert.equal(L.groups[0].liveCount, 2);
  // parent is centred between its children
  const kids = [at('c'), at('d')];
  assert.equal(at('b').y, (kids[0].y + kids[1].y) / 2);
});

test('long straight chains collapse to one pill, but never hide open tabs or search hits', () => {
  const s = session();
  s.nav(1, U('start'), { transitionType: 'typed' });
  for (let i = 0; i < 10; i++) s.nav(1, `https://x.test/${i}`);
  s.nav(1, U('end'));

  let L = layoutMap(s.trail, s.ptrs);
  const runs = L.items.filter((i) => i.kind === 'run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].ids.length, 10);
  assert.equal(L.items.length, 3, 'start, pill, end');
  assert.equal(L.groups[0].count, 12, 'count still covers every page');

  // expanding shows everything
  L = layoutMap(s.trail, s.ptrs, { expanded: new Set(runs[0].ids) });
  assert.equal(L.items.filter((i) => i.kind === 'run').length, 0);
  assert.equal(L.items.length, 12);

  // compression off
  L = layoutMap(s.trail, s.ptrs, { compress: false });
  assert.equal(L.items.length, 12);

  // a search hit in the middle keeps itself visible
  const mid = byUrl(s.trail, 'https://x.test/5');
  L = layoutMap(s.trail, s.ptrs, { highlight: new Set([mid.id]) });
  assert.ok(L.index[mid.id], 'hit is drawn');

  // a second tab parked in the middle also splits the run
  s.ptrs[9] = mid.id;
  L = layoutMap(s.trail, s.ptrs);
  assert.ok(L.index[mid.id], 'open tab is drawn');
  assert.deepEqual(L.index[mid.id].tabs, [9]);
});

test('short chains are left alone', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  s.nav(1, U('b'));
  s.nav(1, U('c'));
  s.nav(1, U('d'));
  const L = layoutMap(s.trail, s.ptrs);
  assert.equal(L.items.filter((i) => i.kind === 'run').length, 0);
});

test('only requested roots are laid out, in the requested order', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  s.nav(2, U('b'), { transitionType: 'typed' });
  s.nav(3, U('c'), { transitionType: 'typed' });
  const [ra, , rc] = s.trail.roots;
  const L = layoutMap(s.trail, s.ptrs, { roots: [rc, ra] });
  assert.deepEqual(L.groups.map((g) => g.rootId), [rc, ra]);
  assert.equal(L.items.length, 2);
});

test('layout copes with a very long chain and wide fan-out without recursion errors', () => {
  const s = session();
  s.nav(1, U('root'), { transitionType: 'typed' });
  for (let i = 0; i < 3000; i++) s.nav(1, `https://deep.test/${i}`);
  const rootId = s.trail.roots[0];
  for (let i = 0; i < 300; i++) s.nav(100 + i, `https://fan.test/${i}`, { openerNode: rootId });
  const L = layoutMap(s.trail, {}, {});
  assert.ok(L.items.length > 300);
  assert.ok(Number.isFinite(L.height) && Number.isFinite(L.width));
});

test('empty trail lays out to nothing', () => {
  const L = layoutMap(emptyTrail(), {});
  assert.deepEqual(L.items, []);
  assert.equal(L.height, 0);
});

test('top-down layout (side panel): depth goes down, siblings sit side by side, parents centre above kids', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  s.nav(1, U('b'));
  s.nav(1, U('c'));
  s.back(1, U('b'));
  const d = s.nav(1, U('d')).node;
  s.nav(2, U('e'), { openerNode: d.id });

  const L = layoutMap(s.trail, s.ptrs, { orientation: 'tb' });
  assert.equal(L.orientation, 'tb');
  const at = (c) => L.index[byUrl(s.trail, U(c)).id];
  assert.equal(at('c').y, at('d').y, 'siblings share a level');
  assert.notEqual(at('c').x, at('d').x, 'siblings are in different columns');
  assert.ok(at('b').y > at('a').y && at('c').y > at('b').y, 'depth increases downward');
  assert.ok(at('e').y > at('d').y, 'new-tab page sits below its source');
  assert.equal(at('b').x + at('b').w / 2, (at('c').x + at('c').w / 2 + at('d').x + at('d').w / 2) / 2, 'parent centred');
  assert.equal(L.groups[0].width, 2 * GEO_COMPACT.COLW, 'two leaves = two columns');
  // edges unchanged by orientation
  assert.equal(L.edges.find((e) => e.to === at('e').key).kind, 'newtab');
});

test('a page open in several tabs grows one strip per tab, capped', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  const a = byUrl(s.trail, U('a')).id;
  s.ptrs[2] = a;
  s.ptrs[3] = a;
  let L = layoutMap(s.trail, s.ptrs);
  assert.equal(L.index[a].h, GEO.CARD_H + MAX_STRIPS * GEO.STRIP_H);
  assert.deepEqual(L.index[a].tabs.sort(), [1, 2, 3], 'all tabs still reported');
  delete s.ptrs[2];
  delete s.ptrs[3];
  L = layoutMap(s.trail, s.ptrs);
  assert.equal(L.index[a].h, GEO.CARD_H + GEO.STRIP_H);
  L = layoutMap(s.trail, {});
  assert.equal(L.index[a].h, GEO.CARD_H, 'no tab, no strip');
});

test('top-down layout keeps tall (live) rows from overlapping the next level', () => {
  const s = session();
  s.nav(1, U('a'), { transitionType: 'typed' });
  s.nav(1, U('b'));
  s.ptrs[2] = byUrl(s.trail, U('a')).id; // a is open in two tabs: tall card
  const L = layoutMap(s.trail, s.ptrs, { orientation: 'tb' });
  const a = L.index[byUrl(s.trail, U('a')).id];
  const b = L.index[byUrl(s.trail, U('b')).id];
  assert.ok(b.y - b.h / 2 >= a.y + a.h / 2 + GEO_COMPACT.EDGE_GAP - 0.001, 'gap preserved below the tall card');
});
