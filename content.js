// VoiceMesh — content script
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
  if (window.__voicemeshInstalled) return;
  window.__voicemeshInstalled = true;

  // -----------------------------------------------------------------------------
  //  Matcher — scoring elements against a textual query
  // -----------------------------------------------------------------------------
  const Matcher = (() => {
    // Scoring weights. These are intentionally chunky integers so the resulting
    // confidence is easy to reason about when tuning.
    const W = {
      exactText: 100,
      fullPhraseInText: 70,
      caseInsensitiveText: 60,
      substringText: 35,
      tokenOverlap: 25,           // multiplied by ratio of query tokens found
      ariaLabelExact: 90,
      ariaLabelSubstring: 50,
      titleAttr: 40,
      placeholderAttr: 40,
      altAttr: 40,
      nameOrId: 30,
      dataAttr: 18,
      roleMatch: 25,
      tagMatch: 25,
      nearbyLabel: 30,
      interactive: 15,
      visible: 5,
      // Penalties (subtractive)
      huge: -10,                  // gigantic containers (whole page wrappers)
      tooMuchText: -15,           // matched but text is enormous => low precision
    };

    // Hint words that bias the search toward a particular element type.
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

    function normalize(str) {
      return (str || '')
        .toString()
        .toLowerCase()
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '') // zero-widths / bidi
        .replace(/\s+/g, ' ')
        .trim();
    }

    function tokenize(str) {
      return normalize(str)
        .split(/[^a-z0-9]+/i)
        .filter(Boolean);
    }

    function meaningfulTokens(str) {
      return tokenize(str).filter((t) => !STOPWORDS.has(t) && t.length > 1);
    }

    function isElementVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        parseFloat(style.opacity || '1') < 0.05
      ) {
        return false;
      }
      // Walk up to make sure no ancestor hides us.
      let p = el.parentElement;
      while (p) {
        const ps = window.getComputedStyle(p);
        if (ps.display === 'none' || ps.visibility === 'hidden') return false;
        p = p.parentElement;
      }
      return true;
    }

    // Cheap Levenshtein with early-exit cutoff to avoid pathological cost.
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
      // Returns true if any haystack token is within Levenshtein distance 1-2 of needle.
      const cutoff = needle.length <= 4 ? 1 : 2;
      for (const t of haystackTokens) {
        if (Math.abs(t.length - needle.length) > cutoff) continue;
        if (levenshtein(needle, t, cutoff) <= cutoff) return true;
      }
      return false;
    }

    // Get the visible text of an element, but cap depth/length to keep this cheap.
    function getOwnText(el) {
      let txt = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) txt += node.textContent + ' ';
      }
      return normalize(txt);
    }

    function getAccessibleText(el) {
      // Prefer accessible name sources in roughly the order WAI-ARIA spec recommends.
      const aria = el.getAttribute('aria-label');
      if (aria) return normalize(aria);
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ref = document.getElementById(labelledBy);
        if (ref) return normalize(ref.textContent);
      }
      const title = el.getAttribute('title');
      if (title) return normalize(title);
      const alt = el.getAttribute('alt');
      if (alt) return normalize(alt);
      return '';
    }

    function getNearbyLabelText(el) {
      // Associated <label> for form fields.
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return normalize(lbl.textContent);
      }
      const parentLabel = el.closest('label');
      if (parentLabel && parentLabel !== el) return normalize(parentLabel.textContent);
      // Previous-sibling label heuristic.
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') return normalize(prev.textContent);
      return '';
    }

    function isInteractive(el) {
      const tag = el.tagName.toLowerCase();
      if (['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
      const role = el.getAttribute('role');
      if (role && ['button', 'link', 'checkbox', 'menuitem', 'tab', 'option', 'switch', 'radio'].includes(role)) {
        return true;
      }
      if (el.hasAttribute('onclick') || el.tabIndex >= 0) return true;
      const cursor = window.getComputedStyle(el).cursor;
      if (cursor === 'pointer') return true;
      return false;
    }

    function detectTypeHint(query) {
      const tokens = tokenize(query);
      for (const hint of TYPE_HINTS) {
        if (hint.words.some((w) => tokens.includes(w))) return hint;
      }
      return null;
    }

    // Walk the DOM (including open shadow roots) and yield candidate elements.
    function* walk(root) {
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType !== Node.ELEMENT_NODE && node !== document) continue;

        if (node instanceof Element) {
          const tag = node.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'meta' || tag === 'link') continue;
          yield node;
          if (node.shadowRoot) stack.push(...node.shadowRoot.children);
        }

        const children = node.children;
        if (children) {
          for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
      }
    }

    function scoreElement(el, ctx) {
      const { qNorm, qTokens, qSignificantTokens, typeHint } = ctx;
      const reasons = [];
      let score = 0;

      const ownText = getOwnText(el);
      const accText = getAccessibleText(el);
      const placeholder = normalize(el.getAttribute && el.getAttribute('placeholder'));
      const nameAttr = normalize(el.getAttribute && el.getAttribute('name'));
      const idAttr = normalize(el.id);
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute && el.getAttribute('role')) || '';

      // 1. Visible text matching (heaviest weight when text is concise).
      if (ownText) {
        if (ownText === qNorm) {
          score += W.exactText; reasons.push('exact-text');
        } else if (ownText.includes(qNorm)) {
          score += W.fullPhraseInText; reasons.push('phrase-in-text');
        } else {
          const ownTokens = tokenize(ownText);
          if (qSignificantTokens.length) {
            const hits = qSignificantTokens.filter((t) => ownTokens.includes(t)).length;
            if (hits === qSignificantTokens.length) {
              score += W.caseInsensitiveText; reasons.push('all-tokens-text');
            } else if (hits > 0) {
              score += Math.round(W.tokenOverlap * (hits / qSignificantTokens.length));
              reasons.push(`token-overlap-${hits}/${qSignificantTokens.length}`);
            } else {
              // Fuzzy fallback for typos.
              const fuzzyHits = qSignificantTokens.filter((t) => fuzzyTokenMatch(t, ownTokens)).length;
              if (fuzzyHits > 0) {
                score += Math.round(W.substringText * (fuzzyHits / qSignificantTokens.length));
                reasons.push(`fuzzy-${fuzzyHits}`);
              }
            }
          }
          if (ownText.length < 240 && qNorm.length >= 3 && ownText.includes(qNorm.slice(0, Math.max(3, qNorm.length - 1)))) {
            score += 5;
          }
        }

        // Penalize elements with massive amounts of text — they likely match by accident.
        if (ownText.length > 400) {
          score += W.tooMuchText;
          reasons.push('penalty-too-much-text');
        }
      }

      // 2. Accessible-name attributes.
      if (accText) {
        if (accText === qNorm) {
          score += W.ariaLabelExact; reasons.push('aria-exact');
        } else if (accText.includes(qNorm)) {
          score += W.ariaLabelSubstring; reasons.push('aria-substring');
        } else {
          const t = tokenize(accText);
          const hits = qSignificantTokens.filter((x) => t.includes(x)).length;
          if (hits > 0 && qSignificantTokens.length) {
            score += Math.round(W.ariaLabelSubstring * (hits / qSignificantTokens.length));
            reasons.push(`aria-tokens-${hits}`);
          }
        }
      }

      // 3. Placeholder / alt / title / name / id / data-*.
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
      if (nameAttr && (nameAttr === qNorm || nameAttr.includes(qNorm))) {
        score += W.nameOrId; reasons.push('name');
      }
      if (idAttr && (idAttr === qNorm || idAttr.includes(qNorm))) {
        score += W.nameOrId; reasons.push('id');
      }

      // data-* attributes (test-ids, hooks, etc.).
      if (el.attributes && qSignificantTokens.length) {
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

      // 4. Type-hint matching (e.g. user said "button").
      if (typeHint) {
        if (typeHint.tags.includes(tag)) {
          score += W.tagMatch; reasons.push(`tag:${tag}`);
        }
        if (role && typeHint.roles && typeHint.roles.includes(role)) {
          score += W.roleMatch; reasons.push(`role:${role}`);
        }
        if (typeHint.extra) {
          for (const sel of typeHint.extra) {
            try {
              if (el.matches(sel)) { score += W.tagMatch; reasons.push(`extra:${sel}`); break; }
            } catch (_) { /* invalid selector — ignore */ }
          }
        }
      }

      // 5. Nearby label (for icon-only buttons / unlabeled inputs).
      if (score < W.ariaLabelExact) {
        const nearby = getNearbyLabelText(el);
        if (nearby && (nearby === qNorm || nearby.includes(qNorm))) {
          score += W.nearbyLabel; reasons.push('nearby-label');
        }
      }

      // 6. Interactivity boost — most queries are about something the user wants to click.
      if (isInteractive(el)) {
        score += W.interactive;
      }

      // 7. Visibility check (we filter invisible elements separately, but boost stable on-screen ones).
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        score += W.visible;
        // Penalize gigantic containers — they're rarely the user's target.
        const area = rect.width * rect.height;
        const viewportArea = window.innerWidth * window.innerHeight;
        if (area > viewportArea * 0.6) {
          score += W.huge;
          reasons.push('penalty-huge');
        }
      }

      return { score, reasons };
    }

    function search(query, opts = {}) {
      const qNorm = normalize(query);
      if (!qNorm) return [];
      const qTokens = tokenize(qNorm);
      const qSignificantTokens = meaningfulTokens(qNorm);
      const typeHint = detectTypeHint(qNorm);

      const ctx = { qNorm, qTokens, qSignificantTokens, typeHint };
      const startedAt = performance.now();
      const timeoutMs = opts.timeoutMs ?? 500;
      const maxCandidates = opts.maxCandidates ?? 8000;

      const results = [];
      let count = 0;

      for (const el of walk(document.documentElement)) {
        count++;
        if (count > maxCandidates) break;
        if ((count & 511) === 0 && performance.now() - startedAt > timeoutMs) break;

        if (!isElementVisible(el)) continue;

        const { score, reasons } = scoreElement(el, ctx);
        if (score <= 0) continue;
        results.push({ el, score, reasons });
      }

      results.sort((a, b) => b.score - a.score);

      // De-duplicate: if a parent and child both match strongly, prefer the more specific
      // (smaller / inner) one when their scores are within 15% of each other.
      const deduped = [];
      for (const r of results) {
        let skip = false;
        for (const kept of deduped) {
          if (kept.el.contains(r.el) && r.score >= kept.score * 0.85) {
            // child is similarly strong — replace parent.
            const idx = deduped.indexOf(kept);
            deduped.splice(idx, 1, r);
            skip = true;
            break;
          }
          if (r.el.contains(kept.el) && kept.score >= r.score * 0.85) {
            // parent is weaker than kept child — drop parent.
            skip = true;
            break;
          }
        }
        if (!skip) deduped.push(r);
        if (deduped.length >= 25) break;
      }

      return deduped;
    }

    return { search, isElementVisible };
  })();

  // -----------------------------------------------------------------------------
  //  Highlighter — visual overlays that don't interfere with the page
  // -----------------------------------------------------------------------------
  const Highlighter = (() => {
    const LAYER_ID = '__voicemesh_layer__';
    const STYLE_ID = '__voicemesh_style__';
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

    function highlight(matches, activeIdx = 0) {
      clear();
      ensureStyle();
      const layer = ensureLayer();

      overlays = matches.map((m, idx) => {
        const ring = document.createElement('div');
        ring.className = 'vm-ring';
        const label = document.createElement('div');
        label.className = 'vm-label';
        label.innerHTML = '';
        const text = document.createElement('span');
        const isActive = idx === activeIdx;
        text.textContent = matches.length > 1
          ? `VoiceMesh • ${idx + 1}/${matches.length}`
          : `VoiceMesh • match`;
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
        return { el: m.el, ringEl: ring, labelEl: label, score: m.score };
      });

      setActive(activeIdx);
      render();

      scrollHandler = () => render();
      window.addEventListener('scroll', scrollHandler, true);
      window.addEventListener('resize', scrollHandler);

      // Keep overlays glued to the elements as the page reflows (e.g. lazy-loaded content).
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
      });
      const active = overlays[activeIndex];
      if (active && active.el.scrollIntoView) {
        try {
          active.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        } catch (_) {
          active.el.scrollIntoView();
        }
      }
      render();
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
    const PANEL_ID = '__voicemesh_panel__';
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
          <strong style="font-size:13px; letter-spacing:0.02em;">VoiceMesh</strong>
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
      const top = results[0].score;
      const close = results.filter((r) => r.score >= top * 0.7);
      const toShow = close.length === 1 ? close.slice(0, 1) : close.slice(0, 3);
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
        case 'voicemesh:ping':
          sendResponse({ ok: true });
          return true;

        case 'voicemesh:search': {
          const results = Matcher.search(msg.query || '');
          if (!results.length) {
            Highlighter.clear();
            sendResponse({ ok: true, count: 0 });
            return true;
          }
          const top = results[0].score;
          const close = results.filter((r) => r.score >= top * 0.7);
          const toShow = close.length === 1 ? close.slice(0, 1) : close.slice(0, 3);
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

        case 'voicemesh:next':
          Highlighter.next();
          sendResponse({ ok: true, activeIndex: Highlighter.getActiveIndex(), count: Highlighter.getCount() });
          return true;

        case 'voicemesh:prev':
          Highlighter.prev();
          sendResponse({ ok: true, activeIndex: Highlighter.getActiveIndex(), count: Highlighter.getCount() });
          return true;

        case 'voicemesh:clear':
          Highlighter.clear();
          sendResponse({ ok: true });
          return true;

        case 'voicemesh:toggle-panel':
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
