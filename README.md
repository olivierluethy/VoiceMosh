# VoiceMesh

A Chrome extension that highlights elements on any webpage based on a text description. Type "Filter button", "Privacy Policy link", or "subscribe" — VoiceMesh searches the DOM, ranks the best matches, and outlines them so you can stop hunting and start clicking.

This is the **MVP** — text-only input, DOM-based matching. Voice input and vision-based matching are planned for later iterations.

## Installation

1. Clone or download this repo.
2. Open Chrome and navigate to `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `voicemesh/` folder.
5. Pin the VoiceMesh action so it's one click away.

The extension also works in Edge, Brave, and other Chromium browsers using the same flow.

## Usage

- Click the VoiceMesh toolbar icon (or press **Ctrl+Shift+F** / **⌘+Shift+F**) to open the popup.
- Type a description (e.g. `Filter`, `Subscribe button`, `the link that says Privacy Policy`, `the dropdown next to the search bar`) and press **Enter**.
- The best match is outlined in red and scrolled into view. If several elements match similarly well, the top 3 are shown — use **↑/↓** (or the prev/next buttons) to cycle through them.
- Press **Esc**, click **Clear**, or close the popup to remove the highlights.
- The floating in-page panel can be toggled with **Ctrl+Shift+Y** / **⌘+Shift+Y** if you prefer keeping the search box on the page itself.

Highlights use a non-blocking overlay (`pointer-events: none`) so the underlying page remains fully clickable.

## Architecture

```
voicemesh/
├── manifest.json     Manifest V3 config — popup, content script, commands.
├── background.js     Service worker. Forwards keyboard commands and ensures
│                     the content script is alive before the popup talks to it.
├── content.js        DOM matching algorithm + highlight overlay + floating panel.
│                     Two decoupled modules: `Matcher` (scoring) and `Highlighter`
│                     (visual overlay). The scoring weights live in a single
│                     object near the top of `Matcher` for easy tuning.
├── popup.html / .css / .js
│                     The popup UI. Sends `voicemesh:search` /
│                     `voicemesh:next` / `voicemesh:prev` / `voicemesh:clear`
│                     messages to the active tab.
└── icons/            Toolbar / store icons.
```

### Matching algorithm

For each visible element on the page, `Matcher` computes a confidence score from several signals (in rough order of weight):

| Signal                                                | Weight     |
| ----------------------------------------------------- | ---------- |
| Exact visible-text match                              | very high  |
| Full query as a substring of visible text             | high       |
| `aria-label` / `aria-labelledby` exact match          | high       |
| All query tokens appear in visible text               | medium     |
| `aria-label` substring                                | medium     |
| `title` / `placeholder` / `alt` substring             | medium     |
| Tag/role matches a type hint in the query (e.g. "button" → `<button>`, `[role="button"]`) | medium |
| `name` / `id` attribute match                         | medium-low |
| `data-*` attribute match                              | low        |
| Nearby `<label>` text (for icon-only buttons / unlabeled inputs) | medium-low |
| Element is interactive (`<button>`, `<a>`, `[role="button"]`, `cursor:pointer`, `[onclick]`) | small boost |
| Fuzzy token match (Levenshtein ≤ 2) for typos         | small boost |
| Penalty: massive containers (>60% of viewport)        | negative   |
| Penalty: matched text is enormous (low precision)     | negative   |

After scoring, results are de-duplicated: when a parent and a more specific child both score similarly, the inner element wins.

The candidate walker traverses the document **and open shadow roots**, skipping `script`, `style`, `noscript`, and elements with no bounding box. A 500 ms / 8000-element budget keeps things responsive on huge pages.

### Cycling logic

If the top score is significantly higher than the rest, only that match is highlighted. If multiple elements score within 70% of the top result, up to 3 are shown and the user cycles through them — the active one pulses in red, the others dim to orange.

## Testing suggestions

Try the extension on:

- **Gmail / Notion / LinkedIn** — heavy SPAs with lots of dynamic, similar-looking elements. Good stress test for the scoring and the dedupe logic.
- **A form-heavy page** (settings, checkout) — verifies the `<label>` association and `placeholder`/`name`/`id` signals.
- **Icon-only buttons** (toolbars, sidebars) — exercises the `aria-label` / nearby-text fallback. Try queries like "search" against pages whose search button is just a magnifier icon.
- **A simple static site** — sanity check that nothing is broken on plain HTML.

## Known limitations

- **iframes**: only the top-level document is searched. Cross-origin iframes can't be touched without extra permissions; same-origin iframes could be supported by recursing through `contentDocument` — left as a follow-up.
- **Closed shadow roots** are invisible to the content script (browser limitation). Open shadow roots are traversed.
- **Canvas / WebGL** content (e.g. Figma, Google Sheets canvas surfaces) has no DOM, so matching can't see it.
- **Very dynamic pages**: the search reflects the DOM at the moment Enter is pressed. If the page rerenders, run the search again.
- **Icon-only elements with no aria/title/nearby label** are unreachable in this MVP — vision-based fallback is on the roadmap.

## Roadmap

- [ ] Voice input via the Web Speech API (push-to-talk).
- [ ] Vision-based fallback: when DOM matching is uncertain, rasterize the viewport and use a multimodal LLM to point at the target element.
- [ ] Multi-frame support (same-origin iframes, recursing into `contentDocument`).
- [ ] Per-site memory ("on Gmail, 'archive' usually means *this* button") via `chrome.storage`.
- [ ] Optional natural-language pre-processor that rewrites "the thing that lets me filter" → token-friendly queries.

## License

MIT — do whatever you want, just don't blame me when an SPA outsmarts the matcher.
