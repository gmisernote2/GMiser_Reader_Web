// The reading screen — web port of ReaderScreen.kt + ChaptersPanel.kt + SettingsPanel.kt.
// The whole book is one flat list of block elements in normal document flow and the *window*
// scrolls (native iOS momentum, status-bar-tap-to-top, keyboard scrolling all for free).
// Position = (block index, px offset into that block) — same model as LazyListState on Android.

import * as db from "./db.js";
import { parseBook, plainText, searchBlocks, chapterRange } from "./book.js";
import { h, icon, iconButton, toast, promptDialog, choiceDialog, formatDate } from "./ui.js";
import {
  settings, update, onChange, applyToDocument,
  FONTS, SKINS, POSITION_MODES, BRIGHTNESS_MODES, TTS_LANGUAGES, LIMITS,
} from "./settings.js";
import { createTts } from "./tts.js";
import { buildBundle, bookFile, shareOrDownload } from "./library.js";
import { APP_VERSION } from "./version.js";

const OVERLAY_AUTO_HIDE_MS = 3000;
const SAVE_DEBOUNCE_MS = 500;
const BOOKMARK_LABEL_MAX = 60;
const SCROLL_END_MS = 160;
const SELECTION_SETTLE_MS = 250;

export async function openReader(root, bookId, { onExit }) {
  const book = await db.get("books", bookId);
  if (!book) throw new Error("Libro no encontrado");
  const { blocks, toc, isEpub } = await parseBook(book.type, new Uint8Array(book.data));
  const sortMarks = (list) => list.sort((a, b) => a.blockIndex - b.blockIndex || a.offset - b.offset);
  const sortHls = (list) => list.sort((a, b) => a.blockIndex - b.blockIndex || a.startOffset - b.startOffset);
  let bookmarks = sortMarks(await db.byBook("bookmarks", bookId));
  let highlights = sortHls(await db.byBook("highlights", bookId));
  const savedProgress = await db.get("progress", bookId);
  if (book.totalBlocks !== blocks.length) await db.put("books", { ...book, totalBlocks: blocks.length });

  let exited = false;
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  const objectUrls = [];

  // ---------- blocks ----------
  const contentEl = h("main", { class: "content", lang: "es" });
  const els = new Array(blocks.length);
  const txs = new Array(blocks.length);
  const hlByBlock = () => {
    const m = new Map();
    for (const x of highlights) (m.get(x.blockIndex) || m.set(x.blockIndex, []).get(x.blockIndex)).push(x);
    return m;
  };

  function fillText(i, hls) {
    const b = blocks[i];
    const tx = txs[i];
    if (!tx) return;
    const len = b.t.length;
    const clamp = (v) => Math.max(0, Math.min(len, v));
    const edges = new Set([0, len]);
    for (const [s, e] of b.s) { edges.add(s); edges.add(e); }
    for (const x of hls || []) { edges.add(clamp(x.startOffset)); edges.add(clamp(x.endOffset)); }
    const cuts = [...edges].sort((a, z) => a - z);
    const parts = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k], z = cuts[k + 1];
      if (a >= z) continue;
      const cls = [];
      for (const [s, e, st] of b.s) if (s <= a && e >= z && !cls.includes(st)) cls.push(st);
      if ((hls || []).some((x) => clamp(x.startOffset) <= a && clamp(x.endOffset) >= z)) cls.push("hl");
      const text = b.t.slice(a, z);
      parts.push(cls.length ? h("span", { class: cls.join(" ") }, text) : document.createTextNode(text));
    }
    tx.replaceChildren(...parts);
  }

  function renderAll() {
    const frag = document.createDocumentFragment();
    const hls = hlByBlock();
    blocks.forEach((b, i) => {
      let el;
      if (b.k === "img") {
        const url = URL.createObjectURL(new Blob([b.img], { type: b.mime }));
        objectUrls.push(url);
        el = h("figure", { class: "blk b-img" }, h("img", { src: url, alt: "", loading: "lazy", decoding: "async" }));
      } else if (b.k === "li") {
        txs[i] = h("div", { class: "tx" });
        el = h("div", { class: "blk b-li" }, h("span", { class: "mk", "aria-hidden": "true" }, b.m), txs[i]);
      } else {
        const tag = b.k === "h" ? `h${Math.min(6, b.l)}` : b.k === "q" ? "blockquote" : "p";
        el = h(tag, { class: `blk b-${b.k} tx` });
        txs[i] = el;
      }
      el.dataset.i = i;
      els[i] = el;
      if (txs[i]) fillText(i, hls.get(i));
      frag.append(el);
    });
    contentEl.append(frag);
  }

  // ---------- position ----------
  const topOf = (i) => els[i].getBoundingClientRect().top + window.scrollY;
  const bottomOf = (i) => els[i].getBoundingClientRect().bottom + window.scrollY;

  /** First block whose bottom edge is below the viewport top (LazyListState.firstVisibleItemIndex). */
  function currentPosition() {
    if (!blocks.length) return { index: 0, offset: 0 };
    const y = window.scrollY;
    let lo = 0, hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bottomOf(mid) > y) hi = mid; else lo = mid + 1;
    }
    return { index: lo, offset: Math.max(0, Math.round(y - topOf(lo))) };
  }

  function scrollToBlock(index, offset = 0, smooth = false) {
    if (!blocks.length) return;
    const i = Math.max(0, Math.min(blocks.length - 1, index));
    window.scrollTo({ top: Math.max(0, topOf(i) + offset), behavior: smooth ? "smooth" : "instant" });
  }

  let pos = { index: 0, offset: 0 };
  let saveTimer = null;
  function saveProgressNow() {
    clearTimeout(saveTimer);
    if (!restored) return;
    return db.put("progress", {
      bookId, displayTitle: book.title,
      lastBlockIndex: pos.index, lastOffset: pos.offset, lastOpenedAt: Date.now(),
    }).catch(() => {});
  }

  // ---------- chrome ----------
  const topBar = h("div", { class: "bar top-bar" },
    iconButton("back", "Volver a la biblioteca", () => exit()),
    h("div", { class: "bar-title" }, book.title),
    iconButton("list", "Capítulos", () => openPanel("chapters")),
    iconButton("bookmark", "Marcadores", () => openPanel("bookmarks")),
    iconButton("bookmarkAdd", "Añadir marcador", () => addBookmarkHere()));
  const ttsPlayBtn = iconButton("play", "Leer en voz alta", () => toggleTts());
  const ttsStopBtn = iconButton("stop", "Detener lectura", () => tts.stop(), "hidden");
  const bottomBar = h("div", { class: "bar bottom-bar" },
    iconButton("settings", "Ajustes", () => openSettings()),
    iconButton("share", "Compartir", () => share()),
    h("div", { class: "spacer" }),
    ttsStopBtn, ttsPlayBtn);

  let overlayVisible = false;
  let overlayTimer = null;
  function setOverlay(v) {
    overlayVisible = v;
    topBar.classList.toggle("show", v);
    bottomBar.classList.toggle("show", v);
    clearTimeout(overlayTimer);
    if (v) overlayTimer = setTimeout(() => setOverlay(false), OVERLAY_AUTO_HIDE_MS);
    refreshIndicator();
  }

  // ---------- position indicator ----------
  const indTitle = h("span", { class: "ind-title" });
  const indPct = h("span", { class: "ind-pct" });
  const barPrimary = scrubBar((f) => scrubTo(f, false));
  const barSecondary = scrubBar((f) => scrubTo(f, true), true);
  const indicator = h("div", { class: "indicator" },
    h("div", { class: "ind-row" }, indTitle, indPct), barPrimary.el, barSecondary.el);

  let scrolling = false;
  let scrubbing = false;
  let lingerUntil = 0;
  let lingerTimer = null;

  function scrubBar(onFraction, secondary = false) {
    const fill = h("div", { class: "fill" });
    const el = h("div", { class: `scrub ${secondary ? "secondary" : ""}` }, h("div", { class: "track" }, fill));
    const fractionAt = (e) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      scrubbing = true;
      onFraction(fractionAt(e));
    });
    el.addEventListener("pointermove", (e) => { if (scrubbing && el.hasPointerCapture(e.pointerId)) onFraction(fractionAt(e)); });
    const end = () => { scrubbing = false; lingerAfterScroll(); };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    return { el, set: (f) => { fill.style.width = `${(f * 100).toFixed(2)}%`; } };
  }

  const currentChapter = () => {
    let c = -1;
    for (let k = 0; k < toc.length; k++) if (toc[k].blockIndex <= pos.index) c = k;
    return c;
  };
  const lastIndex = () => Math.max(0, blocks.length - 1);

  function fractions() {
    const bookF = blocks.length > 1 ? pos.index / (blocks.length - 1) : 0;
    const range = chapterRange(toc, currentChapter(), blocks.length);
    const chapF = range ? Math.max(0, Math.min(1, (pos.index - range[0]) / Math.max(1, range[1] - range[0]))) : bookF;
    const mode = settings().positionIndicatorMode;
    return { bookF, primary: mode === "BOOK" ? bookF : chapF, range };
  }

  function scrubTo(f, bookWide) {
    const { range } = fractions();
    let target;
    if (bookWide || settings().positionIndicatorMode === "BOOK" || !range) target = Math.round(f * lastIndex());
    else target = range[0] + Math.round(f * Math.max(1, range[1] - range[0]));
    scrollToBlock(target, 0);
  }

  function lingerAfterScroll() {
    const s = settings();
    lingerUntil = Date.now() + s.positionIndicatorAutoHideSeconds * 1000;
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(refreshIndicator, s.positionIndicatorAutoHideSeconds * 1000 + 20);
    refreshIndicator();
  }

  function refreshIndicator() {
    const s = settings();
    const always = s.positionIndicatorAutoHideSeconds === LIMITS.ALWAYS_VISIBLE;
    const visible = s.positionIndicatorEnabled && !panelOpen && !sheetOpen &&
      (always || scrolling || overlayVisible || scrubbing || Date.now() < lingerUntil);
    indicator.classList.toggle("show", visible);
    if (!visible) return;
    const { bookF, primary } = fractions();
    const c = currentChapter();
    indTitle.textContent = c >= 0 ? `${c + 1}/${toc.length}. ${toc[c].title}` : "";
    indPct.textContent = `${Math.round(primary * 100)}%`;
    barPrimary.set(primary);
    const both = s.positionIndicatorMode === "BOTH";
    barSecondary.el.classList.toggle("hidden", !both);
    if (both) barSecondary.set(bookF);
  }

  // ---------- brightness (dimming layer — the web can't drive the backlight) ----------
  const dimEl = h("div", { class: "dim" });
  const brightPopup = h("div", { class: "bright-popup" },
    h("div", { class: "bp-pct" }), h("div", { class: "bp-track" }, h("div", { class: "bp-fill" })));
  let brightTimer = null;
  function applyBrightness(showPopup) {
    const s = settings();
    const b = s.screenBrightness;
    dimEl.style.opacity = s.screenBrightnessMode === "OFF" ? "0" : String((1 - b) * 0.8);
    zoneLeft.classList.toggle("hidden", s.screenBrightnessMode !== "GESTURE_LEFT");
    zoneRight.classList.toggle("hidden", s.screenBrightnessMode !== "GESTURE_RIGHT");
    if (showPopup) {
      brightPopup.querySelector(".bp-pct").textContent = `${Math.round(b * 100)}%`;
      brightPopup.querySelector(".bp-fill").style.width = `${((b - LIMITS.MIN_BRIGHTNESS) / (1 - LIMITS.MIN_BRIGHTNESS)) * 100}%`;
      brightPopup.classList.add("show");
      clearTimeout(brightTimer);
      brightTimer = setTimeout(() => brightPopup.classList.remove("show"), 1500);
    }
  }
  function gestureZone(side) {
    const zone = h("div", { class: `bright-zone ${side}` });
    let startY = 0, startB = 1, active = false;
    zone.addEventListener("pointerdown", (e) => {
      active = true; startY = e.clientY; startB = settings().screenBrightness;
      zone.setPointerCapture(e.pointerId);
    });
    zone.addEventListener("pointermove", (e) => {
      if (!active) return;
      const b = Math.max(LIMITS.MIN_BRIGHTNESS, Math.min(1, startB - (e.clientY - startY) / zone.clientHeight));
      update({ screenBrightness: Math.round(b * 100) / 100 });
    });
    const end = () => { active = false; };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
    return zone;
  }
  const zoneLeft = gestureZone("left");
  const zoneRight = gestureZone("right");

  // ---------- side panel: chapters / bookmarks / search / highlights ----------
  let panelOpen = false;
  let panelTab = "chapters";
  const panelBody = h("div", { class: "panel-body" });
  const tabs = [
    ["chapters", "Capítulos"], ["bookmarks", "Marcadores"], ["search", "Buscar"], ["highlights", "Resaltados"],
  ].map(([id, label]) => h("button", { class: "tab", "data-tab": id, onclick: () => { panelTab = id; renderPanel(); } }, label));
  const panel = h("aside", { class: "panel", "aria-label": "Índice y marcadores" },
    h("div", { class: "panel-head" }, iconButton("back", "Cerrar panel", () => closePanel()), h("div", { class: "tabs" }, tabs)),
    panelBody);
  const panelScrim = h("div", { class: "scrim", onclick: () => closePanel() });

  let searchQuery = "";
  let searchScope = "BOOK";
  let searchTimer = null;

  function openPanel(tab) {
    panelTab = tab;
    panelOpen = true;
    setOverlay(false);
    panel.classList.add("show");
    panelScrim.classList.add("show");
    renderPanel();
    refreshIndicator();
  }
  function closePanel() {
    panelOpen = false;
    panel.classList.remove("show");
    panelScrim.classList.remove("show");
    refreshIndicator();
  }
  const jump = (index, offset = 0) => { closePanel(); requestAnimationFrame(() => scrollToBlock(index, offset, true)); };

  function renderPanel() {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === panelTab));
    const body = [];
    if (panelTab === "chapters") {
      if (!toc.length) {
        body.push(h("p", { class: "empty" }, isEpub ? "Este libro no tiene índice de capítulos." : "Los archivos TXT no tienen capítulos."));
      } else {
        const cur = currentChapter();
        body.push(h("ul", { class: "rows" }, toc.map((t, k) =>
          h("li", null, h("button", { class: `row ${k === cur ? "current" : ""}`, onclick: () => jump(t.blockIndex) },
            h("span", { class: "row-main" }, t.title || `Capítulo ${k + 1}`))))));
      }
    } else if (panelTab === "bookmarks") {
      body.push(h("button", { class: "pill-btn", onclick: () => addBookmarkHere() }, icon("bookmarkAdd", 20), "Añadir marcador aquí"));
      if (!bookmarks.length) body.push(h("p", { class: "empty" }, "Aún no hay marcadores en este libro."));
      body.push(h("ul", { class: "rows" }, bookmarks.map((b) =>
        h("li", { class: "row-wrap" },
          h("button", { class: "row", onclick: () => jump(b.blockIndex, b.offset) },
            h("span", { class: "row-main" }, b.title || b.label || "Marcador"),
            h("span", { class: "row-sub" }, (b.title ? `${b.label} · ` : "") + formatDate(b.createdAt))),
          iconButton("edit", "Renombrar marcador", () => renameBookmark(b), "row-action"),
          iconButton("delete", "Borrar marcador", () => deleteBookmark(b), "row-action")))));
    } else if (panelTab === "search") {
      const input = h("input", {
        class: "text-input", type: "search", placeholder: "Buscar en el libro…", value: searchQuery,
        autocomplete: "off", enterkeyhint: "search",
        oninput: (e) => { searchQuery = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(renderResults, 250); },
      });
      body.push(input);
      if (toc.length) {
        body.push(h("div", { class: "chips" },
          [["CHAPTER", "Este capítulo"], ["BOOK", "Todo el libro"]].map(([id, label]) =>
            h("button", { class: `chip ${searchScope === id ? "on" : ""}`, onclick: () => { searchScope = id; renderPanel(); } }, label))));
      }
      const resultsEl = h("div", { class: "results" });
      body.push(resultsEl);
      const renderResults = () => {
        const range = searchScope === "CHAPTER" ? chapterRange(toc, currentChapter(), blocks.length) : null;
        const results = searchBlocks(blocks, searchQuery, range);
        resultsEl.replaceChildren(
          searchQuery.trim() ? h("p", { class: "count" }, `${results.length} resultado${results.length === 1 ? "" : "s"}`) : "",
          h("ul", { class: "rows" }, results.slice(0, 500).map((r) =>
            h("li", null, h("button", { class: "row", onclick: () => jump(r.blockIndex) },
              h("span", { class: "row-sub snippet" }, r.before, h("strong", null, r.match), r.after))))));
      };
      renderResults();
      panelBody.replaceChildren(...body);
      if (!searchQuery) setTimeout(() => input.focus(), 250);
      return;
    } else if (panelTab === "highlights") {
      if (!highlights.length) body.push(h("p", { class: "empty" }, "Mantén pulsado el texto para seleccionarlo y resaltarlo."));
      body.push(h("ul", { class: "rows" }, highlights.map((x) =>
        h("li", { class: "row-wrap" },
          h("button", { class: "row", onclick: () => jump(x.blockIndex) },
            h("span", { class: "row-main hl-text" }, x.text), h("span", { class: "row-sub" }, formatDate(x.createdAt))),
          iconButton("delete", "Borrar resaltado", () => deleteHighlight(x), "row-action")))));
    }
    panelBody.replaceChildren(...body);
  }

  // ---------- bookmarks / highlights ----------
  async function addBookmarkHere() {
    const p = currentPosition();
    const label = plainText(blocks[p.index] || { k: "p", t: "" }).slice(0, BOOKMARK_LABEL_MAX);
    const rec = { bookId, blockIndex: p.index, offset: p.offset, label, title: "", createdAt: Date.now() };
    rec.id = await db.put("bookmarks", rec);
    bookmarks = sortMarks([...bookmarks, rec]);
    toast("Marcador añadido");
    if (panelOpen) renderPanel();
  }
  async function renameBookmark(b) {
    const title = await promptDialog({ title: "Título del marcador", value: b.title || "" });
    if (title == null || !title.trim()) return; // blank saves are ignored, like Android
    const rec = { ...b, title: title.trim() };
    await db.put("bookmarks", rec);
    bookmarks = sortMarks(bookmarks.map((x) => (x.id === b.id ? rec : x)));
    renderPanel();
  }
  async function deleteBookmark(b) {
    await db.del("bookmarks", b.id);
    bookmarks = bookmarks.filter((x) => x.id !== b.id);
    toast("Marcador borrado");
    renderPanel();
  }
  async function addHighlight(blockIndex, start, end) {
    const text = blocks[blockIndex].t.slice(start, end);
    const rec = { bookId, blockIndex, startOffset: start, endOffset: end, text, createdAt: Date.now() };
    rec.id = await db.put("highlights", rec);
    highlights = sortHls([...highlights, rec]);
    fillText(blockIndex, highlights.filter((x) => x.blockIndex === blockIndex));
  }
  async function deleteHighlight(x) {
    await db.del("highlights", x.id);
    highlights = highlights.filter((y) => y.id !== x.id);
    fillText(x.blockIndex, highlights.filter((y) => y.blockIndex === x.blockIndex));
    renderPanel();
  }

  // ---------- selection → highlight popup (replaces Android's long-press word popup) ----------
  let selection = null;
  const selPopup = h("div", { class: "sel-popup" },
    h("button", { onclick: () => { if (selection) addHighlight(selection.block, selection.start, selection.end); clearSelection(); } }, "Resaltar"),
    h("button", { onclick: () => {
      if (selection) window.open(`https://www.google.com/search?q=${encodeURIComponent(selection.text)}`, "_blank", "noopener");
      clearSelection();
    } }, "Buscar en Google"));
  let selTimer = null;
  let lastSelectionAt = 0;

  function clearSelection() {
    selection = null;
    selPopup.classList.remove("show");
    window.getSelection()?.removeAllRanges();
  }

  function textOffset(tx, node, offset) {
    if (!tx.contains(node)) return tx.textContent.length;
    const r = document.createRange();
    r.selectNodeContents(tx);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  function checkSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { selection = null; selPopup.classList.remove("show"); return; }
    lastSelectionAt = Date.now();
    const range = sel.getRangeAt(0);
    const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
    const tx = startEl?.closest(".tx");
    if (!tx || !contentEl.contains(tx)) { selPopup.classList.remove("show"); return; }
    const block = Number(tx.closest(".blk").dataset.i);
    const start = textOffset(tx, range.startContainer, range.startOffset);
    const end = textOffset(tx, range.endContainer, range.endOffset); // clipped to the start block
    if (end <= start) { selPopup.classList.remove("show"); return; }
    selection = { block, start, end, text: blocks[block].t.slice(start, end) };
    const rect = range.getBoundingClientRect();
    const below = rect.bottom + 64 < window.innerHeight;
    selPopup.style.top = `${below ? rect.bottom + 14 : Math.max(8, rect.top - 60)}px`;
    selPopup.style.left = `${Math.max(12, Math.min(window.innerWidth - 12, rect.left + rect.width / 2))}px`;
    selPopup.classList.add("show");
  }

  // ---------- settings sheet ----------
  let sheetOpen = false;
  const sheetBody = h("div", { class: "sheet-body" });
  const sheet = h("section", { class: "sheet", "aria-label": "Ajustes" },
    h("div", { class: "sheet-head" }, h("h2", null, "Ajustes"), iconButton("close", "Cerrar ajustes", () => closeSettings())),
    sheetBody);
  const sheetScrim = h("div", { class: "scrim", onclick: () => closeSettings() });

  function openSettings() {
    sheetOpen = true;
    setOverlay(false);
    renderSettings();
    sheet.classList.add("show");
    sheetScrim.classList.add("show");
    refreshIndicator();
  }
  function closeSettings() {
    sheetOpen = false;
    sheet.classList.remove("show");
    sheetScrim.classList.remove("show");
    refreshIndicator();
  }

  const label = (text) => h("div", { class: "section-label" }, text);
  const chips = (options, value, onPick, styleFor) => h("div", { class: "chips" }, options.map((o) =>
    h("button", { class: `chip ${o.id === value ? "on" : ""}`, style: styleFor ? styleFor(o) : null, onclick: () => onPick(o.id) }, o.name)));
  function slider({ min, max, step, value, oninput }) {
    return h("input", { type: "range", class: "slider", min, max, step, value, oninput: (e) => oninput(Number(e.target.value)) });
  }
  const toggle = (text, checked, onToggle) => h("label", { class: "switch-row" },
    h("span", null, text),
    h("input", { type: "checkbox", class: "switch", checked, onchange: (e) => onToggle(e.target.checked) }));

  function renderSettings() {
    const s = settings();
    const autohideText = s.positionIndicatorAutoHideSeconds === LIMITS.ALWAYS_VISIBLE
      ? "Ocultar barra de posición tras: nunca (siempre visible)"
      : `Ocultar barra de posición tras: ${s.positionIndicatorAutoHideSeconds}s`;
    const sizeLabel = label(`Tamaño de letra: ${s.fontSizeSp}`);
    const lineLabel = label(`Interlineado: ${s.lineSpacingMultiplier.toFixed(1)}x`);
    const brightLabel = label(`Brillo de pantalla: ${Math.round(s.screenBrightness * 100)}%`);
    const autoLabel = label(autohideText);
    sheetBody.replaceChildren(
      label("Fuente"),
      chips(FONTS, s.fontFamily, (id) => { update({ fontFamily: id }); renderSettings(); }, (o) => ({ fontFamily: o.css })),
      sizeLabel,
      slider({ min: LIMITS.MIN_FONT, max: LIMITS.MAX_FONT, step: 1, value: s.fontSizeSp,
        oninput: (v) => { update({ fontSizeSp: v }); sizeLabel.textContent = `Tamaño de letra: ${v}`; } }),
      lineLabel,
      slider({ min: LIMITS.MIN_LINE, max: LIMITS.MAX_LINE, step: 0.1, value: s.lineSpacingMultiplier,
        oninput: (v) => { update({ lineSpacingMultiplier: Math.round(v * 10) / 10 }); lineLabel.textContent = `Interlineado: ${v.toFixed(1)}x`; } }),
      label("Ajustar brillo de lectura"),
      chips(BRIGHTNESS_MODES, s.screenBrightnessMode, (id) => { update({ screenBrightnessMode: id }); renderSettings(); }),
      s.screenBrightnessMode !== "OFF" && brightLabel,
      s.screenBrightnessMode !== "OFF" && slider({ min: LIMITS.MIN_BRIGHTNESS, max: LIMITS.MAX_BRIGHTNESS, step: 0.01, value: s.screenBrightness,
        oninput: (v) => { update({ screenBrightness: v }); brightLabel.textContent = `Brillo de pantalla: ${Math.round(v * 100)}%`; } }),
      s.screenBrightnessMode !== "OFF" && h("p", { class: "hint" }, "En el iPad el brillo se simula oscureciendo la página; no puede superar el brillo del sistema."),
      label("Aspecto"),
      chips(SKINS, s.skin, (id) => { update({ skin: id }); renderSettings(); }),
      toggle("Mostrar barra de progreso", s.positionIndicatorEnabled, (v) => { update({ positionIndicatorEnabled: v }); renderSettings(); }),
      s.positionIndicatorEnabled && label("Indicador de posición"),
      s.positionIndicatorEnabled && chips(POSITION_MODES, s.positionIndicatorMode, (id) => { update({ positionIndicatorMode: id }); renderSettings(); }),
      s.positionIndicatorEnabled && autoLabel,
      s.positionIndicatorEnabled && slider({ min: LIMITS.MIN_AUTOHIDE, max: LIMITS.ALWAYS_VISIBLE, step: 1, value: s.positionIndicatorAutoHideSeconds,
        oninput: (v) => {
          update({ positionIndicatorAutoHideSeconds: v });
          autoLabel.textContent = v === LIMITS.ALWAYS_VISIBLE ? "Ocultar barra de posición tras: nunca (siempre visible)" : `Ocultar barra de posición tras: ${v}s`;
        } }),
      label("Voz para lectura en alto"),
      chips(TTS_LANGUAGES, s.ttsLanguage, (id) => { update({ ttsLanguage: id }); renderSettings(); }),
      toggle("Mantener la pantalla encendida", s.keepAwake, (v) => update({ keepAwake: v })),
      h("p", { class: "version" }, `Versión ${APP_VERSION} (web)`),
    );
  }

  // Settings side effects. Typography changes keep the current block and reset the in-block
  // offset to 0 — the same accepted trade-off as Android (CLAUDE.md §1).
  let relayoutTimer = null;
  const offSettings = onChange((s, patch) => {
    if ("fontFamily" in patch || "fontSizeSp" in patch || "lineSpacingMultiplier" in patch) {
      const keep = pos.index;
      applyToDocument(s);
      clearTimeout(relayoutTimer);
      relayoutTimer = setTimeout(async () => {
        try { await document.fonts.ready; } catch { /* ignore */ }
        scrollToBlock(keep, 0);
      }, 30);
    }
    if ("skin" in patch) applyToDocument(s);
    if ("screenBrightness" in patch || "screenBrightnessMode" in patch) applyBrightness("screenBrightness" in patch);
    if ("keepAwake" in patch) syncWakeLock();
    refreshIndicator();
  });
  cleanups.push(offSettings);

  // ---------- share ----------
  async function share() {
    setOverlay(false);
    // Build both files *before* the choice so navigator.share() runs inside the tap's own user
    // activation — iOS refuses share() once an async gap has consumed it.
    let files;
    try { files = await Promise.all([bookFile(bookId), buildBundle(bookId)]); } catch (e) { return toast(`No se pudo preparar: ${e.message}`); }
    const choice = await choiceDialog({
      title: "Compartir",
      options: [
        { value: 0, icon: "book", label: "Solo el libro", description: "El archivo original (.epub o .txt)" },
        { value: 1, icon: "bookmark", label: "Libro con mis datos", description: "Paquete .gmreader con marcadores, resaltados y progreso" },
      ],
    });
    if (choice == null) return;
    const result = await shareOrDownload(files[choice]);
    if (result === "downloaded") toast("Guardado en Descargas");
  }

  // ---------- text to speech ----------
  let ttsCurrent = null;
  const tts = createTts({
    onBlockChange: (i) => {
      if (ttsCurrent != null) els[ttsCurrent]?.classList.remove("tts-current");
      ttsCurrent = i;
      if (i == null) return;
      els[i].classList.add("tts-current");
      const r = els[i].getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) els[i].scrollIntoView({ block: "center", behavior: "smooth" });
    },
    onStateChange: (st) => {
      ttsPlayBtn.replaceChildren(icon(st === "speaking" ? "pause" : "play"));
      ttsPlayBtn.setAttribute("aria-label", st === "speaking" ? "Pausar lectura" : "Leer en voz alta");
      ttsStopBtn.classList.toggle("hidden", st === "idle");
    },
    onError: (m) => toast(m),
  });
  function toggleTts() {
    const lang = (TTS_LANGUAGES.find((l) => l.id === settings().ttsLanguage) || TTS_LANGUAGES[0]).tag;
    if (tts.state === "idle") tts.play(blocks, currentPosition().index, lang);
    else if (tts.state === "speaking") tts.pause();
    else tts.resume();
  }

  // ---------- wake lock ----------
  let wakeLock = null;
  async function syncWakeLock() {
    const want = settings().keepAwake && document.visibilityState === "visible" && !exited;
    if (want && !wakeLock && "wakeLock" in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } catch { wakeLock = null; }
    } else if (!want && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // ---------- events ----------
  let restored = false;
  let scrollEndTimer = null;
  let rafPending = false;
  listen(window, "scroll", () => {
    if (!restored) return;
    if (!scrolling) { scrolling = true; if (overlayVisible) setOverlay(false); }
    clearTimeout(scrollEndTimer);
    scrollEndTimer = setTimeout(() => { scrolling = false; lingerAfterScroll(); }, SCROLL_END_MS);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      pos = currentPosition();
      refreshIndicator();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveProgressNow, SAVE_DEBOUNCE_MS);
    });
  }, { passive: true });

  let selectionAtDown = false;
  listen(contentEl, "pointerdown", () => { selectionAtDown = !!selection || !window.getSelection()?.isCollapsed; });
  listen(contentEl, "click", (e) => {
    if (e.target.closest("a")) e.preventDefault(); // book links never navigate away
    if (selectionAtDown || Date.now() - lastSelectionAt < 400) return;
    setOverlay(!overlayVisible);
  });
  listen(document, "selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(checkSelection, SELECTION_SETTLE_MS);
  });
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // iOS may kill a backgrounded web app without any further event — save now.
      pos = currentPosition();
      saveProgressNow();
      tts.stop();
    }
    syncWakeLock();
  });
  listen(window, "pagehide", () => { pos = currentPosition(); saveProgressNow(); });
  let resizeTimer = null;
  let posBeforeResize = null;
  listen(window, "resize", () => {
    if (!posBeforeResize) posBeforeResize = pos;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { scrollToBlock(posBeforeResize.index, posBeforeResize.offset); posBeforeResize = null; }, 200);
  });
  listen(document, "keydown", (e) => {
    if (e.key === "Escape") {
      if (selection) clearSelection();
      else if (sheetOpen) closeSettings();
      else if (panelOpen) closePanel();
      else if (overlayVisible) setOverlay(false);
    }
  });

  // ---------- mount ----------
  renderAll();
  root.replaceChildren(contentEl, dimEl, zoneLeft, zoneRight, topBar, bottomBar, indicator, brightPopup,
    selPopup, panelScrim, panel, sheetScrim, sheet);
  document.body.classList.add("reading");
  applyBrightness(false);
  try { await document.fonts.ready; } catch { /* ignore */ }
  // Restore once the block list is laid out (CLAUDE.md §5: never a fixed delay).
  await new Promise((r) => requestAnimationFrame(r));
  if (savedProgress) scrollToBlock(savedProgress.lastBlockIndex, savedProgress.lastOffset);
  else window.scrollTo(0, 0);
  pos = currentPosition();
  restored = true;
  saveProgressNow();
  syncWakeLock();
  refreshIndicator();

  async function exit() {
    if (exited) return;
    pos = currentPosition();
    await saveProgressNow();
    destroy();
    onExit();
  }
  function destroy() {
    exited = true;
    tts.stop();
    syncWakeLock();
    clearTimeout(saveTimer); clearTimeout(overlayTimer); clearTimeout(lingerTimer); clearTimeout(scrollEndTimer);
    cleanups.forEach((fn) => fn());
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    document.body.classList.remove("reading");
    root.replaceChildren();
  }

  return { exit, destroy, get position() { return pos; } };
}
