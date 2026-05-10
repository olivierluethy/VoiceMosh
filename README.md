# VoiceMosh

A Chrome extension that locates and highlights elements on any webpage from a text description. Type `Filter`, `Privacy Policy`, or any word that appears on the page — VoiceMosh finds every visible element containing it, outlines them in red, scrolls the first one into view, and lets you cycle through the rest.

This is the **MVP** — text-only input, DOM-based locator. Voice input and a vision-based fallback for elements with no DOM-readable label are planned for later iterations.

## Installation

1. Clone or download this repo.
2. Open Chrome and navigate to `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `voicemosh/` folder.
5. Pin the VoiceMosh action so it's one click away.

The extension also works in Edge, Brave, and other Chromium browsers using the same flow.

## Usage

- Click the VoiceMosh toolbar icon (or press **Ctrl+Shift+F** / **⌘+Shift+F**) to open the popup.
- Type a description and press **Enter** — anything that appears on the page is fair game: a single word, a phrase, a label, a heading. Examples: `Subscribe`, `Privacy Policy`, `Configure your settings`, `Tomate`, `Sprachen`.
- Every visible element containing that text is highlighted in red and the first one is scrolled into view.
- **↑/↓** (or the prev/next buttons) cycle through matches in document order. The active match pulses; the others dim to orange.
- Press **Esc**, click **Clear**, or close the popup to remove the highlights.
- The floating in-page panel can be toggled with **Ctrl+Shift+Y** / **⌘+Shift+Y** if you prefer keeping the search box on the page itself.

Highlights use a non-blocking overlay (`pointer-events: none`) so the underlying page remains fully clickable.

## Architecture

```
voicemosh/
├── manifest.json     Manifest V3 config — popup, content script, commands.
├── background.js     Service worker. Forwards keyboard commands and ensures
│                     the content script is alive before the popup talks to it.
├── content.js        DOM locator + highlight overlay + floating panel.
│                     Three decoupled modules: Matcher (search), Highlighter
│                     (overlay), Panel (in-page UI).
├── popup.html / .css / .js
│                     The popup UI. Sends voicemosh:search / voicemosh:next /
│                     voicemosh:prev / voicemosh:clear messages to the active tab.
└── icons/            Toolbar / store icons.
```

### How the locator works

VoiceMosh runs a **two-phase** search. The phases are tried in order, and the second only fires if the first found nothing — there is no per-word, per-language, or per-site logic anywhere in the pipeline. Any string runs through the same code.

#### Phase 1 — literal text pass (primary)

For every visible element on the page, VoiceMosh extracts the **full subtree text** — recursively concatenating every text node in the element's descendants (and open shadow roots), normalized to lower case with whitespace collapsed. If the normalized subtree text contains the normalized query as a substring, the element is a candidate.

The candidate set is then reduced to the **deepest descendants only** — an element is dropped if any of its own descendants is also a match. This guarantees the highlight lands on the leaf element actually carrying the matching string, not on a wrapping `<div>` or `<body>`.

The remaining matches are returned in **document order** (top-to-bottom, left-to-right) so cycling next/prev moves predictably down the page. **Every** occurrence is returned — there is no top-N pruning. If "Sprachen" appears in the nav, in the body, and in the footer, all three are highlighted and cycleable.

This pass handles every text-containing scenario robustly:

- Deeply nested elements: `<div><p><span>foo</span></p></div>` — finds the span.
- Text fragmented across inline elements: `<span>foo<em>bar</em>baz</span>` — substring search on the joined `foobarbaz`.
- Words embedded in longer sentences with punctuation: `Sport (Fallschirmspringen) ist toll` — substring match.
- Multiple occurrences: every visible occurrence on the page is returned.

#### Phase 2 — semantic fallback (only if Phase 1 returned nothing)

When the literal text isn't on the page — typical for icon-only buttons whose only handle is `aria-label="Settings"` — VoiceMosh scores elements against:

| Signal | Weight |
| --- | --- |
| `aria-label` / `aria-labelledby` exact match | 100 |
| `aria-label` substring or all-tokens match | 60 |
| `placeholder`, `title`, `alt` substring | 45 |
| Tag/role matches a type hint in the query (`button` → `<button>`, `[role="button"]`) | 25 |
| `name` / `id` attribute match | 30 |
| `data-*` attribute match | 18 |
| Nearby `<label>` text (associated `<label for>`, parent `<label>`, prev sibling) | 35 |
| Fuzzy token match (Levenshtein ≤ 2) for typos | 20 |
| Tie-breakers: interactive (+15), visible (+5) — only applied if a real signal already fired |

Results are sorted by score and de-duplicated parent-vs-child. If one match dominates, only that one is shown; if several near-tie, up to 10 are shown so the user can cycle through similarly-good candidates.

### Visibility

The locator only considers elements that pass a strict visibility check:

- At least one client rect with positive width *and* height (uses `getClientRects()`, robust for inline elements that wrap across lines).
- Not `display: none`, `visibility: hidden`/`collapse`, or `opacity < 0.05`.
- No ancestor that fails the same check.
- Not `aria-hidden="true"` (also applied to descendants when extracting subtree text).

`<script>`, `<style>`, `<noscript>`, `<template>`, `<meta>`, `<link>`, `<head>`, `<title>` are skipped entirely.

### Cycling logic

- **Phase 1 (text)**: every match returned, capped at 50 to keep the highlight layer manageable on pages where the query is very common (e.g. a single letter). Cycle order is document order.
- **Phase 2 (semantic)**: if the top score dominates, return only the top. If several are within 70% of the top score, return up to 10 and let the user cycle.

## Testing suggestions

Try the extension on:

- **Gmail / Notion / LinkedIn** — heavy SPAs with lots of dynamic, similar-looking elements. Good stress test.
- **A form-heavy page** (settings, checkout) — verifies `<label>` association and `placeholder`/`name`/`id` signals.
- **Icon-only buttons** (toolbars, sidebars) — exercises the Phase 2 `aria-label` fallback. Try queries like `search` or `settings` against pages where those are unlabeled icons.
- **Long articles** — verify that searching a word that appears 5–10 times on the page finds and cycles through every occurrence.
- **A simple static site** — sanity check.

The repo contains a 17-case headless test suite (`/tmp/vm-test/test.js`, requires `jsdom`) covering deeply-nested text, fragmented text, punctuation-bordered text, multi-occurrence cycling, semantic fallback, and "no match" behavior. Run with `node /tmp/vm-test/test.js`.

## Known limitations

- **iframes**: only the top-level document is searched. Cross-origin iframes can't be touched without extra permissions; same-origin iframes could be supported by recursing through `contentDocument` — left as a follow-up.
- **Closed shadow roots** are invisible to the content script (browser limitation). Open shadow roots are traversed.
- **Canvas / WebGL** content (e.g. Figma, Google Sheets canvas surfaces) has no DOM, so the locator can't see it.
- **Very dynamic pages**: the search reflects the DOM at the moment Enter is pressed. Re-run the search after the page rerenders.
- **Icon-only elements with no aria/title/placeholder/nearby label** are unreachable in this MVP — vision-based fallback is on the roadmap.

## Roadmap

- [ ] Voice input via the Web Speech API (push-to-talk).
- [ ] Vision-based fallback for elements with no DOM-readable label: rasterize the viewport and use a multimodal LLM to point at the target element.
- [ ] AI-guided navigation: an external agent calls VoiceMosh ("highlight the button containing 'Settings'") and the user instantly sees where to click.
- [ ] Multi-frame support (same-origin iframes via `contentDocument`).
- [ ] Per-site preferences via `chrome.storage`.

## License

MIT.
