// Optional content script (only registered if the user turns on "Remember scroll position").
// It reports how far down the page you are, and restores that position when you resume a
// saved branch. It never reads page text.
(() => {
  if (window.__trailheadScroll) return;
  window.__trailheadScroll = true;

  const send = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
      return p;
    } catch {
      return null; // extension was reloaded; this page's script is orphaned
    }
  };

  let timer = null;
  const report = () => {
    timer = null;
    send({ type: 'scroll', url: location.href, y: Math.round(window.scrollY) });
  };
  window.addEventListener(
    'scroll',
    () => {
      clearTimeout(timer);
      timer = setTimeout(report, 400);
    },
    { passive: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer);
      report();
    }
  });

  function restore(y) {
    let tries = 0;
    const stop = () => clearInterval(iv);
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
      window.addEventListener(ev, stop, { once: true, passive: true });
    }
    const iv = setInterval(() => {
      tries++;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max >= y - 2 || tries > 20) {
        window.scrollTo(0, y);
        if (Math.abs(window.scrollY - y) < 4 || tries > 20) stop();
      }
    }, 150);
  }

  const hello = send({ type: 'hello', url: location.href });
  if (hello && hello.then) {
    hello.then((r) => {
      if (r && r.restoreY > 0) restore(r.restoreY);
    }).catch(() => {});
  }
})();
