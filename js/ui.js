// Tiny DOM helpers, Material icon paths, toast and modal dialogs.

/** h("div", { class: "x", onclick }, child, "text", [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  appendAll(el, children);
  return el;
}

function appendAll(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Material Symbols (Apache 2.0) — same icons the Android app uses.
const PATHS = {
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  bookmark: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z",
  bookmarkAdd: "M17 11v6.97l-5-2.14-5 2.14V5h6V3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V11h-2zm4-4h-2v2h-2V7h-2V5h2V3h2v2h2v2z",
  settings: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  share: "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z",
  library: "M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z",
  play: "M8 5v14l11-7z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  stop: "M6 6h12v12H6z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  delete: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  folder: "M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  book: "M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z",
};

export function icon(name, size = 24) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", PATHS[name]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

export const iconButton = (name, label, onclick, extraClass = "") =>
  h("button", { class: `icon-btn ${extraClass}`, "aria-label": label, title: label, onclick }, icon(name));

// ---------- toast ----------
let toastTimer = null;
export function toast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", class: "toast", role: "status" });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

// ---------- dialogs ----------
function modal(content) {
  const backdrop = h("div", { class: "modal-backdrop" });
  const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, content);
  backdrop.append(box);
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("show"));
  const close = () => {
    backdrop.classList.remove("show");
    setTimeout(() => backdrop.remove(), 180);
  };
  return { backdrop, box, close };
}

export function confirmDialog({ title, message, confirm = "Aceptar", cancel = "Cancelar", danger = false }) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { m.close(); resolve(v); };
    m = modal([
      h("h3", null, title),
      message && h("p", null, message),
      h("div", { class: "modal-actions" },
        h("button", { class: "text-btn", onclick: () => done(false) }, cancel),
        h("button", { class: `text-btn ${danger ? "danger" : "strong"}`, onclick: () => done(true) }, confirm)),
    ]);
    m.backdrop.addEventListener("click", (e) => { if (e.target === m.backdrop) done(false); });
  });
}

export function promptDialog({ title, value = "", placeholder = "", confirm = "Guardar", cancel = "Cancelar" }) {
  return new Promise((resolve) => {
    let m;
    const input = h("input", { class: "text-input", value, placeholder, autocomplete: "off" });
    const done = (v) => { m.close(); resolve(v); };
    m = modal([
      h("h3", null, title),
      input,
      h("div", { class: "modal-actions" },
        h("button", { class: "text-btn", onclick: () => done(null) }, cancel),
        h("button", { class: "text-btn strong", onclick: () => done(input.value) }, confirm)),
    ]);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(input.value); });
    m.backdrop.addEventListener("click", (e) => { if (e.target === m.backdrop) done(null); });
    setTimeout(() => input.focus(), 50);
  });
}

/** options: [{ label, description?, icon?, value }] → resolves the chosen value or null. */
export function choiceDialog({ title, options, cancel = "Cancelar" }) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { m.close(); resolve(v); };
    m = modal([
      h("h3", null, title),
      h("div", { class: "choice-list" }, options.map((o) =>
        h("button", { class: "choice", onclick: () => done(o.value) },
          o.icon && icon(o.icon),
          h("span", { class: "choice-text" }, h("strong", null, o.label), o.description && h("small", null, o.description))))),
      h("div", { class: "modal-actions" }, h("button", { class: "text-btn", onclick: () => done(null) }, cancel)),
    ]);
    m.backdrop.addEventListener("click", (e) => { if (e.target === m.backdrop) done(null); });
  });
}

export function formatDate(ms) {
  return new Date(ms).toLocaleString("es-ES", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
