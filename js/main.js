// App shell: library screen + switching into the reader. Single page, no router — like the
// Android app's single Activity.

import * as db from "./db.js";
import { addFile, deleteBook } from "./library.js";
import { openReader } from "./reader.js";
import { applyToDocument, onChange } from "./settings.js";
import { h, icon, iconButton, toast, confirmDialog } from "./ui.js";
import { APP_VERSION } from "./version.js";

const LAST_OPEN_KEY = "gmr.lastOpenBook";
const app = document.getElementById("app");
let reader = null;
let selecting = false;
let selected = new Set();
const coverUrls = [];
let reloadWhenIdle = false;

const memo = {
  get: () => { try { return localStorage.getItem(LAST_OPEN_KEY); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem(LAST_OPEN_KEY, v) : localStorage.removeItem(LAST_OPEN_KEY); } catch { /* ignore */ } },
};

// ---------- library ----------

const fileInput = h("input", {
  type: "file", multiple: true, class: "hidden",
  // No `accept`: iOS greys out .epub/.gmreader in the Files picker when it doesn't recognize the
  // type, so every file stays pickable and detection happens on our side (detectType).
  onchange: async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await addFiles(files);
  },
});
document.body.append(fileInput);

async function addFiles(files) {
  const ids = [];
  for (const f of files) {
    try {
      toast(`Abriendo ${f.name}…`);
      ids.push(await addFile(f));
    } catch (err) {
      console.error(err);
      toast(`No se pudo abrir ${f.name}: ${err.message}`);
    }
  }
  if (ids.length === 1) open(ids[0]);
  else if (ids.length) { toast(`${ids.length} libros añadidos`); renderLibrary(); }
}

async function renderLibrary() {
  coverUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const [books, progress] = await Promise.all([db.listBooks(), db.all("progress")]);
  const prog = new Map(progress.map((p) => [p.bookId, p]));
  // Most recently read first, then most recently added.
  books.sort((a, b) => (prog.get(b.bookId)?.lastOpenedAt || b.addedAt) - (prog.get(a.bookId)?.lastOpenedAt || a.addedAt));

  const header = h("header", { class: "lib-head" },
    selecting
      ? [iconButton("close", "Cancelar selección", () => { selecting = false; selected.clear(); renderLibrary(); }),
        h("h1", null, `${selected.size} seleccionado${selected.size === 1 ? "" : "s"}`),
        iconButton("delete", "Borrar seleccionados", () => deleteSelected(books), selected.size ? "" : "disabled")]
      : [h("h1", null, "Biblioteca"),
        books.length > 0 && h("button", { class: "text-btn", onclick: () => { selecting = true; renderLibrary(); } }, "Seleccionar"),
        h("button", { class: "pill-btn primary", onclick: () => fileInput.click() }, icon("folder", 20), "Abrir archivo…")]);

  const grid = h("div", { class: "grid" }, books.map((b) => {
    const p = prog.get(b.bookId);
    const pct = p && b.totalBlocks > 1 ? Math.round((p.lastBlockIndex / (b.totalBlocks - 1)) * 100) : null;
    let cover;
    if (b.cover) {
      const url = URL.createObjectURL(new Blob([b.cover.bytes], { type: b.cover.mime }));
      coverUrls.push(url);
      cover = h("img", { class: "cover", src: url, alt: "" });
    } else {
      cover = h("div", { class: `cover title-card ${b.type}` }, h("span", null, b.title));
    }
    const isSel = selected.has(b.bookId);
    return h("button", {
      class: `card ${isSel ? "selected" : ""}`,
      onclick: () => {
        if (!selecting) return open(b.bookId);
        isSel ? selected.delete(b.bookId) : selected.add(b.bookId);
        renderLibrary();
      },
    },
      h("div", { class: "cover-wrap" }, cover,
        selecting && h("span", { class: `sel-mark ${isSel ? "on" : ""}` }, isSel && icon("check", 18)),
        pct != null && h("span", { class: "pct-badge" }, `${pct}%`)),
      h("span", { class: "card-title" }, b.title),
      h("span", { class: "card-sub" }, b.type === "epub" ? "EPUB" : "TXT"));
  }));

  const empty = !books.length && h("div", { class: "lib-empty" },
    icon("library", 56),
    h("p", null, "Aún no hay libros. Pulsa «Abrir archivo…» para añadir un EPUB, un TXT o un paquete .gmreader desde Archivos."));

  app.replaceChildren(h("div", { class: "library" }, header, empty || grid,
    h("p", { class: "version lib-version" }, `Versión ${APP_VERSION} (web)`)));
}

async function deleteSelected(books) {
  if (!selected.size) return;
  const names = books.filter((b) => selected.has(b.bookId)).map((b) => `«${b.title}»`);
  const ok = await confirmDialog({
    title: "Borrar de la biblioteca",
    message: `Se borrará${names.length > 1 ? "n" : ""} ${names.join(", ")} de este dispositivo. Los marcadores, resaltados y el progreso se conservan si vuelves a abrir el mismo archivo.`,
    confirm: "Borrar", danger: true,
  });
  if (!ok) return;
  for (const id of selected) await deleteBook(id);
  selected.clear();
  selecting = false;
  renderLibrary();
}

// ---------- reader ----------

async function open(bookId) {
  try {
    app.replaceChildren(h("div", { class: "loading" }, "Cargando…"));
    window.scrollTo(0, 0);
    reader = await openReader(app, bookId, {
      onExit: () => {
        reader = null;
        memo.set(null);
        if (reloadWhenIdle) return location.reload();
        window.scrollTo(0, 0);
        renderLibrary();
      },
    });
    memo.set(bookId);
  } catch (err) {
    console.error(err);
    reader = null;
    memo.set(null);
    toast(`No se pudo abrir el libro: ${err.message}`);
    renderLibrary();
  }
}

// ---------- boot ----------

applyToDocument();
onChange((s, patch) => { if ("skin" in patch || "fontFamily" in patch) applyToDocument(s); });

const isDev = ["localhost", "127.0.0.1"].includes(location.hostname);
if ("serviceWorker" in navigator && !isDev) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
  // A new deploy took over: reload right away from the library, or once the reader is closed —
  // never yank the page out from under someone mid-chapter.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) { hadController = true; return; }
    if (reader) reloadWhenIdle = true;
    else location.reload();
  });
}

// Reopen whatever was being read when the app was last closed (or killed by iOS).
const last = memo.get();
if (last && (await db.get("books", last))) open(last);
else renderLibrary();
