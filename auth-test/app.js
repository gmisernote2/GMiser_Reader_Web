"use strict";

const cfg = window.GM_CONFIG;
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "gm_test_token";
const STATE_KEY = "gm_test_oauth_state";
const CLIENT_KEY = "gm_test_client_id";
const TEST_FOLDER = "GMiser Reader (prueba)";

// ---------- log ----------
function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $("log").appendChild(line);
  $("log").scrollTop = $("log").scrollHeight;
}
window.addEventListener("error", (e) => log(`JS error: ${e.message}`, "bad"));
window.addEventListener("unhandledrejection", (e) => log(`Promise error: ${e.reason}`, "bad"));

function row(table, key, value, cls) {
  const tr = document.createElement("tr");
  const a = document.createElement("td");
  const b = document.createElement("td");
  a.textContent = key;
  b.textContent = value;
  if (cls) b.className = cls;
  tr.append(a, b);
  table.appendChild(tr);
}
const yesNo = (v) => [v ? "sí" : "no", v ? "ok" : "bad"];

// ---------- client id ----------
function clientId() {
  return (cfg.clientId || $("clientId").value || "").trim();
}
$("clientId").value = cfg.clientId || localStorage.getItem(CLIENT_KEY) || "";
$("clientId").addEventListener("change", () => localStorage.setItem(CLIENT_KEY, $("clientId").value.trim()));
if (cfg.clientId) $("clientId").disabled = true;

// The exact URL Google redirects back to — must match an "Authorized redirect URI" verbatim.
const redirectUri = location.origin + location.pathname;

// ---------- environment checks ----------
async function checkEnv() {
  const t = $("env");
  t.innerHTML = "";
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  row(t, "Abierta como app instalada", standalone ? "sí" : "no — ábrela desde el icono", standalone ? "ok" : "warn");
  row(t, "Contexto seguro (HTTPS)", ...yesNo(window.isSecureContext));
  row(t, "crypto.subtle (hash del libro)", ...yesNo(!!(window.crypto && crypto.subtle)));

  let sw = "no soportado", swCls = "bad";
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
      await navigator.serviceWorker.ready;
      sw = navigator.serviceWorker.controller ? "activo (offline listo)" : "registrado — recarga una vez";
      swCls = navigator.serviceWorker.controller ? "ok" : "warn";
    } catch (e) { sw = `error: ${e.message}`; }
  }
  row(t, "Service worker", sw, swCls);

  if (navigator.storage && navigator.storage.persist) {
    const persisted = await navigator.storage.persist().catch(() => false);
    row(t, "Almacenamiento persistente", persisted ? "concedido" : "denegado", persisted ? "ok" : "warn");
  } else row(t, "Almacenamiento persistente", "no soportado", "warn");
  if (navigator.storage && navigator.storage.estimate) {
    const { quota, usage } = await navigator.storage.estimate();
    row(t, "Cuota / usado", `${(quota / 1e9).toFixed(1)} GB / ${(usage / 1e6).toFixed(1)} MB`);
  }

  row(t, "IndexedDB", await idbRoundTrip() ? "lectura/escritura ok" : "falla", undefined);
  t.lastChild.lastChild.className = t.lastChild.lastChild.textContent.startsWith("lectura") ? "ok" : "bad";

  const shareFiles = !!(navigator.canShare && navigator.canShare({
    files: [new File(["x"], "prueba.gmreader", { type: "application/octet-stream" })],
  }));
  row(t, "Compartir archivos (.gmreader)", ...yesNo(shareFiles));
  row(t, "Wake Lock (pantalla encendida)", ...yesNo("wakeLock" in navigator));
  row(t, "Bloqueo de orientación", ...yesNo(!!(screen.orientation && screen.orientation.lock)));

  if ("speechSynthesis" in window) {
    const voices = await loadVoices();
    const es = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("es"));
    row(t, "Voces TTS (total / español)", `${voices.length} / ${es.length}`, es.length ? "ok" : "warn");
  } else row(t, "Voces TTS", "no soportado", "bad");

  row(t, "Redirect URI a registrar", redirectUri);
  row(t, "User agent", navigator.userAgent);
}

function idbRoundTrip() {
  return new Promise((resolve) => {
    const req = indexedDB.open("gm-test", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(Date.now(), "ping");
      tx.oncomplete = () => {
        const get = db.transaction("kv").objectStore("kv").get("ping");
        get.onsuccess = () => resolve(typeof get.result === "number");
        get.onerror = () => resolve(false);
      };
      tx.onerror = () => resolve(false);
    };
  });
}

function loadVoices() {
  return new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    speechSynthesis.onvoiceschanged = () => resolve(speechSynthesis.getVoices());
    setTimeout(() => resolve(speechSynthesis.getVoices()), 2000);
  });
}

// ---------- token storage ----------
function saveToken(accessToken, expiresInSec, via) {
  const tok = { accessToken, expiresAt: Date.now() + expiresInSec * 1000, via, obtainedAt: Date.now() };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tok));
  renderAuth();
  return tok;
}
function getToken() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}
function validToken() {
  const t = getToken();
  return t && t.expiresAt > Date.now() + 30_000 ? t.accessToken : null;
}
function renderAuth() {
  const t = $("auth");
  t.innerHTML = "";
  const tok = getToken();
  if (!tok) { row(t, "Token", "ninguno", "warn"); return; }
  const mins = Math.round((tok.expiresAt - Date.now()) / 60000);
  row(t, "Token", mins > 0 ? `válido ~${mins} min` : "caducado", mins > 0 ? "ok" : "bad");
  row(t, "Obtenido vía", tok.via);
  row(t, "Obtenido a las", new Date(tok.obtainedAt).toLocaleString());
}

// ---------- flow A: full-page redirect (implicit grant, no backend) ----------
function startRedirect(silent) {
  const id = clientId();
  if (!id) return log("Falta el Client ID", "bad");
  const state = crypto.getRandomValues(new Uint32Array(4)).join("-");
  localStorage.setItem(STATE_KEY, JSON.stringify({ state, silent: !!silent }));
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: cfg.scopes.join(" "),
    include_granted_scopes: "true",
    state,
  });
  if (silent) params.set("prompt", "none");
  log(`Redirigiendo a Google (${silent ? "silencioso" : "interactivo"})…`);
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

function handleRedirectReturn() {
  if (!location.hash || location.hash.length < 2) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has("access_token") && !p.has("error")) return;
  history.replaceState(null, "", location.pathname + location.search);

  let expected = null;
  try { expected = JSON.parse(localStorage.getItem(STATE_KEY)); } catch {}
  localStorage.removeItem(STATE_KEY);
  if (!expected || expected.state !== p.get("state")) {
    return log("Vuelta de Google con state que no coincide — ignorado (¿se perdió localStorage en la redirección?)", "bad");
  }
  const via = expected.silent ? "redirección silenciosa" : "redirección";
  if (p.has("error")) return log(`Google devolvió error (${via}): ${p.get("error")}`, "bad");
  saveToken(p.get("access_token"), Number(p.get("expires_in") || 3600), via);
  log(`Token recibido por ${via}. Scopes: ${p.get("scope")}`, "ok");
}

// ---------- flow B: Google Identity Services popup ----------
let gisLoaded = null;
function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("no se pudo cargar GIS"));
    document.head.appendChild(s);
  });
  return gisLoaded;
}
async function startPopup() {
  const id = clientId();
  if (!id) return log("Falta el Client ID", "bad");
  try { await loadGis(); } catch (e) { return log(e.message, "bad"); }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: cfg.scopes.join(" "),
    callback: (r) => {
      if (r.error) return log(`Popup GIS error: ${r.error} ${r.error_description || ""}`, "bad");
      saveToken(r.access_token, Number(r.expires_in || 3600), "popup GIS");
      log("Token recibido por popup GIS", "ok");
    },
    error_callback: (e) => log(`Popup GIS falló: ${e.type} ${e.message || ""}`, "bad"),
  });
  log("Abriendo popup GIS…");
  client.requestAccessToken();
}

// ---------- Drive ----------
async function drive(path, opts = {}) {
  const token = validToken();
  if (!token) throw new Error("sin token válido — haz login primero");
  const res = await fetch(path.startsWith("http") ? path : `https://www.googleapis.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

function multipartBody(metadata, content, mime) {
  const boundary = "gm" + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function findFile(q, spaces) {
  const params = new URLSearchParams({ q, spaces, fields: "files(id,name,modifiedTime)" });
  const r = await (await drive(`/drive/v3/files?${params}`)).json();
  return r.files[0] || null;
}

async function testAppData() {
  try {
    const payload = JSON.stringify({ test: "hola desde el iPad", at: new Date().toISOString(), ua: navigator.userAgent });
    const existing = await findFile("name='auth-test.json'", "appDataFolder");
    let id;
    if (existing) {
      await drive(`/upload/drive/v3/files/${existing.id}?uploadType=media`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: payload,
      });
      id = existing.id;
      log("appDataFolder: archivo existente actualizado", "ok");
    } else {
      const mp = multipartBody({ name: "auth-test.json", parents: ["appDataFolder"] }, payload, "application/json");
      const r = await (await drive("/upload/drive/v3/files?uploadType=multipart", {
        method: "POST", headers: { "Content-Type": mp.contentType }, body: mp.body,
      })).json();
      id = r.id;
      log("appDataFolder: archivo creado", "ok");
    }
    const back = await (await drive(`/drive/v3/files/${id}?alt=media`)).text();
    log(`appDataFolder: leído de vuelta → ${back}`, back === payload ? "ok" : "bad");
  } catch (e) { log(`appDataFolder falló: ${e.message}`, "bad"); }
}

async function testVisibleFolder() {
  try {
    let folder = await findFile(
      `name='${TEST_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, "drive");
    if (!folder) {
      folder = await (await drive("/drive/v3/files", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: TEST_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
      })).json();
      log(`Carpeta "${TEST_FOLDER}" creada en Mi unidad`, "ok");
    }
    const name = `prueba-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    const mp = multipartBody({ name, parents: [folder.id] }, "Archivo de prueba de Gmiser Reader.\n", "text/plain");
    await drive("/upload/drive/v3/files?uploadType=multipart", {
      method: "POST", headers: { "Content-Type": mp.contentType }, body: mp.body,
    });
    log(`"${name}" subido — debería verse en Drive dentro de "${TEST_FOLDER}"`, "ok");
  } catch (e) { log(`Carpeta visible falló: ${e.message}`, "bad"); }
}

async function listAppData() {
  try {
    const params = new URLSearchParams({ spaces: "appDataFolder", fields: "files(id,name,modifiedTime)" });
    const r = await (await drive(`/drive/v3/files?${params}`)).json();
    log(`appDataFolder contiene ${r.files.length} archivo(s): ${r.files.map((f) => `${f.name} (${f.modifiedTime})`).join(", ") || "—"}`);
  } catch (e) { log(`Listar falló: ${e.message}`, "bad"); }
}

// ---------- wiring ----------
$("btnRedirect").onclick = () => startRedirect(false);
$("btnSilent").onclick = () => startRedirect(true);
$("btnPopup").onclick = startPopup;
$("btnForget").onclick = () => { localStorage.removeItem(TOKEN_KEY); renderAuth(); log("Token olvidado"); };
$("btnAppData").onclick = testAppData;
$("btnFolder").onclick = testVisibleFolder;
$("btnList").onclick = listAppData;
$("btnClear").onclick = () => { $("log").innerHTML = ""; };
$("btnCopy").onclick = async () => {
  const text = [
    ...[...$("env").rows].map((r) => `${r.cells[0].textContent}: ${r.cells[1].textContent}`),
    ...[...$("auth").rows].map((r) => `${r.cells[0].textContent}: ${r.cells[1].textContent}`),
    "",
    $("log").innerText,
  ].join("\n");
  try { await navigator.clipboard.writeText(text); log("Copiado al portapapeles", "ok"); }
  catch (e) { log(`No se pudo copiar: ${e.message}`, "bad"); }
};

handleRedirectReturn();
renderAuth();
checkEnv();
log(`Arranque. Standalone=${matchMedia("(display-mode: standalone)").matches || navigator.standalone === true}`);
