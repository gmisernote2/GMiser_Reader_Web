// Library data operations: adding files, importing/exporting .gmreader bundles, deleting.
// The web has no "open with" handoff on iOS, so unlike Android every opened book is kept here —
// there's no original file Uri to come back to later.

import * as db from "./db.js";
import { detectType, computeBookId, parseBook } from "./book.js";
import { readZip, writeZip } from "./zip.js";

const BUNDLE_KIND = "gmiser_reader_bundle";
const BUNDLE_FORMAT_VERSION = 1;
const utf8 = new TextDecoder("utf-8");

/** Adds a picked File (EPUB, TXT or .gmreader) and returns the stored book's bookId. */
export async function addFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = await detectType(file.name, bytes);
  if (type === "bundle") return importBundle(bytes);
  return storeBook(bytes, type, file.name);
}

async function storeBook(bytes, type, fileName, fallbackTitle) {
  const bookId = await computeBookId(bytes);
  const existing = await db.get("books", bookId);
  if (existing) return bookId;
  const content = await parseBook(type, bytes);
  const title = content.title || fallbackTitle || fileName.replace(/\.(epub|txt)$/i, "");
  await db.put("books", {
    bookId,
    title,
    fileName,
    type,
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    cover: content.cover,
    totalBlocks: content.blocks.length,
    addedAt: Date.now(),
  });
  requestPersistence();
  return bookId;
}

let persistAsked = false;
function requestPersistence() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  navigator.storage.persist().catch(() => {});
}

export async function deleteBook(bookId) {
  // Like Android's library delete: only the stored copy goes — progress, bookmarks and highlights
  // stay keyed by bookId, so opening the same file again resumes exactly where it was.
  await db.del("books", bookId);
}

// ---------- .gmreader bundles (BookBundleTransfer.kt / BookBundleImport.kt) ----------

async function importBundle(bytes) {
  const entries = await readZip(bytes);
  const manifestBytes = entries.get("manifest.json");
  const dataBytes = entries.get("data.json");
  let manifest;
  try { manifest = JSON.parse(utf8.decode(manifestBytes)); } catch { manifest = null; }
  if (!manifest || manifest.kind !== BUNDLE_KIND) throw new Error("Archivo no reconocido como paquete de Gmiser Reader");
  let data = {};
  try { data = dataBytes ? JSON.parse(utf8.decode(dataBytes)) : {}; } catch {
    throw new Error("Archivo no reconocido como paquete de Gmiser Reader");
  }
  const bookEntry = [...entries.keys()].find((k) => k.startsWith("book/") && k.length > 5);
  if (!bookEntry) throw new Error("El paquete no contiene ningún libro");
  const bookBytes = entries.get(bookEntry);
  const fileName = bookEntry.slice(5);
  const type = await detectType(fileName, bookBytes);
  if (type === "bundle") throw new Error("El paquete no contiene ningún libro");

  // bookId is recomputed from the bytes, never trusted from the manifest (same as Android).
  const bookId = await storeBook(bookBytes, type, fileName, manifest.displayTitle);
  const book = await db.get("books", bookId);

  const existingMarks = new Set((await db.byBook("bookmarks", bookId)).map((b) => `${b.blockIndex}:${b.offset}`));
  for (const b of data.bookmarks || []) {
    const key = `${b.blockIndex}:${b.offset}`;
    if (existingMarks.has(key)) continue;
    existingMarks.add(key);
    await db.put("bookmarks", { bookId, blockIndex: b.blockIndex, offset: b.offset, label: b.label || "", title: b.title || "", createdAt: b.createdAt || Date.now() });
  }
  const existingHl = new Set((await db.byBook("highlights", bookId)).map((x) => `${x.blockIndex}:${x.startOffset}:${x.endOffset}`));
  for (const x of data.highlights || []) {
    const key = `${x.blockIndex}:${x.startOffset}:${x.endOffset}`;
    if (existingHl.has(key)) continue;
    existingHl.add(key);
    await db.put("highlights", { bookId, blockIndex: x.blockIndex, startOffset: x.startOffset, endOffset: x.endOffset, text: x.text || "", createdAt: x.createdAt || Date.now() });
  }
  // Imported progress never clobbers progress already made on this device.
  if (data.progress && !(await db.get("progress", bookId))) {
    await db.put("progress", {
      bookId, displayTitle: book.title,
      lastBlockIndex: data.progress.lastBlockIndex, lastOffset: data.progress.lastOffset,
      lastOpenedAt: data.progress.lastOpenedAt,
    });
  }
  return bookId;
}

export async function buildBundle(bookId) {
  const book = await db.get("books", bookId);
  const [bookmarks, highlights, progress] = await Promise.all([
    db.byBook("bookmarks", bookId), db.byBook("highlights", bookId), db.get("progress", bookId),
  ]);
  const enc = new TextEncoder();
  const manifest = {
    kind: BUNDLE_KIND, formatVersion: BUNDLE_FORMAT_VERSION, bookId,
    displayTitle: book.title, originalFileName: book.fileName, exportedAt: Date.now(),
  };
  const data = {
    bookmarks: bookmarks.map((b) => ({ blockIndex: b.blockIndex, offset: b.offset, label: b.label, title: b.title || "", createdAt: b.createdAt })),
    highlights: highlights.map((x) => ({ blockIndex: x.blockIndex, startOffset: x.startOffset, endOffset: x.endOffset, text: x.text, createdAt: x.createdAt })),
    progress: progress ? { lastBlockIndex: progress.lastBlockIndex, lastOffset: progress.lastOffset, lastOpenedAt: progress.lastOpenedAt } : null,
  };
  const blob = await writeZip([
    { name: "manifest.json", data: enc.encode(JSON.stringify(manifest)) },
    { name: `book/${book.fileName}`, data: new Uint8Array(book.data) },
    { name: "data.json", data: enc.encode(JSON.stringify(data)) },
  ]);
  return new File([blob], `${safeBaseName(book.title)}.gmreader`, { type: "application/octet-stream" });
}

export async function bookFile(bookId) {
  const book = await db.get("books", bookId);
  const mime = book.type === "epub" ? "application/epub+zip" : "text/plain";
  return new File([book.data], book.fileName || `${safeBaseName(book.title)}.${book.type}`, { type: mime });
}

/** sanitizedFileBaseName() in BookBundleWriter.kt. */
function safeBaseName(title) {
  const cleaned = (title || "").replace(/[\\/:*?"<>|]/g, " ").trim();
  return cleaned || "libro";
}

/** Web Share with files when the platform allows it, otherwise a plain download (→ Files). */
export async function shareOrDownload(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
      // NotAllowedError (gesture expired) etc. — fall through to download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "downloaded";
}
