// layout.js: pure layout for the browser map (no DOM, no chrome.* calls, unit-tested in Node).
//
// Each trail (tree of pages) becomes one cluster; clusters are stacked vertically.
//   orientation 'lr' (full page): depth runs left to right, siblings stack top to bottom.
//   orientation 'tb' (side panel): depth runs top to bottom, siblings sit side by side, so a
//                                  long browsing session scrolls like a normal list.
// Parents are centred on their children. Long straight chains collapse into one "N pages"
// pill. A page that is open in a tab grows a coloured strip per tab (up to two).

export const GEO = {
  CARD_W: 184,
  CARD_H: 28,
  STRIP_H: 16,
  RUN_W: 132,
  RUN_H: 22,
  XSTEP: 232, // lr: distance between depth levels
  ROW: 68, // lr: distance between sibling rows
  HEADER: 56,
  GAP: 40,
};

export const GEO_COMPACT = {
  CARD_W: 168,
  CARD_H: 28,
  STRIP_H: 16,
  RUN_W: 120,
  RUN_H: 22,
  COLW: 184, // tb: distance between sibling columns
  EDGE_GAP: 26, // tb: vertical space between depth levels
  HEADER: 46,
  GAP: 26,
};

export const MAX_STRIPS = 2;

function build(trail, rootId, live, highlight, expanded, compress, minRun) {
  const out = [];
  const stack = [{ id: rootId, parent: -1, depth: 0 }];
  while (stack.length) {
    const { id, parent, depth } = stack.pop();
    const n = trail.nodes[id];
    if (!n) continue;
    const idx = out.length;
    out.push({
      key: id,
      kind: 'page',
      id,
      lane: n.lane || 0,
      edge: parent < 0 ? null : n.edge || 'nav',
      depth,
      parent,
      kids: [],
    });
    if (parent >= 0) out[parent].kids.push(idx);

    // A straight run of plain pages between two visible pages collapses to one pill.
    if (compress && n.children.length === 1) {
      const run = [];
      let c = trail.nodes[n.children[0]];
      while (c && c.children.length === 1 && !live.has(c.id) && !highlight.has(c.id) && !expanded.has(c.id)) {
        run.push(c);
        c = trail.nodes[c.children[0]];
      }
      if (c && run.length >= minRun) {
        const rIdx = out.length;
        out.push({
          key: 'run:' + run[0].id,
          kind: 'run',
          ids: run.map((r) => r.id),
          lane: run[0].lane || 0,
          edge: run[0].edge || 'nav',
          depth: depth + 1,
          parent: idx,
          kids: [],
        });
        out[idx].kids.push(rIdx);
        stack.push({ id: c.id, parent: rIdx, depth: depth + 2 });
        continue;
      }
    }
    for (let i = n.children.length - 1; i >= 0; i--) stack.push({ id: n.children[i], parent: idx, depth: depth + 1 });
  }
  return out;
}

/**
 * roots:       ids of the trails to draw, in the order to stack them
 * expanded:    Set of node ids the user expanded out of a collapsed run (they stay visible)
 * highlight:   Set of node ids that must stay visible (search hits)
 * orientation: 'lr' or 'tb'
 * Returns { orientation, groups, items, edges, index, width, height }.
 * item.x is the left edge, item.y the vertical centre, item.w/h the size.
 */
export function layoutMap(
  trail,
  ptrs,
  { roots = trail.roots, expanded = new Set(), highlight = new Set(), compress = true, minRun = 3, orientation = 'lr', geo } = {},
) {
  const G = geo || (orientation === 'tb' ? GEO_COMPACT : GEO);
  const live = new Set(Object.values(ptrs));
  const tabsAt = {};
  for (const [tabId, nid] of Object.entries(ptrs)) (tabsAt[nid] ||= []).push(Number(tabId));

  const groups = [];
  const items = [];
  const edges = [];
  const index = {};
  let top = 0;
  let width = 0;

  for (const rootId of roots) {
    if (!trail.nodes[rootId]) continue;
    const local = build(trail, rootId, live, highlight, expanded, compress, minRun);

    // Rows: leaves get consecutive slots in preorder (= first to last), parents centre on their kids.
    let row = 0;
    for (const it of local) if (!it.kids.length) it.row = row++;
    for (let i = local.length - 1; i >= 0; i--) {
      const it = local[i];
      if (it.kids.length) it.row = (local[it.kids[0]].row + local[it.kids[it.kids.length - 1]].row) / 2;
    }

    // Sizes (a page open in tabs grows a strip per tab).
    for (const it of local) {
      const tabs = it.kind === 'page' ? tabsAt[it.id] || [] : [];
      it.tabs = tabs;
      it.w = it.kind === 'run' ? G.RUN_W : G.CARD_W;
      it.h = it.kind === 'run' ? G.RUN_H : G.CARD_H + Math.min(tabs.length, MAX_STRIPS) * G.STRIP_H;
    }

    const group = { rootId, top, height: 0, width: 0, rows: row, count: 0, liveCount: 0, last: 0 };

    if (orientation === 'tb') {
      const maxDepth = local.reduce((m, it) => Math.max(m, it.depth), 0);
      const depthH = new Array(maxDepth + 1).fill(0);
      for (const it of local) depthH[it.depth] = Math.max(depthH[it.depth], it.h);
      const depthTop = [];
      let acc = 0;
      for (let d = 0; d <= maxDepth; d++) {
        depthTop[d] = acc;
        acc += depthH[d] + G.EDGE_GAP;
      }
      for (const it of local) {
        it.x = it.row * G.COLW + (G.COLW - it.w) / 2;
        it.cy = top + G.HEADER + depthTop[it.depth] + depthH[it.depth] / 2;
      }
      group.height = G.HEADER + acc - G.EDGE_GAP;
      group.width = Math.max(row, 1) * G.COLW;
    } else {
      for (const it of local) {
        it.x = it.depth * G.XSTEP;
        it.cy = top + G.HEADER + it.row * G.ROW + G.ROW / 2;
        group.width = Math.max(group.width, it.x + it.w);
      }
      group.height = G.HEADER + row * G.ROW;
    }

    for (const it of local) {
      const out = {
        key: it.key,
        kind: it.kind,
        id: it.id,
        ids: it.ids,
        lane: it.lane,
        edge: it.edge,
        depth: it.depth,
        group: rootId,
        parentKey: it.parent >= 0 ? local[it.parent].key : null,
        x: it.x,
        y: it.cy,
        w: it.w,
        h: it.h,
        tabs: it.tabs,
      };
      items.push(out);
      index[out.key] = out;
      if (it.kind === 'run') group.count += it.ids.length;
      else {
        group.count += 1;
        group.liveCount += it.tabs.length;
        group.last = Math.max(group.last, trail.nodes[it.id].last);
      }
      if (out.parentKey) edges.push({ from: out.parentKey, to: out.key, kind: out.edge, lane: out.lane });
    }
    groups.push(group);
    width = Math.max(width, group.width);
    top += group.height + G.GAP;
  }

  return { orientation, groups, items, edges, index, width, height: Math.max(0, top - G.GAP) };
}
