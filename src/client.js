// copyedit overlay — runs in the page during dev.
// Toggle edit mode, click any text to edit it in place, then save the batch back to source.
//
// While edit mode is on, the page's own click/mousedown/submit handlers are suspended so
// links and buttons can be edited instead of activated. Hold Alt to click through normally.

export function init(config = {}) {
  if (typeof window === 'undefined' || window.__copyedit) return;
  const api = config.api || '/__copyedit';
  const queueFile = config.queueFile || '.copyedits.md';
  const shortcut = parseShortcut(config.shortcut || 'alt+e');
  const ATTR = 'data-ce-src';
  const STORE_KEY = 'copyedit:on';
  const TOAST_KEY = 'copyedit:toast';

  const state = {
    on: false,
    editing: null, // { el, mode, snapshot: [{node, original}], textNode? }
    pending: new Map(), // Text -> { node, before, after, owner }
    structural: [], // [{ el, before, after }]
    saving: false,
  };

  // ------------------------------------------------------------------ UI

  const host = document.createElement('copyedit-ui');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; inset: 0 auto auto 0; width: 0; height: 0;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font: 12.5px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .hover { position: fixed; pointer-events: none; border: 1.5px dashed #ff5a1f; border-radius: 3px; display: none; transition: all .06s ease-out; }
  .dock { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; color: #f4f1ea; }
  .pill { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px 7px 10px; border-radius: 999px; background: #1d1b18; color: #f4f1ea; box-shadow: 0 2px 10px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.08); user-select: none; }
  .pill:hover { background: #2a2723; }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b665d; }
  .pill.on .dot { background: #ff5a1f; box-shadow: 0 0 0 3px rgba(255,90,31,.25); }
  .pill kbd { opacity: .55; font-size: 11px; }
  .tray { width: 320px; max-height: 50vh; display: none; flex-direction: column; background: #1d1b18; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.3), inset 0 0 0 1px rgba(255,255,255,.08); overflow: hidden; }
  .tray.show { display: flex; }
  .tray header { display: flex; align-items: center; justify-content: space-between; padding: 9px 10px 9px 12px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .tray header b { font-weight: 600; }
  .list { overflow: auto; }
  .item { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 8px 10px 8px 12px; border-bottom: 1px solid rgba(255,255,255,.06); cursor: pointer; }
  .item:hover { background: rgba(255,255,255,.04); }
  .item .b { color: #a49e93; text-decoration: line-through; text-decoration-color: rgba(255,90,31,.6); word-break: break-word; }
  .item .a { color: #f4f1ea; word-break: break-word; }
  .item .w { grid-column: 1; color: #77726a; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .x { grid-row: 1 / span 3; grid-column: 2; align-self: start; all: unset; cursor: pointer; color: #77726a; padding: 0 4px; font-size: 14px; }
  .item .x:hover { color: #f4f1ea; }
  .btn { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 6px; background: rgba(255,255,255,.08); color: #f4f1ea; }
  .btn:hover { background: rgba(255,255,255,.14); }
  .btn.primary { background: #ff5a1f; color: #1d1b18; font-weight: 600; }
  .btn.primary:hover { background: #ff7442; }
  .btn[disabled] { opacity: .5; pointer-events: none; }
  .actions { display: flex; gap: 6px; }
  .toast { max-width: 320px; padding: 9px 12px; border-radius: 10px; background: #1d1b18; box-shadow: 0 6px 24px rgba(0,0,0,.3), inset 0 0 0 1px rgba(255,255,255,.08); display: none; }
  .toast.show { display: block; }
  .toast .row { display: flex; gap: 6px; margin-top: 7px; }
  .toast code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #ffb28f; }
  .pop { position: fixed; display: none; gap: 6px; align-items: center; padding: 6px; border-radius: 9px; background: #1d1b18; box-shadow: 0 6px 24px rgba(0,0,0,.3), inset 0 0 0 1px rgba(255,255,255,.08); }
  .pop.show { display: flex; }
  .pop input { all: unset; min-width: 180px; padding: 5px 8px; border-radius: 6px; background: #f4f1ea; color: #1d1b18; }
  .pop span { color: #a49e93; font-size: 11px; padding-right: 4px; }
</style>
<div class="hover"></div>
<div class="pop"><input spellcheck="true" /><span>↵ save · esc</span></div>
<div class="dock">
  <div class="toast"></div>
  <div class="tray">
    <header><b class="count"></b><div class="actions"><button class="btn discard">Discard</button><button class="btn primary save">Save to source</button></div></header>
    <div class="list"></div>
  </div>
  <button class="pill" title="Toggle copy editing (${shortcut.label})"><span class="dot"></span><span class="label">Edit copy</span><kbd>${shortcut.label}</kbd></button>
</div>`;
  const $ = (s) => shadow.querySelector(s);
  const ui = {
    hover: $('.hover'), pill: $('.pill'), label: $('.pill .label'), tray: $('.tray'), list: $('.list'),
    count: $('.count'), save: $('.save'), discard: $('.discard'), toast: $('.toast'), pop: $('.pop'), popInput: $('.pop input'),
  };

  const pageStyle = document.createElement('style');
  pageStyle.textContent = `
html[data-ce-on] body, html[data-ce-on] body * { cursor: text !important; }
[data-ce-editing] { outline: 2px solid #ff5a1f !important; outline-offset: 2px !important; border-radius: 2px; }
[data-ce-editing]:focus { outline: 2px solid #ff5a1f !important; }
[data-ce-changed] { text-decoration: underline wavy rgba(255, 90, 31, .7) !important; text-decoration-skip-ink: none !important; text-underline-offset: 3px !important; }
`;

  function mount() {
    document.documentElement.appendChild(host);
    document.head.appendChild(pageStyle);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // ------------------------------------------------------------- helpers

  const inUI = (e) => e.composedPath().includes(host);
  const supportsPlaintext = (() => {
    const d = document.createElement('div');
    try { d.contentEditable = 'plaintext-only'; } catch {}
    return d.contentEditable === 'plaintext-only';
  })();

  function directTextNodes(el) {
    return [...el.childNodes].filter((n) => n.nodeType === 3 && n.data.trim());
  }

  function candidateFor(target) {
    let el = target instanceof Element ? target : target?.parentElement;
    if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return null;
    if (el.closest('svg, input, textarea, select, [contenteditable]:not([data-ce-editing])')) return null;
    // Prefer the element that directly holds text; climb a little through wrappers.
    for (let i = 0; i < 3 && el && !directTextNodes(el).length; i++) {
      const kids = [...el.children].filter((k) => k.textContent.trim());
      el = kids.length === 1 ? kids[0] : null;
    }
    return el instanceof HTMLElement && directTextNodes(el).length ? el : null;
  }

  function needsPopover(el) {
    if (el.closest('button, summary, select, option')) return true;
    try { return getComputedStyle(el).userSelect === 'none'; } catch { return false; }
  }

  const ownerOf = (node) => node.parentElement;
  const root = (config.root || '').replace(/\/$/, '');
  // Our own stamp (JSX, HTML), or Astro's built-in dev attributes. Astro's loc points just
  // past the opening tag rather than at '<', so the server is told which convention applies.
  function locInfo(el) {
    const found = el?.closest(`[${ATTR}], [data-astro-source-loc]`);
    if (!found) return { loc: null };
    if (found.hasAttribute(ATTR)) return { loc: found.getAttribute(ATTR) };
    let file = found.getAttribute('data-astro-source-file') || '';
    if (root && file.startsWith(root + '/')) file = file.slice(root.length + 1);
    return { loc: `${file}:${found.getAttribute('data-astro-source-loc')}`, locMode: 'after-open-tag' };
  }
  const locOf = (el) => locInfo(el).loc;

  function headingBefore(el) {
    let found = null;
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (h === el || h.contains(el)) return null;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h; else break;
    }
    return found ? found.textContent.trim().slice(0, 120) : null;
  }

  function placeCaret(x, y, el) {
    let range = null;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    } else if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    }
    if (!range || !el.contains(range.startContainer)) return;
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ------------------------------------------------------------- editing

  function snapshot(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push({ node: n, original: n.data, parent: n.parentNode, next: n.nextSibling });
    return out;
  }

  function startInline(el, point) {
    const prev = { ce: el.getAttribute('contenteditable'), draggable: el.getAttribute('draggable'), spellcheck: el.getAttribute('spellcheck') };
    state.editing = { el, mode: 'inline', snapshot: snapshot(el), prev, blocks: new Set(el.querySelectorAll('br, div, p')) };
    el.setAttribute('data-ce-editing', '');
    el.contentEditable = supportsPlaintext ? 'plaintext-only' : 'true';
    el.setAttribute('draggable', 'false');
    el.spellcheck = true;
    el.focus({ preventScroll: true });
    hideHover();
  }

  function startPopover(el) {
    const nodes = directTextNodes(el);
    const textNode = nodes.sort((a, b) => b.data.trim().length - a.data.trim().length)[0];
    if (!textNode) return;
    state.editing = { el, mode: 'popover', textNode, snapshot: snapshot(el), blocks: new Set(el.querySelectorAll('br, div, p')) };
    el.setAttribute('data-ce-editing', '');
    const r = el.getBoundingClientRect();
    ui.pop.classList.add('show');
    const top = r.bottom + 8 + 40 > innerHeight ? r.top - 48 : r.bottom + 8;
    ui.pop.style.top = `${Math.max(8, top)}px`;
    ui.pop.style.left = `${Math.min(Math.max(8, r.left), innerWidth - 300)}px`;
    const lead = textNode.data.match(/^\s*/)[0];
    const trail = textNode.data.match(/\s*$/)[0];
    ui.popInput.value = textNode.data.trim();
    ui.popInput.oninput = () => { textNode.data = lead + ui.popInput.value + trail; };
    ui.popInput.focus();
    ui.popInput.select();
    hideHover();
  }

  function endEditing(revert = false) {
    const ed = state.editing;
    if (!ed) return;
    state.editing = null;
    const { el } = ed;
    if (revert) {
      for (const s of ed.snapshot) {
        s.node.data = s.original;
        if (!s.node.isConnected && s.parent?.isConnected) s.parent.insertBefore(s.node, s.next?.parentNode === s.parent ? s.next : null);
      }
    }
    el.removeAttribute('data-ce-editing');
    if (ed.mode === 'inline') {
      if (ed.prev.ce == null) el.removeAttribute('contenteditable'); else el.setAttribute('contenteditable', ed.prev.ce);
      if (ed.prev.draggable == null) el.removeAttribute('draggable'); else el.setAttribute('draggable', ed.prev.draggable);
      if (ed.prev.spellcheck == null) el.removeAttribute('spellcheck'); else el.setAttribute('spellcheck', ed.prev.spellcheck);
      if (el.contains(document.activeElement) || document.activeElement === el) el.blur();
    } else {
      ui.pop.classList.remove('show');
      ui.popInput.oninput = null;
    }
    if (!revert) record(ed);
  }

  function record(ed) {
    const known = new Set(ed.snapshot.map((s) => s.node));
    const added = [];
    const w = document.createTreeWalker(ed.el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (!known.has(n) && n.data.trim()) added.push(n);
    const lost = ed.snapshot.filter((s) => !s.node.isConnected && s.original.trim());

    // Browsers sometimes swap a text node out when you delete all of it and retype.
    if (lost.length === 1 && added.length === 1 && lost[0].parent === added[0].parentNode) {
      const s = lost[0];
      const n = added.pop();
      s.parent.replaceChild(s.node, n);
      s.node.data = n.data;
      lost.length = 0;
    }
    const elementsAdded = [...ed.el.querySelectorAll('br, div, p')].some((x) => !ed.blocks.has(x));
    if (added.length || lost.length || elementsAdded) {
      const before = ed.snapshot.map((s) => s.original).join('');
      const after = ed.el.textContent;
      if (before !== after) state.structural.push({ el: ed.el, before, after });
      ed.el.setAttribute('data-ce-changed', '');
      render();
      return;
    }
    for (const s of ed.snapshot) {
      if (s.node.data === s.original) continue;
      const prev = state.pending.get(s.node);
      const before = prev ? prev.before : s.original;
      const owner = ownerOf(s.node);
      if (s.node.data === before) {
        state.pending.delete(s.node);
        if (owner && ![...state.pending.values()].some((p) => p.owner === owner)) owner.removeAttribute('data-ce-changed');
      } else {
        state.pending.set(s.node, { node: s.node, before, after: s.node.data, owner });
        owner?.setAttribute('data-ce-changed', '');
      }
    }
    render();
  }

  // ------------------------------------------------------------- events

  function onPointerDown(e) {
    if (!state.on || inUI(e) || e.altKey || e.button !== 0) return;
    const ed = state.editing;
    if (ed?.mode === 'inline' && ed.el.contains(e.target)) { e.stopPropagation(); return; }
    e.stopPropagation();
    if (ed) endEditing(false);
    const el = candidateFor(e.target);
    if (!el) { e.preventDefault(); return; }
    if (needsPopover(el)) { e.preventDefault(); startPopover(el); return; }
    // Make it editable before the browser's default mousedown runs, so the caret lands where you clicked.
    startInline(el);
  }

  function swallow(e) {
    if (!state.on || inUI(e) || e.altKey) return;
    const insideInline = state.editing?.mode === 'inline' && state.editing.el.contains(e.target);
    if (e.type === 'click' && insideInline) {
      // The browser normally drops the caret where you clicked; if it didn't (some links), do it.
      const sel = getSelection();
      if (!sel.rangeCount || !state.editing.el.contains(sel.anchorNode)) placeCaret(e.clientX, e.clientY, state.editing.el);
    }
    if (e.type === 'click' || e.type === 'auxclick' || e.type === 'dblclick' || e.type === 'submit' || e.type === 'contextmenu') {
      // Let double-click select words inside the element being edited; block everything else.
      if (!(insideInline && (e.type === 'dblclick' || e.type === 'contextmenu'))) e.preventDefault();
    }
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    if (matches(e, shortcut)) { e.preventDefault(); e.stopPropagation(); setOn(!state.on); return; }
    if (inUI(e) && e.target === ui.popInput) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); endEditing(false); }
      else if (e.key === 'Escape') { e.preventDefault(); endEditing(true); }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && (state.on || pendingCount())) {
      if (state.editing) endEditing(false);
      if (pendingCount()) { e.preventDefault(); e.stopPropagation(); save(); }
      return;
    }
    if (!state.on) return;
    const ed = state.editing;
    if (ed?.mode === 'inline') {
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); endEditing(false); }
      else if (e.key === 'Escape') { e.preventDefault(); endEditing(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOn(false); }
  }

  function guardKeys(e) {
    if (state.on && state.editing?.mode === 'inline' && !inUI(e)) { e.stopPropagation(); e.stopImmediatePropagation(); }
  }

  function onBeforeInput(e) {
    const ed = state.editing;
    if (!ed || ed.mode !== 'inline' || !ed.el.contains(e.target)) return;
    const t = e.inputType || '';
    if (t === 'insertParagraph' || t === 'insertLineBreak' || t.startsWith('format') || t === 'insertFromDrop' || t === 'deleteByDrag') e.preventDefault();
  }

  function onPaste(e) {
    const ed = state.editing;
    if (!ed || ed.mode !== 'inline' || !ed.el.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ');
    document.execCommand('insertText', false, text);
  }

  function onFocusOut(e) {
    const ed = state.editing;
    if (!ed) return;
    if (ed.mode === 'inline' && e.target === ed.el && !ed.el.contains(e.relatedTarget)) endEditing(false);
  }

  ui.popInput.addEventListener('blur', () => { if (state.editing?.mode === 'popover') endEditing(false); });

  let hoverEl = null;
  function onMove(e) {
    if (!state.on || state.editing?.mode === 'popover') return;
    if (inUI(e) || e.altKey) return hideHover();
    const el = candidateFor(e.target);
    if (el === state.editing?.el) return hideHover();
    if (el !== hoverEl) { hoverEl = el; positionHover(); }
  }
  function positionHover() {
    if (!hoverEl || !hoverEl.isConnected) return hideHover();
    const r = hoverEl.getBoundingClientRect();
    Object.assign(ui.hover.style, { display: 'block', top: `${r.top - 3}px`, left: `${r.left - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  }
  function hideHover() { hoverEl = null; ui.hover.style.display = 'none'; }

  const opts = { capture: true };
  for (const t of ['pointerdown']) window.addEventListener(t, onPointerDown, opts);
  for (const t of ['mousedown', 'mouseup', 'pointerup', 'click', 'auxclick', 'dblclick', 'submit', 'touchstart', 'touchend', 'contextmenu']) window.addEventListener(t, swallow, opts);
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener('keyup', guardKeys, opts);
  window.addEventListener('keypress', guardKeys, opts);
  document.addEventListener('beforeinput', onBeforeInput, opts);
  document.addEventListener('paste', onPaste, opts);
  document.addEventListener('focusout', onFocusOut, opts);
  window.addEventListener('mousemove', onMove, { capture: true, passive: true });
  window.addEventListener('scroll', () => { if (hoverEl) positionHover(); if (state.editing?.mode === 'popover') endEditing(false); }, { capture: true, passive: true });

  // ------------------------------------------------------------- mode + tray

  function setOn(on) {
    if (!on && state.editing) endEditing(false);
    state.on = on;
    try { on ? sessionStorage.setItem(STORE_KEY, '1') : sessionStorage.removeItem(STORE_KEY); } catch {}
    document.documentElement.toggleAttribute('data-ce-on', on);
    ui.pill.classList.toggle('on', on);
    ui.label.textContent = on ? 'Editing copy' : 'Edit copy';
    if (!on) hideHover();
  }

  ui.pill.addEventListener('click', () => setOn(!state.on));
  ui.save.addEventListener('click', () => save());
  ui.discard.addEventListener('click', () => discardAll());

  const pendingCount = () => state.pending.size + state.structural.length;

  function items() {
    return [
      ...[...state.pending.values()].map((p) => ({ ...p, kind: 'text', el: p.owner })),
      ...state.structural.map((s) => ({ ...s, kind: 'structure', owner: s.el, ref: s })),
    ];
  }

  function render() {
    const list = items();
    ui.tray.classList.toggle('show', list.length > 0);
    ui.count.textContent = `${list.length} change${list.length === 1 ? '' : 's'}`;
    ui.list.textContent = '';
    for (const it of list) {
      const row = document.createElement('div');
      row.className = 'item';
      const b = document.createElement('div'); b.className = 'b'; b.textContent = clip(it.before.trim());
      const a = document.createElement('div'); a.className = 'a'; a.textContent = clip(it.after.trim()) || '(empty)';
      const w = document.createElement('div'); w.className = 'w'; w.textContent = locOf(it.owner) || 'no source location';
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Undo this change';
      x.onclick = (ev) => { ev.stopPropagation(); undo(it); };
      row.onclick = () => { it.owner?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
      row.append(b, x, a, w);
      ui.list.append(row);
    }
  }

  function undo(it) {
    if (it.kind === 'text') {
      it.node.data = it.before;
      state.pending.delete(it.node);
    } else {
      state.structural = state.structural.filter((s) => s !== it.ref);
    }
    if (it.owner && !items().some((o) => o.owner === it.owner)) it.owner.removeAttribute('data-ce-changed');
    render();
  }

  function discardAll() {
    if (state.editing) endEditing(true);
    for (const it of items()) if (it.kind === 'text') undo(it);
    if (state.structural.length) {
      // Structural edits can't be cleanly reverted in place; reload to restore the page.
      state.structural = [];
      location.reload();
      return;
    }
    render();
  }

  async function save() {
    if (state.saving) return;
    if (state.editing) endEditing(false);
    const list = items();
    if (!list.length) return;
    state.saving = true;
    ui.save.setAttribute('disabled', '');
    ui.save.textContent = 'Saving…';
    const edits = list.map((it, i) => ({
      id: i,
      kind: it.kind,
      ...locInfo(it.owner),
      before: it.before,
      after: it.after,
      context: { tag: it.owner?.tagName.toLowerCase(), heading: it.owner && headingBefore(it.owner), text: it.owner?.textContent.trim().slice(0, 300) },
    }));
    try {
      const res = await fetch(`${api}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edits, page: location.href }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      const done = new Set(data.results.filter((r) => r.status !== 'error').map((r) => r.id));
      list.forEach((it, i) => {
        if (!done.has(i)) return;
        if (it.kind === 'text') state.pending.delete(it.node);
        else state.structural = state.structural.filter((s) => s !== it.ref);
        it.owner?.removeAttribute('data-ce-changed');
      });
      const applied = data.results.filter((r) => r.status === 'applied');
      const queued = data.results.filter((r) => r.status === 'queued');
      const files = [...new Set(applied.map((r) => r.file))];
      toast({ applied: applied.length, files, queued: queued.length, queueFile: data.queueFile || queueFile });
    } catch (err) {
      toast({ error: String(err.message || err) });
    } finally {
      state.saving = false;
      ui.save.removeAttribute('disabled');
      ui.save.textContent = 'Save to source';
      render();
    }
  }

  let toastTimer;
  function toast(t, persist = true) {
    if (persist) { try { sessionStorage.setItem(TOAST_KEY, JSON.stringify({ ...t, at: Date.now() })); } catch {} }
    const el = ui.toast;
    el.textContent = '';
    if (t.error) {
      el.textContent = `Couldn't save: ${t.error}`;
    } else {
      const parts = [];
      if (t.applied) parts.push(`Saved ${t.applied} edit${t.applied === 1 ? '' : 's'} to ${t.files.join(', ')}`);
      if (t.queued) parts.push(`${t.queued} couldn't be matched to a literal and went to `);
      const p = document.createElement('div');
      p.textContent = parts.join('. ');
      if (t.queued) {
        const c = document.createElement('code'); c.textContent = t.queueFile;
        p.append(c, document.createTextNode(' for your agent.'));
        const row = document.createElement('div'); row.className = 'row';
        const copy = document.createElement('button'); copy.className = 'btn'; copy.textContent = 'Copy agent prompt';
        copy.onclick = () => {
          navigator.clipboard?.writeText(`Apply the pending copy edits in ${t.queueFile}: for each one, find the source that renders that text (follow props and data through from the given location), change it, then delete that edit's section from the file.`);
          copy.textContent = 'Copied';
        };
        row.append(copy);
        el.append(p, row);
      } else {
        el.append(p);
      }
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), t.queued || t.error ? 12000 : 4000);
  }

  // ------------------------------------------------------------- boot

  try {
    if (sessionStorage.getItem(STORE_KEY)) setOn(true);
    const last = JSON.parse(sessionStorage.getItem(TOAST_KEY) || 'null');
    if (last && Date.now() - last.at < 6000) toast(last, false);
    sessionStorage.removeItem(TOAST_KEY);
  } catch {}

  window.__copyedit = { setOn, save, state };
}

function parseShortcut(s) {
  const parts = s.toLowerCase().split('+').map((p) => p.trim());
  const key = parts.pop();
  const mac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const names = { alt: mac ? '⌥' : 'Alt+', shift: mac ? '⇧' : 'Shift+', ctrl: mac ? '⌃' : 'Ctrl+', meta: mac ? '⌘' : 'Meta+' };
  return {
    alt: parts.includes('alt'), shift: parts.includes('shift'), ctrl: parts.includes('ctrl'), meta: parts.includes('meta') || parts.includes('cmd'),
    key, label: parts.map((p) => names[p === 'cmd' ? 'meta' : p] || '').join('') + key.toUpperCase(),
  };
}

function matches(e, s) {
  const code = (e.code || '').toLowerCase();
  const keyHit = code === `key${s.key}` || code === `digit${s.key}` || (e.key || '').toLowerCase() === s.key;
  return keyHit && e.altKey === s.alt && e.shiftKey === s.shift && e.ctrlKey === s.ctrl && e.metaKey === s.meta;
}

function clip(s, n = 140) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
