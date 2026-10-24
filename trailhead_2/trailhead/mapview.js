// mapview.js: the graph view, used by both the side panel (orientation 'tb') and the
// full-page map (orientation 'lr').
//
//  - each trail is a cluster; a blank/typed tab starts its own cluster
//  - a link opened in a new tab hangs off the page it came from (dashed edge, new colour)
//  - pages open in tabs carry a coloured strip with the tab's title; the route from the start
//    of the trail to each open tab is solid, everything else is dimmed
import { pathTo } from './tree.js';
import { layoutMap, GEO, GEO_COMPACT, MAX_STRIPS } from './layout.js';
import { pageTitle, host, clip, ago, faviconUrl } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

export const laneClass = (lane) => (lane > 0 ? 'lane-' + ((lane - 1) % 8) : 'lane-g');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Path for a rectangle with only the bottom corners rounded. */
function bottomRounded(w, y0, y1, r) {
  return `M0 ${y0}H${w}V${y1 - r}Q${w} ${y1} ${w - r} ${y1}H${r}Q0 ${y1} 0 ${y1 - r}Z`;
}

/**
 * svg:  the <svg> element to draw into (give it a size with CSS)
 * opts: { orientation: 'lr'|'tb', onSelect(key|null), onTab(tabId), onOpen(key), onFirstLayout(view) }
 * Returns a controller: update(data), render(), select(key), fit(), focusKey(key), zoomBy(f),
 *   resetView(), item(key), plus read-only layout / selected.
 * data: { trail, ptrs, lanes, tabs: Map, roots, hits: Set, expanded: Set, compress, now? }
 */
export function createMapView(svg, opts = {}) {
  const cfg = {
    orientation: 'lr',
    onSelect: () => {},
    onTab: () => {},
    onOpen: () => {},
    onFirstLayout: null,
    ...opts,
  };
  const geo = cfg.orientation === 'tb' ? GEO_COMPACT : GEO;
  const vp = s('g');
  svg.replaceChildren(vp);

  let data = { trail: null, ptrs: {}, lanes: {}, tabs: new Map(), roots: [], hits: new Set(), expanded: new Set(), compress: true };
  let layout = null;
  let selected = null;
  let positioned = false;
  const view = { k: 1, tx: 24, ty: 24 };

  // ---- view transform ----------------------------------------------------------------

  function applyView() {
    vp.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
    svg.classList.toggle('lod', view.k < 0.5);
  }

  function size() {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 400, h: r.height || 600 };
  }

  function zoomAt(factor, cx, cy) {
    const nk = clamp(view.k * factor, 0.1, 2.5);
    const r = nk / view.k;
    view.tx = cx - (cx - view.tx) * r;
    view.ty = cy - (cy - view.ty) * r;
    view.k = nk;
    applyView();
  }

  function fit() {
    if (!layout || !layout.items.length) {
      Object.assign(view, { k: 1, tx: 24, ty: 24 });
    } else {
      const { w, h } = size();
      const pad = 20;
      const kw = (w - pad * 2) / (layout.width + 8);
      const kh = (h - pad * 2) / (layout.height + 8);
      // A narrow, tall panel fits to width and scrolls; the full page fits both ways.
      const k = clamp(cfg.orientation === 'tb' ? Math.min(kw, 1) : Math.min(kw, kh, 1), 0.1, 1);
      Object.assign(view, { k, tx: pad, ty: pad });
    }
    applyView();
  }

  function focusKey(key, k = null) {
    const it = layout && layout.index[key];
    if (!it) return;
    const { w, h } = size();
    if (k != null) view.k = k;
    view.tx = w / 2 - (it.x + it.w / 2) * view.k;
    view.ty = h / 2 - it.y * view.k;
    applyView();
  }

  // ---- drawing -----------------------------------------------------------------------

  function windowLabels() {
    const ids = [...new Set([...data.tabs.values()].map((t) => t.windowId))].sort((a, b) => a - b);
    return ids.length > 1 ? new Map(ids.map((id, i) => [id, i + 1])) : null;
  }

  function tabLabel(tabId, win) {
    const t = data.tabs.get(tabId);
    const title = t ? t.title || host(t.url || '') || 'Tab' : 'Tab ' + tabId;
    const w = win && t ? `W${win.get(t.windowId)} · ` : '';
    return w + (t && t.discarded ? '⏾ ' : '') + title;
  }

  function render() {
    const { trail, ptrs } = data;
    vp.replaceChildren();
    if (!trail) return;
    const L = (layout = layoutMap(trail, ptrs, {
      roots: data.roots,
      expanded: data.expanded,
      highlight: data.hits,
      compress: data.compress,
      orientation: cfg.orientation,
    }));
    if (selected && !L.index[selected]) selected = null;

    // Which pages lie on the route from the start to some open tab?
    const liveIds = new Set();
    for (const id of Object.values(ptrs)) for (const n of pathTo(trail, id)) liveIds.add(n.id);
    const onLive = (it) => (it.kind === 'run' ? it.ids.some((id) => liveIds.has(id)) : liveIds.has(it.id));

    const selPath = new Set();
    const sel = selected && L.index[selected];
    if (sel) for (const n of pathTo(trail, sel.kind === 'run' ? sel.ids[0] : sel.id)) selPath.add(n.id);
    const inSel = (it) => (it.kind === 'run' ? it.ids.some((id) => selPath.has(id)) : selPath.has(it.id));

    const win = windowLabels();
    const tb = cfg.orientation === 'tb';

    // 1. cluster headings
    for (const g of L.groups) {
      const root = trail.nodes[g.rootId];
      const sub = [`${g.count} page${g.count === 1 ? '' : 's'}`];
      if (g.liveCount) sub.push(`${g.liveCount} open tab${g.liveCount === 1 ? '' : 's'}`);
      if (root.parked) sub.push('parked');
      sub.push(ago(g.last, data.now));
      vp.append(
        s(
          'g',
          { class: 'ghead' + (g.liveCount ? ' hasLive' : ''), transform: `translate(0 ${g.top})` },
          s('text', { x: 0, y: 14, text: clip(pageTitle(root), tb ? 34 : 48) }),
          s('text', { class: 'sub', x: 0, y: 29, text: sub.join(' · ') }),
          s('line', { x1: 0, x2: Math.max(g.width, 200), y1: 36, y2: 36 }),
        ),
      );
    }

    // 2. edges
    for (const e of L.edges) {
      const a = L.index[e.from];
      const b = L.index[e.to];
      let d;
      let mark;
      if (tb) {
        const x1 = a.x + a.w / 2;
        const y1 = a.y + a.h / 2;
        const x2 = b.x + b.w / 2;
        const y2 = b.y - b.h / 2;
        const ym = (y1 + y2) / 2;
        d = `M${x1} ${y1} C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
        mark = [x2 + 6, y2 - 6];
      } else {
        const x1 = a.x + a.w;
        const x2 = b.x;
        const xm = (x1 + x2) / 2;
        d = `M${x1} ${a.y} C${xm} ${a.y} ${xm} ${b.y} ${x2} ${b.y}`;
        mark = [x2 - 17, b.y - 6];
      }
      const cls = ['edge', laneClass(e.lane), e.kind === 'newtab' ? 'newtab' : '', onLive(b) ? '' : 'dim', inSel(b) ? 'path' : '']
        .filter(Boolean)
        .join(' ');
      vp.append(s('path', { class: cls, d }));
      if (e.kind === 'newtab') vp.append(s('text', { class: `edge-mark ${laneClass(e.lane)}`, x: mark[0], y: mark[1], text: '↗' }));
    }

    // 3. pages
    const titleChars = Math.floor((geo.CARD_W - 44) / 6.2);
    for (const it of L.items) {
      const live = it.tabs.length > 0;
      const n = it.kind === 'page' ? trail.nodes[it.id] : null;
      const cls = [
        'node',
        it.kind === 'run' ? 'run' : '',
        laneClass(it.lane),
        live ? 'live' : '',
        onLive(it) ? '' : 'dim',
        selected === it.key ? 'sel' : '',
        n && data.hits.has(it.id) ? 'hit' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const g = s('g', { class: cls, 'data-key': it.key, transform: `translate(${it.x} ${it.y - it.h / 2})`, tabindex: 0, role: 'button' });
      g.append(s('rect', { class: 'card', width: it.w, height: it.h, rx: 7 }));

      if (it.kind === 'run') {
        g.setAttribute('aria-label', `${it.ids.length} pages in a row. Press Enter to select.`);
        g.append(s('text', { x: it.w / 2, y: 15, 'text-anchor': 'middle', text: `⋯ ${it.ids.length} pages` }));
      } else {
        g.setAttribute('aria-label', pageTitle(n));
        g.append(s('rect', { class: 'stripe', width: 5, height: geo.CARD_H, rx: 2 }));
        const img = s('image', { x: 12, y: 7, width: 14, height: 14 });
        try {
          img.setAttribute('href', faviconUrl(n.url));
        } catch {
          /* no chrome.runtime in tests */
        }
        g.append(img);
        const badge = (n.pin ? 1 : 0) + (n.note ? 1 : 0);
        g.append(s('text', { x: 32, y: 18, text: clip(pageTitle(n), titleChars - badge * 2) }));
        if (n.note) g.append(s('text', { class: 'note-mark', x: it.w - 14 - (n.pin ? 14 : 0), y: 18, text: '✎' }));
        if (n.pin) g.append(s('text', { class: 'pin-mark', x: it.w - 14, y: 18, text: '★' }));
        g.append(s('title', { text: `${pageTitle(n)}\n${n.url}${n.note ? '\n✎ ' + n.note : ''}` }));
      }
      vp.append(g);

      // open-tab strips live inside the card, one per tab
      it.tabs.slice(0, MAX_STRIPS).forEach((tabId, i) => {
        const t = data.tabs.get(tabId);
        let label = clip(tabLabel(tabId, win), Math.floor((it.w - 16) / 6));
        if (i === MAX_STRIPS - 1 && it.tabs.length > MAX_STRIPS) label = clip(label, 20) + ` +${it.tabs.length - MAX_STRIPS}`;
        const y0 = geo.CARD_H + i * geo.STRIP_H;
        const y1 = y0 + geo.STRIP_H;
        const last = i === Math.min(it.tabs.length, MAX_STRIPS) - 1;
        const strip = s(
          'g',
          {
            class: `strip ${laneClass(data.lanes[tabId] || 0)}` + (t && t.discarded ? ' sleeping' : ''),
            'data-tab': tabId,
            transform: `translate(${it.x} ${it.y - it.h / 2})`,
            role: 'button',
            tabindex: 0,
            'aria-label': `Go to tab ${label}`,
          },
          last ? s('path', { d: bottomRounded(it.w, y0, y1, 7) }) : s('rect', { x: 0, y: y0, width: it.w, height: geo.STRIP_H }),
          s('text', { x: 9, y: y0 + 11.5, text: label }),
          s('title', { text: 'Switch to this tab' }),
        );
        vp.append(strip);
      });
    }

    if (!positioned && L.items.length) {
      positioned = true;
      if (cfg.onFirstLayout) cfg.onFirstLayout(api);
      else fit();
    }
    applyView();
  }

  // ---- interaction -------------------------------------------------------------------

  function select(key) {
    selected = key && layout && layout.index[key] ? key : null;
    render();
    cfg.onSelect(selected);
  }

  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else {
        view.tx -= e.deltaX;
        view.ty -= e.deltaY;
        applyView();
      }
    },
    { passive: false },
  );

  let drag = null;
  let justDragged = false;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false, id: e.pointerId };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      svg.setPointerCapture(drag.id);
      svg.classList.add('dragging');
    }
    if (drag.moved) {
      view.tx = drag.tx + dx;
      view.ty = drag.ty + dy;
      applyView();
    }
  });
  const endDrag = () => {
    if (drag && drag.moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
    }
    drag = null;
    svg.classList.remove('dragging');
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  svg.addEventListener('click', (e) => {
    if (justDragged) return;
    const strip = e.target.closest('[data-tab]');
    if (strip) return cfg.onTab(Number(strip.dataset.tab));
    const node = e.target.closest('[data-key]');
    select(node ? node.dataset.key : null);
  });
  svg.addEventListener('dblclick', (e) => {
    const node = e.target.closest('[data-key]');
    if (node) cfg.onOpen(node.dataset.key);
    else fit();
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const strip = e.target.closest('[data-tab]');
    const node = e.target.closest('[data-key]');
    if (strip) cfg.onTab(Number(strip.dataset.tab));
    else if (node) select(node.dataset.key);
    else return;
    e.preventDefault();
  });

  const api = {
    update(d) {
      data = { ...data, ...d };
      render();
    },
    render,
    select,
    fit,
    focusKey,
    zoomBy(f) {
      const { w, h } = size();
      zoomAt(f, w / 2, h / 2);
    },
    resetView() {
      positioned = false;
    },
    item: (key) => (layout ? layout.index[key] : undefined),
    get layout() {
      return layout;
    },
    get selected() {
      return selected;
    },
    get scale() {
      return view.k;
    },
  };
  return api;
}
