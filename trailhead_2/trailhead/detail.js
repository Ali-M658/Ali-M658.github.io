// detail.js: the "selected page" card, shared by the side panel and the full-page map.
import { VIA, ago, clip, el, pageTitle } from './util.js';

/**
 * Fills `container` with details and actions for one graph item.
 * ctx = { trail, item, tabs: Map, actions }
 * actions = { jump(tabId), open(nodeId), pin(nodeId, bool), note(nodeId, text), forget(nodeId), expand(ids) }
 */
export function renderDetail(container, { trail, item, tabs, actions }) {
  container.replaceChildren();
  if (!item) return;
  const info = el('div', { class: 'info' });
  const btns = el('div', { class: 'btns' });

  if (item.kind === 'run') {
    info.append(
      el('div', { class: 'd-title', text: `${item.ids.length} pages in a row` }),
      el('div', { class: 'd-meta', text: 'Plain steps from one page to the next, folded to keep the graph readable.' }),
    );
    const expand = el('button', { class: 'primary', text: 'Expand' });
    expand.addEventListener('click', () => actions.expand(item.ids));
    btns.append(expand);
    container.append(info, btns);
    return;
  }

  const n = trail.nodes[item.id];
  if (!n) return;
  const parent = n.parent ? trail.nodes[n.parent] : null;
  const meta = [`Visited ${ago(n.last)}`, `${n.visits}×`];
  if (!parent) meta.push('start of this trail');
  else if (n.edge === 'newtab') meta.push(`opened in a new tab from “${clip(pageTitle(parent), 36)}”`);
  else meta.push(`reached by ${VIA[n.via] || n.via}`);
  if (item.tabs.length) {
    const names = item.tabs.map((id) => {
      const t = tabs.get(id);
      return clip(t ? t.title || 'Tab' : 'Tab ' + id, 28);
    });
    meta.push('open in: ' + names.join(', '));
  }
  info.append(
    el('div', { class: 'd-title', text: pageTitle(n) }),
    el('div', { class: 'd-url', text: n.url }),
    el('div', { class: 'd-meta', text: meta.join(' · ') }),
  );

  const note = el('input', { class: 'd-note', type: 'text', placeholder: 'Add a note to this page', maxLength: 280, value: n.note || '' });
  note.setAttribute('aria-label', 'Note');
  const save = () => {
    if ((n.note || '') !== note.value.trim()) actions.note(n.id, note.value);
  };
  note.addEventListener('change', save);
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') note.blur();
  });
  info.append(note);

  if (item.tabs.length) {
    const jump = el('button', { class: 'primary', text: 'Go to tab' });
    jump.addEventListener('click', () => actions.jump(item.tabs[0]));
    btns.append(jump);
  }
  const open = el('button', { class: item.tabs.length ? '' : 'primary', text: 'Open in new tab' });
  open.addEventListener('click', () => actions.open(n.id));
  const pin = el('button', { text: n.pin ? '★ Pinned' : '☆ Pin', title: 'Pinned pages are kept and listed under Saved' });
  pin.addEventListener('click', () => actions.pin(n.id, !n.pin));
  const del = el('button', { class: 'danger', text: 'Forget' , title: 'Forget this page and everything after it' });
  del.addEventListener('click', () => actions.forget(n.id));
  btns.append(open, pin, del);

  container.append(info, btns);
}
