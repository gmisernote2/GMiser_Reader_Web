// Global reading preferences — the web subset of :shared's ReaderPreferences.kt. Dropped on
// purpose: lockPortrait (iOS has no orientation lock for web apps) and the fling-boost knobs
// (native iOS momentum scrolling can't be retuned without hijacking scroll). Added: keepAwake.

export const FONTS = [
  { id: "SERIF", name: "Literata", css: "'Literata'" },
  { id: "SANS", name: "Inter", css: "'Inter'" },
  { id: "MERRIWEATHER", name: "Merriweather", css: "'Merriweather'" },
  { id: "BITTER", name: "Bitter", css: "'Bitter'" },
  { id: "EB_GARAMOND", name: "EB Garamond", css: "'EB Garamond'" },
  { id: "ATKINSON_HYPERLEGIBLE", name: "Atkinson Hyperlegible", css: "'Atkinson Hyperlegible'" },
];
export const SKINS = [
  { id: "SEPIA", name: "Sepia" }, { id: "CLARO", name: "Claro" },
  { id: "OSCURO", name: "Oscuro" }, { id: "SISTEMA", name: "Sistema" },
];
export const POSITION_MODES = [{ id: "BOOK", name: "Libro" }, { id: "CHAPTER", name: "Capítulo" }, { id: "BOTH", name: "Ambos" }];
export const BRIGHTNESS_MODES = [
  { id: "OFF", name: "Apagado" }, { id: "GESTURE_LEFT", name: "Lado izquierdo" },
  { id: "GESTURE_RIGHT", name: "Lado derecho" }, { id: "SETTINGS_ONLY", name: "Solo en ajustes" },
];
export const TTS_LANGUAGES = [
  { id: "SPANISH_SPAIN", tag: "es-ES", name: "Español (España)" }, { id: "GERMAN", tag: "de-DE", name: "Alemán" },
  { id: "ENGLISH_US", tag: "en-US", name: "Inglés (EE. UU.)" }, { id: "FRENCH", tag: "fr-FR", name: "Francés" },
  { id: "ITALIAN", tag: "it-IT", name: "Italiano" }, { id: "PORTUGUESE", tag: "pt-PT", name: "Portugués" },
];

export const LIMITS = {
  MIN_FONT: 14, MAX_FONT: 35,
  MIN_LINE: 1.0, MAX_LINE: 2.0,
  MIN_BRIGHTNESS: 0.3, MAX_BRIGHTNESS: 1.0,
  MIN_AUTOHIDE: 2, MAX_AUTOHIDE: 10, ALWAYS_VISIBLE: 11,
};

const DEFAULTS = {
  fontFamily: "SERIF",
  fontSizeSp: 18,
  skin: "SISTEMA",
  lineSpacingMultiplier: 1.0,
  screenBrightness: 1.0,
  screenBrightnessMode: "GESTURE_LEFT",
  positionIndicatorMode: "BOOK",
  positionIndicatorEnabled: true,
  positionIndicatorAutoHideSeconds: 3,
  ttsLanguage: "SPANISH_SPAIN",
  keepAwake: true,
};

const KEY = "gmr.settings";
let current = load();
const listeners = new Set();

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = () => current;

export function update(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode etc. */ }
  listeners.forEach((fn) => fn(current, patch));
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

/** Pushes the typography/skin settings into CSS custom properties on <html>. */
export function applyToDocument(s = current) {
  const root = document.documentElement;
  const font = FONTS.find((f) => f.id === s.fontFamily) || FONTS[0];
  root.style.setProperty("--read-font", `${font.css}, Georgia, serif`);
  root.style.setProperty("--read-size", `${s.fontSizeSp}px`);
  // BASE_LINE_HEIGHT_RATIO (1.5, Material's bodyLarge 16/24) × the user's multiplier — Theme.kt.
  root.style.setProperty("--read-line", String(1.5 * s.lineSpacingMultiplier));
  const skin = s.skin === "SISTEMA" ? (darkQuery.matches ? "OSCURO" : "CLARO") : s.skin;
  root.dataset.skin = skin.toLowerCase();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || "#ECEBE6";
}

darkQuery.addEventListener("change", () => { if (current.skin === "SISTEMA") applyToDocument(); });
