// VoiceMosh — content script
// =============================
// Responsibilities:
//   1. Listen for messages from the popup / background (search, cycle, clear, toggle-panel).
//   2. Walk the DOM (including open shadow roots) and score each candidate element
//      against the user's query.
//   3. Highlight the best match (or top-N) with a non-blocking overlay and scroll
//      it into view. Provide cycle / clear UX.
//
// The matching code lives in the `Matcher` IIFE; the highlight code lives in `Highlighter`.
// Keep them decoupled so the scoring weights are easy to tune independently.

(() => {
  if (window.__voicemoshInstalled) return;
  window.__voicemoshInstalled = true;

  // -----------------------------------------------------------------------------
  //  Matcher — DOM-aware text and semantic locator
  //
  //  Two-phase search, in order:
  //
  //    1. LITERAL TEXT PHASE (primary).
  //       Walk every visible element. Extract its full subtree text content
  //       (including text fragmented across nested inline elements). If the
  //       normalized subtree text contains the normalized query, this element
  //       is a candidate. Then reduce to the deepest descendants — the leaf
  //       elements that actually carry the matching string — so we don't
  //       redundantly highlight every ancestor wrapper.
  //       Returns ALL such matches, in document order. No top-N pruning,
  //       no scoring biases. The user expects to see every occurrence.
  //
  //    2. SEMANTIC PHASE (fallback, only if phase 1 returned nothing).
  //       Score elements against accessibility name (aria-label, title, alt),
  //       attributes (placeholder, name, id, data-*), type hints in the query
  //       (e.g. "button" → <button>), nearby <label> text, and tag/role.
  //       This is what lets a query "Settings" find a magnifier-icon button
  //       whose only label is aria-label="Settings".
  //
  //  The implementation is deliberately generic — there is no per-term, per-
  //  language, or per-site logic. Any string the user types runs through the
  //  same pipeline.
  // -----------------------------------------------------------------------------
  const Matcher = (() => {
    // ---- Tunable constants ------------------------------------------------
    // Weights for the SEMANTIC phase only. The text phase is unweighted —
    // every literal text match gets returned.
    const W = {
      ariaLabelExact: 100,
      ariaLabelSubstring: 60,
      titleAttr: 45,
      placeholderAttr: 45,
      altAttr: 45,
      nameOrId: 30,
      dataAttr: 18,
      roleMatch: 25,
      tagMatch: 25,
      nearbyLabel: 35,
      interactive: 15,
      tokenOverlap: 25,
      fuzzyTokenMatch: 20,
      visible: 5,
    };

    // Hint words that bias the semantic phase toward a particular element kind.
    const TYPE_HINTS = [
      { words: ['button', 'btn'], tags: ['button'], roles: ['button'], extra: ['[type="button"]', '[type="submit"]'] },
      { words: ['link'], tags: ['a'], roles: ['link'] },
      { words: ['input', 'field', 'textbox', 'textfield'], tags: ['input', 'textarea'], roles: ['textbox'] },
      { words: ['dropdown', 'select', 'combobox'], tags: ['select'], roles: ['combobox', 'listbox'] },
      { words: ['checkbox'], tags: [], roles: ['checkbox'], extra: ['[type="checkbox"]'] },
      { words: ['radio'], tags: [], roles: ['radio'], extra: ['[type="radio"]'] },
      { words: ['tab'], tags: [], roles: ['tab'] },
      { words: ['menu'], tags: [], roles: ['menu', 'menuitem'] },
      { words: ['icon'], tags: ['svg', 'i'] },
      { words: ['image', 'picture', 'photo'], tags: ['img'] },
      { words: ['heading', 'header', 'title'], tags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], roles: ['heading'] },
    ];

    const STOPWORDS = new Set([
      'the', 'a', 'an', 'to', 'on', 'in', 'of', 'for', 'with', 'and',
      'or', 'that', 'this', 'is', 'are', 'be', 'click', 'press', 'tap',
      'find', 'show', 'me', 'please', 'next', 'previous',
    ]);

    // Per-search caches. Reset at the top of every `search()` call so we pick
    // up DOM mutations between searches but pay each cost once per search.
    let subtreeTextCache = new WeakMap();
    let visibilityCache = new WeakMap();

    // ---- Normalization ----------------------------------------------------
    // Lowercase, strip zero-width / bidi marks, collapse whitespace runs,
    // trim. Used identically on the query and on every text fragment we
    // extract from the DOM, so they're comparable as plain strings.
    function normalize(str) {
      return (str || '')
        .toString()
        .toLowerCase()
        .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function tokenize(str) {
      return normalize(str)
        .split(/[^a-z0-9À-ɏ]+/i) // keep latin extended (umlauts etc.)
        .filter(Boolean);
    }

    function meaningfulTokens(str) {
      return tokenize(str).filter((t) => !STOPWORDS.has(t) && t.length > 1);
    }

    // ---- Visibility -------------------------------------------------------
    // An element is "visible" if it has at least one positive-area client
    // rect, isn't display:none / visibility:hidden / opacity:0 itself, and
    // none of its ancestors are display:none / visibility:hidden.
    //
    // Using `getClientRects()` (rather than `getBoundingClientRect`) makes
    // this robust for inline elements that wrap across line breaks — those
    // have multiple positive-area rects even though the bounding box can
    // collapse on weird layouts.
    function isElementVisible(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      if (visibilityCache.has(el)) return visibilityCache.get(el);
      const result = computeVisibility(el);
      visibilityCache.set(el, result);
      return result;
    }

    function computeVisibility(el) {
      // Reject obviously-non-rendered tags up front.
      const tag = el.tagName && el.tagName.toLowerCase();
      if (!tag) return false;
      if (tag === 'script' || tag === 'style' || tag === 'noscript' ||
          tag === 'template' || tag === 'meta' || tag === 'link' ||
          tag === 'head' || tag === 'title') return false;

      const rects = el.getClientRects ? el.getClientRects() : null;
      let hasArea = false;
      if (rects && rects.length) {
        for (const r of rects) {
          if (r.width > 0 && r.height > 0) { hasArea = true; break; }
        }
      } else {
        // Fallback for environments where getClientRects is unavailable.
        const r = el.getBoundingClientRect && el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) hasArea = true;
      }
      if (!hasArea) return false;

      const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (cs) {
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
        const op = parseFloat(cs.opacity);
        if (!Number.isNaN(op) && op < 0.05) return false;
      }
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;

      // Walk ancestors so we don't report visible nodes inside hidden subtrees.
      let p = el.parentElement;
      while (p) {
        if (visibilityCache.has(p)) {
          if (!visibilityCache.get(p)) return false;
          break;
        }
        const ps = window.getComputedStyle ? window.getComputedStyle(p) : null;
        if (ps && (ps.display === 'none' || ps.visibility === 'hidden' || ps.visibility === 'collapse')) {
          return false;
        }
        if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return false;
        p = p.parentElement;
      }
      return true;
    }

    // ---- Text extraction --------------------------------------------------
    // Recursively concatenate the text in `el`'s subtree (including open
    // shadow roots). Skips <script>/<style>/<noscript>/<template> and
    // aria-hidden subtrees. Cached per element per search.
    //
    // We concatenate WITHOUT inserting synthetic whitespace, mirroring the
    // browser's native `Node.textContent` semantics. That way text that the
    // page authored as one continuous word — even when split across nested
    // inline elements like `<span>foo<em>bar</em>baz</span>` — reads back
    // as "foobarbaz" so a substring search lands on it. Whitespace that
    // exists in the source is preserved by the text nodes themselves and
    // collapsed once at normalize() time.
    function getFullTextContent(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
      if (subtreeTextCache.has(el)) return subtreeTextCache.get(el);
      const tag = el.tagName && el.tagName.toLowerCase();
      if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') {
        subtreeTextCache.set(el, '');
        return '';
      }
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') {
        subtreeTextCache.set(el, '');
        return '';
      }
      let raw = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.nodeValue) raw += node.nodeValue;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          raw += getFullTextContent(node);
        }
      }
      if (el.shadowRoot) {
        for (const c of el.shadowRoot.childNodes) {
          if (c.nodeType === Node.TEXT_NODE && c.nodeValue) raw += c.nodeValue;
          else if (c.nodeType === Node.ELEMENT_NODE) raw += getFullTextContent(c);
        }
      }
      const normalized = normalize(raw);
      subtreeTextCache.set(el, normalized);
      return normalized;
    }

    // Accessibility name, in roughly the order WAI-ARIA recommends.
    function getAccessibleText(el) {
      if (!el || !el.getAttribute) return '';
      const aria = el.getAttribute('aria-label');
      if (aria) return normalize(aria);
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ref = el.ownerDocument && el.ownerDocument.getElementById(labelledBy);
        if (ref) return normalize(ref.textContent);
      }
      const title = el.getAttribute('title');
      if (title) return normalize(title);
      const alt = el.getAttribute('alt');
      if (alt) return normalize(alt);
      return '';
    }

    function getNearbyLabelText(el) {
      if (!el) return '';
      if (el.id && typeof CSS !== 'undefined' && CSS.escape) {
        try {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) return normalize(lbl.textContent);
        } catch (_) { /* invalid selector — ignore */ }
      }
      const parentLabel = el.closest && el.closest('label');
      if (parentLabel && parentLabel !== el) return normalize(parentLabel.textContent);
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') return normalize(prev.textContent);
      return '';
    }

    function isInteractive(el) {
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      if (['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
      const role = el.getAttribute && el.getAttribute('role');
      if (role && ['button', 'link', 'checkbox', 'menuitem', 'tab', 'option', 'switch', 'radio'].includes(role)) {
        return true;
      }
      if (el.hasAttribute && el.hasAttribute('onclick')) return true;
      if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) return true;
      try {
        const cs = window.getComputedStyle(el);
        if (cs && cs.cursor === 'pointer') return true;
      } catch (_) { /* style may be unavailable in detached nodes */ }
      return false;
    }

    function detectTypeHint(query) {
      const tokens = tokenize(query);
      for (const hint of TYPE_HINTS) {
        if (hint.words.some((w) => tokens.includes(w))) return hint;
      }
      return null;
    }

    // ---- Levenshtein (capped) for fuzzy semantic matching ----------------
    function levenshtein(a, b, cutoff = 4) {
      if (a === b) return 0;
      if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
      const m = a.length, n = b.length;
      if (!m) return n;
      if (!n) return m;
      let prev = new Array(n + 1);
      let cur = new Array(n + 1);
      for (let j = 0; j <= n; j++) prev[j] = j;
      for (let i = 1; i <= m; i++) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
          if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > cutoff) return cutoff + 1;
        [prev, cur] = [cur, prev];
      }
      return prev[n];
    }

    function fuzzyTokenMatch(needle, haystackTokens) {
      const cutoff = needle.length <= 4 ? 1 : 2;
      for (const t of haystackTokens) {
        if (Math.abs(t.length - needle.length) > cutoff) continue;
        if (levenshtein(needle, t, cutoff) <= cutoff) return true;
      }
      return false;
    }

    // ---- DOM walk (incl. open shadow roots) -------------------------------
    function* walkElements(root) {
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName && node.tagName.toLowerCase();
        if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' ||
            tag === 'template' || tag === 'meta' || tag === 'link') continue;
        yield node;
        if (node.shadowRoot) {
          for (let i = node.shadowRoot.children.length - 1; i >= 0; i--) {
            stack.push(node.shadowRoot.children[i]);
          }
        }
        const children = node.children;
        if (children) {
          for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
      }
    }

    // ---- Phase 1: literal text pass ---------------------------------------
    // Find every visible element whose subtree text contains the query. Then
    // reduce to deepest-only — an element is dropped if any of its
    // descendants is also a match (the descendant carries the actual text).
    //
    // Returns matches in document order so cycling next/prev moves predictably
    // top-to-bottom, left-to-right through the page.
    function findTextMatches(qNorm, opts) {
      if (!qNorm) return [];
      const startedAt = performance.now();
      const timeoutMs = opts.timeoutMs ?? 500;
      const maxCandidates = opts.maxCandidates ?? 12000;

      const all = [];
      let count = 0;
      for (const el of walkElements(document.documentElement)) {
        count++;
        if (count > maxCandidates) break;
        if ((count & 511) === 0 && performance.now() - startedAt > timeoutMs) break;
        if (!isElementVisible(el)) continue;
        const text = getFullTextContent(el);
        if (text && text.includes(qNorm)) all.push(el);
      }

      if (!all.length) return [];

      // Reduce to deepest-only. We rely on the document-order property of
      // walkElements: a parent is always emitted before its descendants, so
      // we can scan once and drop any element whose immediately-following
      // siblings/descendants also matched.
      //
      // For the typical case (a handful of matches) the O(k²) check below
      // is trivial. We cap k at 200 to keep this fast on pathological
      // pages where the query is e.g. a single common letter.
      const limited = all.slice(0, 200);
      const deepest = [];
      for (let i = 0; i < limited.length; i++) {
        const a = limited[i];
        let hasMatchingDescendant = false;
        for (let j = 0; j < limited.length; j++) {
          if (i === j) continue;
          const b = limited[j];
          if (a.contains(b)) { hasMatchingDescendant = true; break; }
        }
        if (!hasMatchingDescendant) deepest.push(a);
      }

      // Document order — compareDocumentPosition is the canonical answer.
      deepest.sort((a, b) => {
        if (a === b) return 0;
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      return deepest.map((el) => ({
        el,
        score: 100,
        reasons: ['text-match'],
        matchedByText: true,
      }));
    }

    // ---- Phase 2: semantic fallback ---------------------------------------
    // Only runs when phase 1 returns nothing. Scores elements based on
    // accessibility name, attributes, type hints, label association, and
    // role/tag. This is what makes a query "Search" still find an icon
    // button whose only handle is aria-label="Search".
    function scoreSemantic(el, qNorm, qSignificantTokens, typeHint) {
      const reasons = [];
      let score = 0;

      const accText = getAccessibleText(el);
      if (accText) {
        if (accText === qNorm) {
          score += W.ariaLabelExact; reasons.push('aria-exact');
        } else if (accText.includes(qNorm)) {
          score += W.ariaLabelSubstring; reasons.push('aria-substring');
        } else if (qSignificantTokens.length) {
          const accTokens = tokenize(accText);
          const hits = qSignificantTokens.filter((t) => accTokens.includes(t)).length;
          if (hits === qSignificantTokens.length) {
            score += W.ariaLabelSubstring; reasons.push('aria-all-tokens');
          } else if (hits > 0) {
            score += Math.round(W.tokenOverlap * (hits / qSignificantTokens.length));
            reasons.push(`aria-token-overlap-${hits}/${qSignificantTokens.length}`);
          } else if (fuzzyTokenMatch(qNorm, accTokens)) {
            score += W.fuzzyTokenMatch; reasons.push('aria-fuzzy');
          }
        }
      }

      const placeholder = normalize(el.getAttribute && el.getAttribute('placeholder'));
      if (placeholder && (placeholder === qNorm || placeholder.includes(qNorm))) {
        score += W.placeholderAttr; reasons.push('placeholder');
      }
      const titleAttr = normalize(el.getAttribute && el.getAttribute('title'));
      if (titleAttr && titleAttr.includes(qNorm)) {
        score += W.titleAttr; reasons.push('title');
      }
      const altAttr = normalize(el.getAttribute && el.getAttribute('alt'));
      if (altAttr && altAttr.includes(qNorm)) {
        score += W.altAttr; reasons.push('alt');
      }
      const nameAttr = normalize(el.getAttribute && el.getAttribute('name'));
      if (nameAttr && (nameAttr === qNorm || nameAttr.includes(qNorm))) {
        score += W.nameOrId; reasons.push('name');
      }
      const idAttr = normalize(el.id);
      if (idAttr && (idAttr === qNorm || idAttr.includes(qNorm))) {
        score += W.nameOrId; reasons.push('id');
      }

      if (el.attributes && qNorm) {
        for (const attr of el.attributes) {
          if (!attr.name.startsWith('data-')) continue;
          const v = normalize(attr.value);
          if (!v) continue;
          if (v === qNorm || v.includes(qNorm)) {
            score += W.dataAttr; reasons.push(`data:${attr.name}`);
            break;
          }
        }
      }

      if (typeHint) {
        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute && el.getAttribute('role')) || '';
        if (typeHint.tags && typeHint.tags.includes(tag)) {
          score += W.tagMatch; reasons.push(`tag:${tag}`);
        }
        if (role && typeHint.roles && typeHint.roles.includes(role)) {
          score += W.roleMatch; reasons.push(`role:${role}`);
        }
        if (typeHint.extra) {
          for (const sel of typeHint.extra) {
            try {
              if (el.matches(sel)) { score += W.tagMatch; reasons.push(`extra:${sel}`); break; }
            } catch (_) { /* ignore invalid selectors */ }
          }
        }
      }

      if (!reasons.length) {
        const nearby = getNearbyLabelText(el);
        if (nearby && (nearby === qNorm || nearby.includes(qNorm))) {
          score += W.nearbyLabel; reasons.push('nearby-label');
        }
      }

      // Tie-breakers — only applied when at least one real match reason fired.
      if (reasons.length) {
        if (isInteractive(el)) score += W.interactive;
        score += W.visible;
      }

      return { score, reasons };
    }

    function findSemanticMatches(qNorm, qSignificantTokens, typeHint, opts) {
      const results = [];
      const startedAt = performance.now();
      const timeoutMs = opts.timeoutMs ?? 500;
      const maxCandidates = opts.maxCandidates ?? 12000;
      let count = 0;

      for (const el of walkElements(document.documentElement)) {
        count++;
        if (count > maxCandidates) break;
        if ((count & 511) === 0 && performance.now() - startedAt > timeoutMs) break;
        if (!isElementVisible(el)) continue;
        const { score, reasons } = scoreSemantic(el, qNorm, qSignificantTokens, typeHint);
        if (!reasons.length || score <= 0) continue;
        results.push({ el, score, reasons, matchedByText: false });
      }

      results.sort((a, b) => b.score - a.score);

      // Parent/child dedup. For semantic matches we keep the parent unless
      // a descendant scores at least 85% — this preserves "the button is
      // the click target" behavior when the parent matches via aria-label
      // and a child happens to share text.
      const deduped = [];
      for (const r of results) {
        let skip = false;
        for (const kept of deduped) {
          if (kept.el.contains(r.el) && r.score >= kept.score * 0.85) {
            deduped[deduped.indexOf(kept)] = r;
            skip = true;
            break;
          }
          if (r.el.contains(kept.el) && kept.score >= r.score * 0.85) {
            skip = true;
            break;
          }
        }
        if (!skip) deduped.push(r);
        if (deduped.length >= 25) break;
      }

      return deduped;
    }

    // ---- Reveal chain for hidden / nested matches -------------------------
    //
    // When the query lives inside something the user can't currently see —
    // a closed dropdown, a closed `<details>`, an inactive tab panel, a
    // generic `[hidden]` container, an `aria-controls`-driven popover, or
    // any nested combination of those — VoiceMosh builds a "reveal chain":
    // an ordered list of (trigger, hidden container) pairs leading from a
    // visible starting point all the way down to the leaf element that
    // actually contains the matching text. The Highlighter walks the chain
    // step by step, dispatching the appropriate reveal action at each
    // level, so the user sees a precise path from what they can see now to
    // the exact target.
    //
    // The detection is fully generic — every recognizable hide/show
    // pattern in HTML and ARIA is supported with the same code path:
    //
    //   • Native `<select>` (option lives in the browser-rendered popup)
    //   • `<datalist>` paired with an `<input list>`
    //   • `<details>` with non-summary children hidden when not `open`
    //   • `[role="listbox"]`/`[role="menu"]`/`[role="menubar"]`/
    //     `[role="combobox"]`/`[role="tree"]`/`[role="tablist"]`
    //   • `[role="tabpanel"]` (paired with `[role="tab"]`)
    //   • `[hidden]` attribute, `display:none`, `visibility:hidden`,
    //     `aria-hidden="true"`, `opacity:0` containers
    //   • Anything an element points at via `aria-controls`
    //   • Submenu / nested popovers via `aria-haspopup` parent menuitems
    //
    // No per-component, per-library, or per-site logic.

    function nodeIsClosedDetails(el) {
      return el && el.tagName === 'DETAILS' && !el.open;
    }

    // Is `el` itself rendered hidden (independent of ancestors)?
    function isElementSelfHidden(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      if (el.hasAttribute('hidden')) return true;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
      try {
        const cs = window.getComputedStyle(el);
        if (!cs) return false;
        if (cs.display === 'none') return true;
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
        const op = parseFloat(cs.opacity);
        if (!Number.isNaN(op) && op < 0.05) return true;
      } catch (_) { /* detached node */ }
      return false;
    }

    // Does `container` hide `descendant`? Catches <details> (which hides
    // non-summary children without changing computed styles) on top of the
    // standard self-hidden checks.
    function containerHidesDescendant(container, descendant) {
      if (!container || !descendant) return false;
      if (nodeIsClosedDetails(container)) {
        const summary = container.querySelector(':scope > summary');
        if (!summary || !summary.contains(descendant)) return true;
        return false; // descendant is inside <summary>, visible.
      }
      return isElementSelfHidden(container);
    }

    // Walk up from `target` to find the closest ancestor that's hiding it.
    // Returns null when nothing in the chain is hiding `target`.
    function findClosestHidingAncestor(target) {
      if (!target || !target.parentElement) return null;
      // Native <option>/<optgroup> are rendered inside the closed picker
      // popup, not the document — treat the <select> / <datalist> as the
      // hiding ancestor so the user is guided to open the picker.
      if (target.tagName === 'OPTION' || target.tagName === 'OPTGROUP') {
        const native = target.closest('select, datalist');
        if (native) return native;
      }
      let p = target.parentElement;
      while (p && p.nodeType === Node.ELEMENT_NODE) {
        if (containerHidesDescendant(p, target)) return p;
        p = p.parentElement;
      }
      return null;
    }

    // Map a container's tag/role to a `kind` string the Highlighter uses
    // to pick the right reveal action. Defined separately so every trigger-
    // lookup branch tags the result consistently with the container's
    // semantics, not the lookup mechanism that found it.
    function classifyContainer(container) {
      if (!container || !container.tagName) return 'unknown';
      const tag = container.tagName.toLowerCase();
      if (tag === 'select') return 'native-select';
      if (tag === 'datalist') return 'datalist';
      if (tag === 'details') return 'details';
      const role = container.getAttribute && container.getAttribute('role');
      if (role === 'menu' || role === 'menubar') return 'aria-menu';
      if (role === 'combobox') return 'aria-combobox';
      if (role === 'listbox') return 'aria-listbox';
      if (role === 'tabpanel') return 'aria-tab';
      if (role === 'tablist') return 'aria-tablist';
      if (role === 'tree') return 'aria-tree';
      return 'aria-controls';
    }

    // Find the trigger element that reveals a hidden container. The `kind`
    // returned describes the container's semantics (so the Highlighter
    // knows whether to set `details.open`, call `showPicker()`, dispatch a
    // click, etc.) — it is NOT a description of how we found the trigger.
    function findRevealTrigger(container) {
      if (!container || !container.tagName) return null;
      const tag = container.tagName.toLowerCase();
      const role = container.getAttribute && container.getAttribute('role');
      const kind = classifyContainer(container);

      if (tag === 'select') return { trigger: container, kind };

      if (tag === 'datalist') {
        if (container.id && typeof CSS !== 'undefined' && CSS.escape) {
          try {
            const input = document.querySelector(`input[list="${CSS.escape(container.id)}"]`);
            if (input) return { trigger: input, kind };
          } catch (_) {}
        }
        return null;
      }

      if (tag === 'details' && !container.open) {
        const summary = container.querySelector(':scope > summary');
        return { trigger: summary || container, kind };
      }

      // 1. aria-controls referrer.
      if (container.id && typeof CSS !== 'undefined' && CSS.escape) {
        try {
          const ctrl = document.querySelector(`[aria-controls~="${CSS.escape(container.id)}"]`);
          if (ctrl && ctrl !== container && !container.contains(ctrl)) {
            return { trigger: ctrl, kind };
          }
        } catch (_) { /* invalid selector */ }
      }

      // 2. Container's aria-labelledby — for tabpanels and ARIA dropdowns
      //    the labelling element often IS the trigger.
      const labelledBy = container.getAttribute && container.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ids = labelledBy.split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const ref = document.getElementById(id);
          if (!ref || ref === container || container.contains(ref)) continue;
          const looksLikeTrigger =
            ref.tagName === 'BUTTON' ||
            ref.getAttribute('role') === 'tab' ||
            (ref.hasAttribute && (ref.hasAttribute('aria-haspopup') || ref.hasAttribute('aria-expanded')));
          if (looksLikeTrigger) return { trigger: ref, kind };
        }
      }

      // 3. Parent menuitem with aria-haspopup (nested submenu pattern).
      const parent = container.parentElement;
      if (parent && parent.hasAttribute) {
        const parentRole = parent.getAttribute('role');
        if (parentRole &&
            ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'treeitem', 'tab'].includes(parentRole) &&
            (parent.hasAttribute('aria-haspopup') || parent.hasAttribute('aria-expanded'))) {
          return { trigger: parent, kind };
        }
      }

      // 4. Walk up to a near ancestor with aria-haspopup.
      let p = container.parentElement;
      let hops = 0;
      while (p && hops < 6) {
        if (p.hasAttribute && p.hasAttribute('aria-haspopup')) return { trigger: p, kind };
        hops++;
        p = p.parentElement;
      }

      // 5. Sibling button — preceding the container, then preceding the
      //    container's wrapper (popups are often rendered next to a wrapper
      //    div rather than the trigger itself).
      const looksLikeTrigger = (sib) =>
        sib && (sib.tagName === 'BUTTON' ||
                (sib.hasAttribute && (sib.hasAttribute('aria-haspopup') || sib.hasAttribute('aria-expanded'))));
      let sib = container.previousElementSibling;
      while (sib) { if (looksLikeTrigger(sib)) return { trigger: sib, kind }; sib = sib.previousElementSibling; }
      if (container.parentElement) {
        sib = container.parentElement.previousElementSibling;
        while (sib) { if (looksLikeTrigger(sib)) return { trigger: sib, kind }; sib = sib.previousElementSibling; }
      }

      return null;
    }

    // Walk up from the leaf target through every hidden ancestor in turn,
    // building the reveal chain. Each entry is { container, trigger, kind,
    // optionEl } where optionEl is "the thing the user needs to interact
    // with at the previous level" (either an inner trigger, or the final
    // matching element).
    function getRevealChain(target) {
      if (!target) return [];
      const chain = [];
      const seenContainers = new Set();
      let current = target;
      let safety = 20;

      while (current && safety-- > 0) {
        const hider = findClosestHidingAncestor(current);
        if (!hider || seenContainers.has(hider)) break;
        seenContainers.add(hider);

        const trigInfo = findRevealTrigger(hider);
        if (!trigInfo || !trigInfo.trigger) break;

        chain.unshift({
          container: hider,
          trigger: trigInfo.trigger,
          kind: trigInfo.kind,
          optionEl: current,
        });

        if (trigInfo.trigger === hider) break; // self-trigger like <select>
        current = trigInfo.trigger;
      }

      return chain;
    }

    // Display-friendly text for the highlight tooltip.
    function getDisplayText(el) {
      if (!el) return '';
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return aria.replace(/\s+/g, ' ').trim();
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // Find the deepest descendant of `root` whose textContent contains the
    // (already-normalized) query. Uses raw textContent so it works for
    // descendants that are hidden — which is the whole point of this pass.
    function findDeepestHiddenTextMatch(root, qNorm) {
      if (!root || !qNorm) return null;
      let result = null;
      function visit(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = el.tagName && el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return false;
        const text = normalize(el.textContent || '');
        if (!text || !text.includes(qNorm)) return false;
        let childMatched = false;
        for (const child of el.children) {
          if (visit(child)) childMatched = true;
        }
        if (!childMatched) result = el;
        return true;
      }
      // Try the root itself first (covers <option> directly).
      if (visit(root)) {
        // If only the root matched (no deeper child), prefer the most
        // specific option-like child if one exists and contains the text.
        // Otherwise fall back to root.
        if (!result) result = root;
      }
      return result;
    }

    // Find every hidden text match on the page and decorate each with a
    // reveal chain. This is the universal "guide me to the hidden target"
    // path, replacing the dropdown-only pass.
    function findGuidedMatches(qNorm, opts) {
      if (!qNorm) return [];
      const results = [];
      const claimedTargets = new WeakSet();
      const startedAt = performance.now();
      const timeoutMs = opts.timeoutMs ?? 500;

      // Collect every recognizable "hidden region" in the document. We use
      // a Set so a region pointed at by multiple selectors is deduped.
      const regions = new Set();
      const regionSelectors = [
        'details:not([open])',
        'select', 'datalist',
        '[role="listbox"]', '[role="menu"]', '[role="menubar"]',
        '[role="combobox"]', '[role="tree"]', '[role="tablist"]',
        '[role="tabpanel"]',
        '[hidden]',
      ];
      for (const sel of regionSelectors) {
        try {
          for (const r of document.querySelectorAll(sel)) regions.add(r);
        } catch (_) { /* invalid selector */ }
      }
      // Also include every element pointed at by `aria-controls` — that's
      // the canonical "popup / disclosure / panel" pattern in ARIA.
      try {
        for (const ctrl of document.querySelectorAll('[aria-controls]')) {
          const idsAttr = ctrl.getAttribute('aria-controls') || '';
          for (const id of idsAttr.split(/\s+/)) {
            if (!id) continue;
            const target = document.getElementById(id);
            if (target) regions.add(target);
          }
        }
      } catch (_) {}

      for (const region of regions) {
        if (performance.now() - startedAt > timeoutMs) break;
        // Cheap reject — only proceed if the region's full textContent
        // (which sees through hidden subtrees) contains the query.
        const regionText = normalize(region.textContent || '');
        if (!regionText || !regionText.includes(qNorm)) continue;

        const deepest = findDeepestHiddenTextMatch(region, qNorm);
        if (!deepest || claimedTargets.has(deepest)) continue;
        claimedTargets.add(deepest);

        const chain = getRevealChain(deepest);
        if (!chain.length) continue;

        const anchor = chain[0].trigger;
        // The outermost trigger has to actually be visible — that's where
        // the user starts. If it isn't, we don't have a usable starting
        // point and the match is dropped (a more sophisticated future
        // version could chain even deeper, but for an MVP this is fine).
        if (!anchor || !isElementVisible(anchor)) continue;

        results.push({
          el: anchor,
          score: 100,
          reasons: ['guided-reveal'],
          matchedByText: true,
          kind: 'guided',
          chain,
          optionEl: deepest,
          optionText: getDisplayText(deepest),
        });
      }

      return results;
    }

    // Merge text-phase and guided-phase results, dropping any text match
    // whose anchor is already covered by a guided chain (so we don't
    // double-highlight the same `<select>` once as a flat text match and
    // once as a guided reveal).
    function mergeTextAndGuided(textMatches, guidedMatches) {
      if (!guidedMatches.length) return textMatches;
      const claimed = new Set();
      for (const g of guidedMatches) {
        for (const step of g.chain) {
          claimed.add(step.container);
          if (step.trigger) claimed.add(step.trigger);
          if (step.optionEl) claimed.add(step.optionEl);
        }
        if (g.optionEl) claimed.add(g.optionEl);
      }
      const merged = guidedMatches.slice();
      for (const t of textMatches) {
        if (claimed.has(t.el)) continue;
        let covered = false;
        for (const g of guidedMatches) {
          for (const step of g.chain) {
            if (t.el === step.container || t.el === step.trigger ||
                (step.container && (t.el.contains(step.container) || step.container.contains(t.el)))) {
              covered = true; break;
            }
          }
          if (covered) break;
        }
        if (!covered) merged.push(t);
      }
      // Sort by document order using each match's most specific anchor (the
      // option for guided matches, the element for text matches).
      merged.sort((a, b) => {
        const aEl = (a.kind === 'guided' ? a.optionEl : null) || a.el;
        const bEl = (b.kind === 'guided' ? b.optionEl : null) || b.el;
        if (aEl === bEl) return 0;
        try {
          const pos = aEl.compareDocumentPosition(bEl);
          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        } catch (_) {}
        return 0;
      });
      return merged;
    }

    // ---- Public search ----------------------------------------------------
    function search(query, opts = {}) {
      const qNorm = normalize(query);
      if (!qNorm) return [];

      // Reset per-search caches — the page may have rerendered since the
      // last search.
      subtreeTextCache = new WeakMap();
      visibilityCache = new WeakMap();

      const qSignificantTokens = meaningfulTokens(qNorm);
      const typeHint = detectTypeHint(qNorm);

      // Phase 1a: literal text in visible elements.
      const textMatches = findTextMatches(qNorm, opts);
      // Phase 1b: text inside hidden / nested / collapsible structures,
      //           each decorated with a reveal chain so the Highlighter can
      //           guide the user step by step to the exact target.
      const guidedMatches = findGuidedMatches(qNorm, opts);

      if (textMatches.length || guidedMatches.length) {
        return mergeTextAndGuided(textMatches, guidedMatches);
      }

      // Phase 2: semantic fallback.
      return findSemanticMatches(qNorm, qSignificantTokens, typeHint, opts);
    }

    // Decide which subset of search results to actually highlight.
    //   - Text matches (phase 1): return all of them, capped at 50 to keep
    //     the highlight layer manageable on pages where the query is very
    //     common (e.g. a single letter).
    //   - Semantic matches (phase 2): if the top score dominates, return
    //     just the top. If several near-tie, return up to 10 so the user
    //     can cycle through similarly-good candidates.
    function pickResultsToShow(results, opts = {}) {
      if (!results.length) return [];
      if (results[0].matchedByText) {
        return results.slice(0, opts.maxTextMatches ?? 50);
      }
      const top = results[0].score;
      const close = results.filter((r) => r.score >= top * 0.7);
      if (close.length === 1) return close;
      const exactTies = close.filter((r) => r.score === top).length;
      const cap = exactTies >= 3 ? Math.min(close.length, 10) : 3;
      return close.slice(0, cap);
    }

    return {
      search,
      pickResultsToShow,
      isElementVisible,
      getFullTextContent,
      // Reveal chain — used by the Highlighter to drive the step-by-step
      // open/highlight sequence, and exposed for tests.
      getRevealChain,
      findRevealTrigger,
      findClosestHidingAncestor,
      isElementSelfHidden,
      // Exposed for testing / future use.
      findTextMatches,
      findGuidedMatches,
      findSemanticMatches,
    };
  })();


  // -----------------------------------------------------------------------------
  //  Highlighter — visual overlays that don't interfere with the page
  // -----------------------------------------------------------------------------
  const Highlighter = (() => {
    const LAYER_ID = '__voicemosh_layer__';
    const STYLE_ID = '__voicemosh_style__';
    let overlays = [];          // [{ el, ringEl, labelEl, score, isActive }]
    let activeIndex = 0;
    let resizeObserver = null;
    let scrollHandler = null;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${LAYER_ID} {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          pointer-events: none;
          contain: layout style;
        }
        #${LAYER_ID} .vm-ring {
          position: fixed;
          border: 2.5px solid #ff3b30;
          border-radius: 6px;
          box-shadow: 0 0 0 2px rgba(255,59,48,0.25), 0 0 12px rgba(255,59,48,0.55);
          background: rgba(255,59,48,0.06);
          transition: opacity 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
          pointer-events: none;
        }
        #${LAYER_ID} .vm-ring.dim {
          border-color: rgba(255,149,0,0.7);
          box-shadow: 0 0 0 1px rgba(255,149,0,0.25);
          opacity: 0.55;
        }
        #${LAYER_ID} .vm-ring.active {
          animation: vm-pulse 1.4s ease-in-out 2;
        }
        @keyframes vm-pulse {
          0%, 100% { box-shadow: 0 0 0 2px rgba(255,59,48,0.25), 0 0 12px rgba(255,59,48,0.55); }
          50%      { box-shadow: 0 0 0 6px rgba(255,59,48,0.45), 0 0 24px rgba(255,59,48,0.85); }
        }
        #${LAYER_ID} .vm-label {
          position: fixed;
          font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          background: #ff3b30;
          color: #fff;
          padding: 4px 8px 4px 8px;
          border-radius: 4px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.18);
          display: inline-flex;
          align-items: center;
          gap: 6px;
          pointer-events: auto;
          user-select: none;
          white-space: nowrap;
        }
        #${LAYER_ID} .vm-label .vm-close {
          width: 14px;
          height: 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: rgba(255,255,255,0.22);
          cursor: pointer;
          font-size: 12px;
          line-height: 1;
        }
        #${LAYER_ID} .vm-label .vm-close:hover { background: rgba(255,255,255,0.4); }
        #${LAYER_ID} .vm-label.dim { background: #ff9500; opacity: 0.85; }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    function ensureLayer() {
      let layer = document.getElementById(LAYER_ID);
      if (!layer) {
        layer = document.createElement('div');
        layer.id = LAYER_ID;
        document.documentElement.appendChild(layer);
      }
      return layer;
    }

    function clear() {
      overlays = [];
      activeIndex = 0;
      const layer = document.getElementById(LAYER_ID);
      if (layer) layer.remove();
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      if (scrollHandler) {
        window.removeEventListener('scroll', scrollHandler, true);
        window.removeEventListener('resize', scrollHandler);
        scrollHandler = null;
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
    }

    function render() {
      const layer = ensureLayer();
      for (const o of overlays) {
        const rect = o.el.getBoundingClientRect();
        // For elements scrolled out of view we keep the overlay positioned so the
        // user can scroll back manually.
        const top = rect.top - 4;
        const left = rect.left - 4;
        const width = rect.width + 8;
        const height = rect.height + 8;

        o.ringEl.style.top = `${top}px`;
        o.ringEl.style.left = `${left}px`;
        o.ringEl.style.width = `${width}px`;
        o.ringEl.style.height = `${height}px`;

        // Position the label just above the ring (or below if too close to top).
        const labelTop = top - 26 < 4 ? top + height + 4 : top - 26;
        o.labelEl.style.top = `${labelTop}px`;
        o.labelEl.style.left = `${Math.max(4, left)}px`;
      }
    }

    function setLabelText(overlay, text) {
      const span = overlay.labelEl.querySelector('span:not(.vm-close)');
      if (span) span.textContent = text;
    }

    function defaultLabelFor(overlay, idx, total) {
      if (overlay.match && overlay.match.kind === 'guided') {
        const t = overlay.match.optionText || 'target';
        return total > 1
          ? `Step 1 — opens path to "${t}"  (${idx + 1}/${total})`
          : `Step 1 — opens path to "${t}"`;
      }
      return total > 1
        ? `VoiceMosh • ${idx + 1}/${total}`
        : `VoiceMosh • match`;
    }

    function highlight(matches, activeIdx = 0) {
      clear();
      ensureStyle();
      const layer = ensureLayer();

      overlays = matches.map((m, idx) => {
        const ring = document.createElement('div');
        ring.className = 'vm-ring';
        const label = document.createElement('div');
        label.className = 'vm-label';
        const text = document.createElement('span');
        const close = document.createElement('span');
        close.className = 'vm-close';
        close.textContent = '×';
        close.title = 'Clear highlights';
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          clear();
        });
        label.appendChild(text);
        label.appendChild(close);
        layer.appendChild(ring);
        layer.appendChild(label);
        const overlay = {
          el: m.el,
          ringEl: ring,
          labelEl: label,
          score: m.score,
          match: m,
          chainRunId: 0,        // increments to cancel in-flight chain walks
        };
        text.textContent = defaultLabelFor(overlay, idx, matches.length);
        return overlay;
      });

      setActive(activeIdx);
      render();

      scrollHandler = () => render();
      window.addEventListener('scroll', scrollHandler, true);
      window.addEventListener('resize', scrollHandler);

      try {
        resizeObserver = new ResizeObserver(() => render());
        for (const o of overlays) resizeObserver.observe(o.el);
        resizeObserver.observe(document.documentElement);
      } catch (_) { /* old browsers */ }
    }

    function setActive(idx) {
      if (!overlays.length) return;
      activeIndex = ((idx % overlays.length) + overlays.length) % overlays.length;
      overlays.forEach((o, i) => {
        const isActive = i === activeIndex;
        o.ringEl.classList.toggle('active', isActive);
        o.ringEl.classList.toggle('dim', !isActive);
        o.labelEl.classList.toggle('dim', !isActive);
        // Cancel any in-flight chain walks on overlays that are no longer
        // active so they don't keep firing actions in the background.
        if (!isActive) o.chainRunId = (o.chainRunId || 0) + 1;
      });
      const active = overlays[activeIndex];
      if (active && active.el.scrollIntoView) {
        try { active.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); }
        catch (_) { active.el.scrollIntoView(); }
      }
      render();
      // If the active overlay represents a "guided" match (hidden target
      // behind one or more layers), walk the reveal chain.
      if (active && active.match && active.match.kind === 'guided') {
        runRevealChain(active).catch(() => { /* may be cancelled mid-flight */ });
      }
    }

    // ---- Reveal-chain walker ----------------------------------------------
    //
    // Walks through every step of the chain: highlight the trigger, label
    // it with "Step k/N", apply the appropriate reveal action for the
    // step's kind, wait for the next layer to become visible, then advance
    // to the next step. The final step lands on the leaf option/element.

    function dispatchClickSequence(el) {
      if (!el) return;
      const opts = { bubbles: true, cancelable: true, composed: true };
      try {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const Evt = type.startsWith('pointer') && typeof PointerEvent === 'function'
            ? PointerEvent
            : (typeof MouseEvent === 'function' ? MouseEvent : Event);
          el.dispatchEvent(new Evt(type, opts));
        }
      } catch (_) {
        try { if (typeof el.click === 'function') el.click(); } catch (__) {}
      }
    }

    async function applyRevealAction(step) {
      const { kind, container, trigger } = step;
      try {
        switch (kind) {
          case 'native-select': {
            // Pre-select the matching option so when the native picker
            // opens it lands on the answer.
            try {
              if (step.optionEl && 'value' in step.optionEl && step.optionEl.value !== undefined) {
                container.value = step.optionEl.value;
                container.dispatchEvent(new Event('change', { bubbles: true }));
                container.dispatchEvent(new Event('input', { bubbles: true }));
              }
            } catch (_) {}
            try {
              if (typeof container.showPicker === 'function') container.showPicker();
            } catch (_) { /* needs a user gesture in some contexts */ }
            return;
          }
          case 'datalist': {
            // Focus the input and call showPicker if available.
            try { if (trigger.focus) trigger.focus(); } catch (_) {}
            try { if (typeof trigger.showPicker === 'function') trigger.showPicker(); } catch (_) {}
            return;
          }
          case 'details': {
            try { container.open = true; } catch (_) {}
            // Some custom <details>-like components also listen for click.
            dispatchClickSequence(trigger);
            return;
          }
          default: {
            // For everything click-driven (ARIA dropdowns, tabs, popovers,
            // generic aria-controls).
            const alreadyOpen = trigger && trigger.getAttribute &&
              trigger.getAttribute('aria-expanded') === 'true';
            if (!alreadyOpen) dispatchClickSequence(trigger);
            return;
          }
        }
      } catch (_) { /* non-fatal — chain walker will time out and proceed */ }
    }

    async function waitForVisible(el, timeoutMs = 1500) {
      if (!el) return false;
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const start = now();
      while (now() - start < timeoutMs) {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const cs = window.getComputedStyle(el);
            if (cs && cs.display !== 'none' && cs.visibility !== 'hidden' &&
                parseFloat(cs.opacity || '1') > 0.05) {
              return true;
            }
          }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    }

    async function runRevealChain(overlay) {
      const match = overlay.match;
      if (!match || !match.chain || !match.chain.length) return;
      const runId = ++overlay.chainRunId;
      const totalSteps = match.chain.length + 1;

      // Native <select> short-circuit: we can't overlay the browser-rendered
      // option popup, so just label the select with the option name and
      // let `applyRevealAction` pre-select + try showPicker().
      if (match.chain.length === 1 && match.chain[0].kind === 'native-select') {
        const step = match.chain[0];
        moveOverlayTo(overlay, step.container);
        setLabelText(overlay, `Option "${match.optionText}" inside — click to open`);
        await applyRevealAction(step);
        return;
      }

      for (let i = 0; i < match.chain.length; i++) {
        if (overlay.chainRunId !== runId) return; // cancelled
        const step = match.chain[i];
        const trigger = step.trigger;
        if (!trigger) break;

        moveOverlayTo(overlay, trigger);
        const stepNum = i + 1;
        setLabelText(overlay,
          `Step ${stepNum}/${totalSteps} — open: "${match.optionText}"`);

        await sleep(450);
        if (overlay.chainRunId !== runId) return;

        await applyRevealAction(step);

        // Wait for the NEXT element in the chain to become visible — that's
        // the next trigger for intermediate steps, or the leaf option for
        // the final intermediate step.
        const nextTarget = (i + 1 < match.chain.length)
          ? match.chain[i + 1].trigger
          : match.optionEl;
        await waitForVisible(nextTarget, 1500);
        if (overlay.chainRunId !== runId) return;
      }

      // Final step: land on the leaf option / target.
      if (match.optionEl) {
        moveOverlayTo(overlay, match.optionEl);
        setLabelText(overlay, `Step ${totalSteps}/${totalSteps} — click "${match.optionText}"`);
      }
    }

    function moveOverlayTo(overlay, newEl) {
      if (!newEl || overlay.el === newEl) {
        render();
        return;
      }
      overlay.el = newEl;
      try { if (resizeObserver) resizeObserver.observe(newEl); } catch (_) {}
      try {
        if (newEl.scrollIntoView) {
          newEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        }
      } catch (_) {}
      render();
    }

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    function next() { setActive(activeIndex + 1); }
    function prev() { setActive(activeIndex - 1); }
    function getCount() { return overlays.length; }
    function getActiveIndex() { return activeIndex; }

    return { highlight, clear, next, prev, setActive, getCount, getActiveIndex };
  })();

  // -----------------------------------------------------------------------------
  //  Floating in-page panel (alternative to the popup)
  // -----------------------------------------------------------------------------
  const Panel = (() => {
    const PANEL_ID = '__voicemosh_panel__';
    let lastResults = [];

    function buildPanel() {
      let panel = document.getElementById(PANEL_ID);
      if (panel) return panel;
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText = `
        position: fixed; top: 16px; right: 16px;
        z-index: 2147483647;
        width: 320px;
        background: #1c1c1e; color: #fff;
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        border-radius: 12px;
        box-shadow: 0 12px 36px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06);
        padding: 12px;
        pointer-events: auto;
      `;
      panel.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <strong style="font-size:13px; letter-spacing:0.02em;">VoiceMosh</strong>
          <button id="__vm_close" style="background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;">×</button>
        </div>
        <input id="__vm_input" type="text" placeholder="Describe what you're looking for…"
          style="width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid #3a3a3c; background:#2c2c2e; color:#fff; outline:none; font-size:14px;" />
        <div id="__vm_status" style="margin-top:8px; font-size:12px; color:#aaa; min-height:16px;"></div>
        <div id="__vm_controls" style="display:none; margin-top:8px; gap:6px;">
          <button id="__vm_prev" style="flex:1;padding:6px;border-radius:6px;border:1px solid #3a3a3c;background:#2c2c2e;color:#fff;cursor:pointer;">← Prev</button>
          <span id="__vm_counter" style="flex:1;text-align:center;font-size:12px;color:#aaa;align-self:center;"></span>
          <button id="__vm_next" style="flex:1;padding:6px;border-radius:6px;border:1px solid #3a3a3c;background:#2c2c2e;color:#fff;cursor:pointer;">Next →</button>
        </div>
        <button id="__vm_clear" style="margin-top:8px;width:100%;padding:6px;border-radius:6px;border:1px solid #3a3a3c;background:transparent;color:#fff;cursor:pointer;font-size:12px;">Clear</button>
      `;
      document.documentElement.appendChild(panel);

      const input = panel.querySelector('#__vm_input');
      const status = panel.querySelector('#__vm_status');
      const controls = panel.querySelector('#__vm_controls');
      const counter = panel.querySelector('#__vm_counter');

      panel.querySelector('#__vm_close').addEventListener('click', () => {
        Highlighter.clear();
        panel.remove();
      });
      panel.querySelector('#__vm_clear').addEventListener('click', () => {
        Highlighter.clear();
        controls.style.display = 'none';
        status.textContent = '';
      });
      panel.querySelector('#__vm_prev').addEventListener('click', () => {
        Highlighter.prev();
        updateCounter(counter);
      });
      panel.querySelector('#__vm_next').addEventListener('click', () => {
        Highlighter.next();
        updateCounter(counter);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          performSearch(input.value, status, controls, counter);
        } else if (e.key === 'Escape') {
          Highlighter.clear();
          panel.remove();
        } else if (e.key === 'ArrowDown') {
          Highlighter.next();
          updateCounter(counter);
        } else if (e.key === 'ArrowUp') {
          Highlighter.prev();
          updateCounter(counter);
        }
      });

      requestAnimationFrame(() => input.focus());
      return panel;
    }

    function updateCounter(counterEl) {
      if (!counterEl) return;
      const count = Highlighter.getCount();
      const idx = Highlighter.getActiveIndex();
      counterEl.textContent = count > 1 ? `${idx + 1} of ${count}` : '';
    }

    function performSearch(query, statusEl, controlsEl, counterEl) {
      const q = (query || '').trim();
      if (!q) { statusEl.textContent = 'Type something to search.'; return; }
      const results = Matcher.search(q);
      lastResults = results;
      if (!results.length) {
        Highlighter.clear();
        statusEl.textContent = 'No matches found — try different wording.';
        controlsEl.style.display = 'none';
        return;
      }
      const toShow = Matcher.pickResultsToShow(results);
      Highlighter.highlight(toShow, 0);
      statusEl.textContent = toShow.length === 1
        ? 'Found 1 match'
        : `Found ${toShow.length} possible matches`;
      controlsEl.style.display = toShow.length > 1 ? 'flex' : 'none';
      updateCounter(counterEl);
    }

    function toggle() {
      const panel = document.getElementById(PANEL_ID);
      if (panel) { Highlighter.clear(); panel.remove(); return; }
      buildPanel();
    }

    return { toggle };
  })();

  // -----------------------------------------------------------------------------
  //  Message bridge — popup / background → content script
  // -----------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    try {
      switch (msg.type) {
        case 'voicemosh:ping':
          sendResponse({ ok: true });
          return true;

        case 'voicemosh:search': {
          const results = Matcher.search(msg.query || '');
          if (!results.length) {
            Highlighter.clear();
            sendResponse({ ok: true, count: 0 });
            return true;
          }
          const top = results[0].score;
          const toShow = Matcher.pickResultsToShow(results);
          Highlighter.highlight(toShow, 0);
          sendResponse({
            ok: true,
            count: toShow.length,
            totalCandidates: results.length,
            topScore: top,
            secondScore: results[1]?.score ?? 0,
            activeIndex: Highlighter.getActiveIndex(),
          });
          return true;
        }

        case 'voicemosh:next':
          Highlighter.next();
          sendResponse({ ok: true, activeIndex: Highlighter.getActiveIndex(), count: Highlighter.getCount() });
          return true;

        case 'voicemosh:prev':
          Highlighter.prev();
          sendResponse({ ok: true, activeIndex: Highlighter.getActiveIndex(), count: Highlighter.getCount() });
          return true;

        case 'voicemosh:clear':
          Highlighter.clear();
          sendResponse({ ok: true });
          return true;

        case 'voicemosh:toggle-panel':
          Panel.toggle();
          sendResponse({ ok: true });
          return true;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
      return true;
    }
    return false;
  });

  // Clean up if the page navigates away within an SPA (best-effort).
  window.addEventListener('beforeunload', () => Highlighter.clear());
})();
