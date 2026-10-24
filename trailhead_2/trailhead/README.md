# Trailhead

**Your back button deletes the pages you leave behind. Trailhead keeps every branch.**

Go back two pages, click a new link, and normal history throws away the path you were on. Trailhead keeps a **tree**
instead: every page you backed out of stays one click away, and all your open tabs are drawn as one map.
Everything stays on your device.

## The side panel (main surface)

Click the toolbar icon to open the side panel. It stays open beside the page you are on.

- **Trail** shows the current tab's tree as a list or as a **Graph** (top-to-bottom, follows the page you are on).
  The graph can show *This trail* or the *Whole browser*.
- **Left behind**: pages you backed out of are shelved at the top. **Restore** opens one in a new tab; **Alt+Shift+B**
  restores the most recent without opening anything.
- **Pins and notes**: star (☆) a page or add a note (✎). Pinned, noted and parked pages are never pruned.
- **Park trail**: closes the trail's open tabs and remembers them. **Saved** lists parked trails; *Reopen* brings the tabs back.
- **All** lists every trail; the search box finds any page.
- **⤢** opens the full-page map; **⚙** has settings (including what the toolbar icon opens).

## The full-page map

Press **Alt+Shift+M** (or the ⤢ button) for the whole browser at once.

- **One cluster per trail.** A tab opened blank, or by typing an address, starts its own trail.
- **Open in new tab extends a branch.** Drawn as a dashed edge in a new colour, hanging off the page you clicked.
- **Colour = tab.** Open tabs are marked with a coloured strip on their page; the route to each is solid, everything
  else is dimmed but one click away.
- **Click a page** for details: *Go to tab*, *Open in new tab*, pin, note, *Forget*.
- Long straight chains fold into a "N pages" pill. Filter by open tabs / 24 hours / all; search keeps hits visible.
- Drag or scroll to pan, Ctrl/&#8984;+scroll or +/- to zoom, `0` or *Fit* to see everything.

If your browser's side panel misbehaves, set the toolbar icon to open the map instead (Settings).

## Install (unpacked)

1. Unzip the folder somewhere permanent.
2. Open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, click **Load unpacked**, pick the
   `trailhead` folder.
3. Browse a few pages, go back, click something new, then click the toolbar icon.

Requires Chrome 116 or newer (or a recent Chromium browser). After you reload the extension, each open tab rejoins its
trail the next time you navigate in it. Trails recorded by v0.1.0 are kept, but their pages show in grey and links that
were opened in new tabs appear as normal edges.

## What it records

Only page URL, title, time, which tab, and (optionally) scroll position, in `chrome.storage.local`. No page content,
nothing leaves your machine. Incognito is never recorded. You can pause recording, exclude sites, and set retention
(default 30 days) in the side panel settings. Scroll memory is off by default; turning it on asks for access to all
sites so a small script can note scroll depth.

## Known limits

- **Resuming reloads the page.** Chrome offers no way to put a branch back into a tab's real back/forward stack, so
  resume opens the saved URL in a new tab (and restores scroll if enabled). Unsent form text, video position and
  in-page state are not restored.
- **Back detection is URL-based.** Chrome reports that back/forward happened but not which entry, so Trailhead matches
  the landing URL against the tree (nearest ancestor for back, newest branch for forward). Odd cases such as the same
  URL appearing twice on one path can pick the wrong one.
- **Hash-only changes are ignored.** Sites that route purely with `#fragments` appear as a single page.
- **Short redirects are folded** into the page that issued them (client redirects within 1.5 s).
- **The map is a snapshot of recorded history, not live page state.** It only knows about pages visited since install.
- Very large maps (thousands of pages) get crowded; use the filter, search and chain compression.
- Restored or reopened tabs reattach to a known page by URL, not by exact history entry.

## Development

```
npm test      # node --test: tree logic, layout, and the service worker against a fake chrome.* API
```

- `tree.js`: pure tree logic (no Chrome APIs), shared by everything
- `layout.js`: pure layout for the map (clusters, rows, chain folding)
- `background.js`: service worker; serialises all state changes through one queue
- `map/`: full-page SVG map
- `sidepanel/`: list view, search, settings
- `content.js`: optional scroll tracker, registered only when the user enables it
