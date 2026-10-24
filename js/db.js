// IndexedDB persistence — the web stand-in for :app's Room database. Same records, same keys
// (bookId = content hash), so .gmreader bundles map 1:1 onto these stores. Book bytes are stored
// as ArrayBuffer (not Blob): Safari's IndexedDB Blob support has historically been the flaky part.

const DB_NAME = "gmiser-reader";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("books", { keyPath: "bookId" });
      db.createObjectStore("progress", { keyPath: "bookId" });
      db.createObjectStore("bookmarks", { keyPath: "id", autoIncrement: true }).createIndex("bookId", "bookId");
      db.createObjectStore("highlights", { keyPath: "id", autoIncrement: true }).createIndex("bookId", "bookId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const get = async (name, key) => wrap((await store(name)).get(key));
export const put = async (name, value) => wrap((await store(name, "readwrite")).put(value));
export const del = async (name, key) => wrap((await store(name, "readwrite")).delete(key));
export const all = async (name) => wrap((await store(name)).getAll());
export const byBook = async (name, bookId) => wrap((await store(name)).index("bookId").getAll(bookId));

/** Library listing without dragging every book's bytes into memory. */
export async function listBooks() {
  const s = await store("books");
  return new Promise((resolve, reject) => {
    const out = [];
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      const { data, ...meta } = c.value;
      out.push(meta);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
