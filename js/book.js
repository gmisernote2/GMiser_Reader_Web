// Book model + parsers — a line-for-line port of :shared's EpubBookParser.kt / TxtBlockParser.kt /
// Search.kt / BookContentHash.kt. The block list it produces has to match the Kotlin one *exactly*
// (same blocks, same plain text, same indices): bookmarks and highlights are stored as
// (blockIndex, char offset) and travel between devices inside .gmreader bundles. Every "why is
// this so fiddly" below is Jsoup behavior being reproduced on top of the browser's DOMParser.
//
// Block shape: { k: "p"|"h"|"q"|"li"|"img", t: plainText, s: [[start, end, "b"|"i"|"u"]],
//                l?: headingLevel, m?: listMarker, img?: Uint8Array, mime?: string }

import { readZip, isZip } from "./zip.js";

const utf8 = new TextDecoder("utf-8");
// Java's UTF-8 decoder (what the Kotlin side uses) does NOT strip a leading BOM — keep it too.
const utf8KeepBom = new TextDecoder("utf-8", { ignoreBOM: true });

// ---------- whitespace rules ----------

// Jsoup's StringUtil.isActuallyWhitespace — what TextNode.text() collapses.
const isJsoupWs = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13 || c === 160;
// Jsoup's StringUtil.isInvisibleChar — dropped entirely by TextNode.text().
const isInvisible = (c) => c === 8203 || c === 173;

/** Jsoup TextNode.text(): runs of whitespace → one space, invisible chars removed, no trimming. */
function jsoupNormalize(s) {
  let out = "";
  let lastWasWhite = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isJsoupWs(c)) {
      if (lastWasWhite) continue;
      out += " ";
      lastWasWhite = true;
    } else if (!isInvisible(c)) {
      out += s[i];
      lastWasWhite = false;
    }
  }
  return out;
}

// Kotlin's Char.isWhitespace (Character.isWhitespace || Character.isSpaceChar) — what String.trim()
// strips. Notably NOT U+FEFF, unlike JavaScript's own String.prototype.trim.
const KT_WS = /[\t\n\u000B\f\r\u001C-\u001F\p{Zs}\u2028\u2029]/u;
const isKtWs = (ch) => KT_WS.test(ch);

function ktTrimRange(s) {
  let start = 0;
  while (start < s.length && isKtWs(s[start])) start++;
  if (start === s.length) return [0, 0];
  let end = s.length;
  while (end > start && isKtWs(s[end - 1])) end--;
  return [start, end];
}
const ktTrim = (s) => { const [a, b] = ktTrimRange(s); return s.slice(a, b); };

/** Jsoup Element.text(), close enough for titles (never used for anything offset-sensitive). */
function elementText(el) {
  return ktTrim(jsoupNormalize(el ? el.textContent : ""));
}

// ---------- paths ----------

function decode(value) {
  // java.net.URLDecoder semantics: '+' is a space.
  try { return decodeURIComponent(value.replace(/\+/g, " ")); } catch { return value; }
}

export function resolvePath(baseDir, relative) {
  if (relative.startsWith("/")) return relative.slice(1);
  const combined = baseDir === "" ? relative : `${baseDir}/${relative}`;
  const stack = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (stack.length) stack.pop(); }
    else stack.push(part);
  }
  return stack.join("/");
}
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// ---------- XML helpers (Jsoup's xmlParser lowercases names for selector matching) ----------

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    return new DOMParser().parseFromString(text, "text/html"); // lenient fallback, like Jsoup
  }
  return doc;
}
const lname = (el) => el.tagName.toLowerCase();
const allByTag = (root, name) => [...root.getElementsByTagName("*")].filter((e) => lname(e) === name);
const childByTag = (root, parent, name) =>
  allByTag(root, name).filter((e) => e.parentElement && lname(e.parentElement) === parent);
const firstDesc = (root, name, parentName) =>
  allByTag(root, name).find((e) => !parentName || (e.parentElement && lname(e.parentElement) === parentName)) || null;

// ---------- HTML parsing that behaves like Jsoup ----------

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
  "track", "wbr", "basefont", "bgsound", "frame", "keygen", "command", "device",
]);

/** Jsoup honors XHTML-style self-closing on *every* tag (`<title/>`, `<p/>`, `<a id="x"/>` are
 * closed immediately); the HTML5 spec — and so the browser — ignores it on non-void tags, which
 * would e.g. let a `<title/>` swallow the whole chapter as RCDATA. Expand them first. */
function expandSelfClosing(html) {
  return html.replace(
    /<([a-zA-Z][\w:.-]*)((?:\s+[^\s/>"'=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/>/g,
    (m, tag, attrs) => (VOID_TAGS.has(tag.toLowerCase()) ? m : `<${tag}${attrs}></${tag}>`),
  );
}

function parseHtml(text) {
  return new DOMParser().parseFromString(expandSelfClosing(text), "text/html");
}

// Jsoup stores <script>/<style> content as DataNode (not TextNode), so it never becomes text.
const DATA_TAGS = new Set(["script", "style"]);
const childNodesOf = (el) => (el.localName === "template" ? el.content.childNodes : el.childNodes);

// ---------- EPUB ----------

export function parseEpubEntries(entries) {
  const text = (path) => (entries.has(path) ? utf8KeepBom.decode(entries.get(path)) : null);

  const containerXml = text("META-INF/container.xml");
  if (containerXml == null) throw new Error("EPUB inválido: falta META-INF/container.xml");
  const rootfile = firstDesc(parseXml(containerXml), "rootfile");
  if (!rootfile) throw new Error("container.xml sin <rootfile>");
  const opfPath = decode(rootfile.getAttribute("full-path") || "");
  const opfXml = text(opfPath);
  if (opfXml == null) throw new Error(`EPUB inválido: falta ${opfPath}`);
  const opf = parseOpf(opfXml, dirOf(opfPath));

  let tocSource = [];
  if (opf.ncxHref && entries.has(opf.ncxHref)) tocSource = parseNcx(text(opf.ncxHref), dirOf(opf.ncxHref));
  else if (opf.navHref && entries.has(opf.navHref)) tocSource = parseNav(text(opf.navHref), dirOf(opf.navHref));

  const blocks = [];
  const chapterStart = new Map();
  for (const href of opf.spineHrefs) {
    chapterStart.set(href, blocks.length);
    const html = text(href);
    if (html == null) continue;
    const doc = parseHtml(html);
    // Jsoup keeps a leading U+FEFF (decoded but never stripped, see utf8KeepBom) as its own text
    // node, which survives Kotlin's trim() and becomes a one-character paragraph. Reproduce it.
    if (html.charCodeAt(0) === 0xfeff && !doc.body.textContent.startsWith("﻿")) {
      blocks.push({ k: "p", t: "﻿", s: [] });
    }
    walkChildren(doc.body, entries, dirOf(href), blocks);
  }

  const toc = [];
  for (const [title, hrefWithFragment] of tocSource) {
    const idx = chapterStart.get(hrefWithFragment.split("#")[0]);
    if (idx !== undefined) toc.push({ title, blockIndex: idx });
  }

  const coverBytes = opf.coverHref ? entries.get(opf.coverHref) : null;
  const cover = coverBytes && imageMime(coverBytes) ? { bytes: coverBytes, mime: imageMime(coverBytes) } : null;

  return { blocks, toc, isEpub: true, title: opf.title, cover };
}

function parseOpf(xml, opfDir) {
  const doc = parseXml(xml);
  const manifest = new Map();
  for (const item of childByTag(doc, "manifest", "item")) {
    manifest.set(item.getAttribute("id") || "", {
      href: resolvePath(opfDir, decode(item.getAttribute("href") || "")),
      mediaType: item.getAttribute("media-type") || "",
      properties: (item.getAttribute("properties") || "").split(" "),
    });
  }
  const spineHrefs = childByTag(doc, "spine", "itemref")
    .map((r) => manifest.get(r.getAttribute("idref") || ""))
    .filter(Boolean)
    .map((m) => m.href);
  const spine = allByTag(doc, "spine").find((s) => s.hasAttribute("toc"));
  const tocId = spine && spine.getAttribute("toc").trim() ? spine.getAttribute("toc") : null;
  const values = [...manifest.values()];
  const ncxHref = (tocId && manifest.get(tocId)?.href)
    || values.find((m) => m.mediaType === "application/x-dtbncx+xml")?.href || null;
  const navHref = values.find((m) => m.properties.includes("nav"))?.href || null;
  const titleEl = allByTag(doc, "dc:title")[0];
  const title = titleEl ? elementText(titleEl) || null : null;

  let coverHref = values.find((m) => m.properties.includes("cover-image"))?.href || null;
  if (!coverHref) {
    const meta = childByTag(doc, "metadata", "meta").find((m) => m.getAttribute("name") === "cover");
    coverHref = meta ? manifest.get(meta.getAttribute("content") || "")?.href || null : null;
  }
  return { spineHrefs, ncxHref, navHref, title, coverHref };
}

function parseNcx(xml, ncxDir) {
  const doc = parseXml(xml);
  const out = [];
  for (const np of allByTag(doc, "navpoint")) {
    const title = elementText(firstDesc(np, "text", "navlabel"));
    const src = firstDesc(np, "content")?.getAttribute("src") || "";
    if (src.trim()) out.push([title, resolvePath(ncxDir, decode(src))]);
  }
  return out;
}

function parseNav(html, navDir) {
  const doc = parseHtml(html);
  const navs = [...doc.getElementsByTagName("nav")];
  const nav = navs.find((n) => (n.getAttribute("epub:type") || "").toLowerCase() === "toc") || navs[0];
  if (!nav) return [];
  return [...nav.querySelectorAll("a[href]")].map((a) => [elementText(a), resolvePath(navDir, decode(a.getAttribute("href")))]);
}

const HEADING = /^h([1-6])$/;
const CONTAINER_TAGS = new Set(["div", "section", "article", "header", "footer", "main", "figure", "body"]);

function walkChildren(parent, entries, chapterDir, out) {
  for (const node of childNodesOf(parent)) {
    if (node.nodeType === Node.ELEMENT_NODE) walkElement(node, entries, chapterDir, out);
    else if (node.nodeType === Node.TEXT_NODE && !DATA_TAGS.has(parent.localName)) {
      const t = ktTrim(jsoupNormalize(node.data));
      if (t) out.push({ k: "p", t, s: [] });
    }
  }
}

function walkElement(el, entries, chapterDir, out) {
  const tag = el.localName.toLowerCase();
  const push = (block) => { if (block.t) out.push(block); };
  const h = HEADING.exec(tag);
  if (h) return push({ k: "h", l: Number(h[1]), ...inlineText(el) });
  switch (tag) {
    case "p": return push({ k: "p", ...inlineText(el) });
    case "blockquote": {
      const ps = [...el.children].filter((c) => c.localName.toLowerCase() === "p");
      if (!ps.length) return push({ k: "q", ...inlineText(el) });
      for (const p of ps) push({ k: "q", ...inlineText(p) });
      return;
    }
    case "ul":
      for (const li of [...el.children].filter((c) => c.localName.toLowerCase() === "li")) push({ k: "li", m: "•", ...inlineText(li) });
      return;
    case "ol":
      [...el.children].filter((c) => c.localName.toLowerCase() === "li")
        .forEach((li, i) => push({ k: "li", m: `${i + 1}.`, ...inlineText(li) }));
      return;
    case "img": {
      const img = loadImage(el.getAttribute("src") || "", entries, chapterDir);
      if (img) out.push(img);
      return;
    }
    case "hr": case "br": return;
  }
  if (CONTAINER_TAGS.has(tag)) return walkChildren(el, entries, chapterDir, out);
  if (DATA_TAGS.has(tag)) return;
  push({ k: "p", ...inlineText(el) }); // unrecognized: still keep its text
}

/** Android decodes with BitmapFactory and drops anything it can't decode; this keeps exactly the
 * formats BitmapFactory handles (JPEG/PNG/GIF/WebP/BMP), recognized by magic bytes. */
function imageMime(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return null;
}

function loadImage(src, entries, chapterDir) {
  if (!src.trim()) return null;
  const bytes = entries.get(resolvePath(chapterDir, decode(src)));
  const mime = bytes && imageMime(bytes);
  return mime ? { k: "img", t: "", s: [], img: bytes, mime } : null;
}

/** Inline content → plain text + [start, end, style] spans, then Kotlin-trimmed (spans shifted
 * and clipped the way AnnotatedString.subSequence does). */
function inlineText(el) {
  let text = "";
  const spans = [];
  const walk = (node) => {
    for (const child of childNodesOf(node)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!DATA_TAGS.has(node.localName)) text += jsoupNormalize(child.data);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.localName.toLowerCase();
        const style = tag === "b" || tag === "strong" ? "b" : tag === "i" || tag === "em" ? "i" : tag === "u" ? "u" : null;
        if (tag === "br") text += "\n";
        else if (style) {
          const start = text.length;
          walk(child);
          spans.push([start, text.length, style]);
        } else walk(child);
      }
    }
  };
  walk(el);
  const [a, b] = ktTrimRange(text);
  if (a === b) return { t: "", s: [] };
  const s = spans
    .map(([x, y, st]) => [Math.max(x, a) - a, Math.min(y, b) - a, st])
    .filter(([x, y]) => x < y);
  // Kotlin records a span when its style is popped (inner first); sort by start for stable order.
  s.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
  return { t: text.slice(a, b), s };
}

// ---------- TXT ----------

export function parseTxt(bytes) {
  const text = utf8KeepBom.decode(bytes);
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map(ktTrim).filter(Boolean)
    .map((t) => ({ k: "p", t, s: [] }));
  return { blocks, toc: [], isEpub: false, title: null, cover: null };
}

// ---------- detection / hashing ----------

const BUNDLE_KIND = "gmiser_reader_bundle";

/** Same order as FileTypeDetector.kt: extension first, then zip sniffing. */
export async function detectType(name, bytes) {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".gmreader")) return "bundle";
  if (n.endsWith(".epub")) return "epub";
  if (n.endsWith(".txt")) return "txt";
  if (!isZip(bytes)) return "txt";
  try {
    const entries = await readZip(bytes);
    const manifest = entries.get("manifest.json");
    if (manifest && utf8.decode(manifest).includes(`"${BUNDLE_KIND}"`)) return "bundle";
  } catch { /* fall through */ }
  return "epub";
}

/** BookContentHash.kt: SHA-256 of (file size as decimal text) + first 64 KB. */
export async function computeBookId(bytes) {
  const size = new TextEncoder().encode(String(bytes.length));
  const head = bytes.subarray(0, 65536);
  const buf = new Uint8Array(size.length + head.length);
  buf.set(size, 0);
  buf.set(head, size.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...digest].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function parseBook(type, bytes) {
  if (type === "txt") return parseTxt(bytes);
  return parseEpubEntries(await readZip(bytes));
}

// ---------- search / chapters (Search.kt) ----------

const SNIPPET_CONTEXT = 40;

/** Kotlin's indexOf(ignoreCase = true): per-char compare (uppercase, then lowercase), so offsets
 * never drift the way toLowerCase() on the whole string can (e.g. "İ" lowercases to 2 chars). */
function indexOfIgnoreCase(text, query) {
  const eq = (a, b) => a === b || a.toUpperCase() === b.toUpperCase() || a.toLowerCase() === b.toLowerCase();
  outer: for (let i = 0; i + query.length <= text.length; i++) {
    for (let j = 0; j < query.length; j++) if (!eq(text[i + j], query[j])) continue outer;
    return i;
  }
  return -1;
}

export function searchBlocks(blocks, query, chapterRange) {
  if (!query.trim()) return [];
  const [from, to] = chapterRange || [0, blocks.length - 1];
  const results = [];
  for (let i = from; i <= to && i < blocks.length; i++) {
    const t = blocks[i].k === "img" ? "Imagen" : blocks[i].t;
    const at = indexOfIgnoreCase(t, query);
    if (at < 0) continue;
    const start = Math.max(0, at - SNIPPET_CONTEXT);
    const end = Math.min(t.length, at + query.length + SNIPPET_CONTEXT);
    results.push({
      blockIndex: i,
      before: (start > 0 ? "…" : "") + t.slice(start, at),
      match: t.slice(at, at + query.length),
      after: t.slice(at + query.length, end) + (end < t.length ? "…" : ""),
    });
  }
  return results;
}

export function chapterRange(toc, chapterIndex, total) {
  if (chapterIndex < 0 || chapterIndex >= toc.length) return null;
  const start = toc[chapterIndex].blockIndex;
  const end = chapterIndex + 1 < toc.length ? toc[chapterIndex + 1].blockIndex - 1 : total - 1;
  return [start, end];
}

export const plainText = (block) => (block.k === "img" ? "Imagen" : block.t);
