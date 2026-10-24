// Small display helpers shared by the side panel, the full-page map and the graph view.

export function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function pageTitle(n) {
  if (n.title) return n.title;
  try {
    const u = new URL(n.url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return n.url;
  }
}

export function clip(str, max) {
  str = String(str);
  return str.length > max ? str.slice(0, Math.max(1, max - 1)) + '…' : str;
}

/** Short relative time: "now", "5m", "3h", "2d", "1mo". */
export function agoShort(t, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  const m = s / 60;
  if (m < 60) return Math.floor(m) + 'm';
  const h = m / 60;
  if (h < 24) return Math.floor(h) + 'h';
  const d = h / 24;
  if (d < 30) return Math.floor(d) + 'd';
  return Math.floor(d / 30) + 'mo';
}

/** Longer form: "just now", "5 min ago", "3 h ago". */
export function ago(t, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.floor(m) + ' min ago';
  const h = m / 60;
  if (h < 24) return Math.floor(h) + ' h ago';
  const d = h / 24;
  if (d < 30) return Math.floor(d) + ' d ago';
  return Math.floor(d / 30) + ' mo ago';
}

export function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}

export const VIA = {
  typed: 'typed address',
  generated: 'search',
  auto_bookmark: 'bookmark',
  form_submit: 'form',
  reload: 'reload',
  link: 'link',
};

/** Tiny DOM builder. Text always goes in via textContent, never innerHTML. */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('data-') || k.startsWith('aria-')) e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}
