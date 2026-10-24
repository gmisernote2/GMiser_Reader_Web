// Offline app shell. Everything the app needs is precached on install, so after the first visit
// it launches from the iPad's own cache with no network at all. BUILD is stamped by deploy.sh —
// a new value means a new cache, which is how a deploy reaches already-installed copies.
const BUILD = "0.1.1-34517d9-20261024142813";
const CACHE = `gmr-${BUILD}`;
const FONTS = ["literata", "inter", "merriweather", "bitter", "eb_garamond", "atkinson_hyperlegible"]
  .flatMap((f) => [`fonts/${f}_regular.ttf`, `fonts/${f}_italic.ttf`]);
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "icon-512.png", "css/app.css",
  "js/main.js", "js/reader.js", "js/library.js", "js/book.js", "js/zip.js", "js/db.js",
  "js/settings.js", "js/ui.js", "js/tts.js", "js/version.js",
  ...FONTS,
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("gmr-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Only this app's own scope — the separate auth-test page keeps its own worker.
  if (!url.pathname.startsWith(new URL("./", self.location).pathname) || url.pathname.includes("/auth-test/")) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()))),
  );
});
