// Read-aloud via the Web Speech API — one utterance per block, like TtsController.kt. Foreground
// only: iOS suspends speech as soon as the app is backgrounded or the screen locks.
// "Pause" is implemented as cancel + remember the block: speechSynthesis.pause() is unreliable on
// iOS, and restarting the current paragraph is a better resume point anyway.

import { plainText } from "./book.js";

export function createTts({ onBlockChange, onStateChange, onError }) {
  const synth = window.speechSynthesis;
  let blocks = [];
  let index = -1;
  let state = "idle"; // idle | speaking | paused
  let lang = "es-ES";
  let token = 0;

  const setState = (s) => { state = s; onStateChange(s); };

  function pickVoice() {
    const voices = synth.getVoices();
    const norm = (l) => (l || "").replace("_", "-").toLowerCase();
    const want = lang.toLowerCase();
    return voices.find((v) => norm(v.lang) === want)
      || voices.find((v) => norm(v.lang).startsWith(want.split("-")[0]))
      || null;
  }

  function speakFrom(i) {
    const my = ++token;
    while (i < blocks.length && (blocks[i].k === "img" || !plainText(blocks[i]).trim())) i++;
    if (i >= blocks.length) { stop(); return; }
    index = i;
    onBlockChange(index);
    const u = new SpeechSynthesisUtterance(plainText(blocks[i]));
    u.lang = lang;
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.onend = () => { if (my === token && state === "speaking") speakFrom(index + 1); };
    u.onerror = (e) => {
      if (my !== token || e.error === "interrupted" || e.error === "canceled") return;
      onError(`Error de voz: ${e.error}`);
      stop();
    };
    synth.speak(u);
  }

  function play(bookBlocks, fromIndex, languageTag) {
    if (!synth) return onError("Este dispositivo no admite lectura en voz alta");
    blocks = bookBlocks;
    lang = languageTag;
    synth.cancel();
    if (!pickVoice() && synth.getVoices().length) onError(`No hay voz instalada para ${languageTag}`);
    setState("speaking");
    speakFrom(fromIndex);
  }

  function pause() {
    if (state !== "speaking") return;
    token++;
    synth.cancel();
    setState("paused");
  }

  function resume() {
    if (state !== "paused") return;
    setState("speaking");
    speakFrom(index);
  }

  function stop() {
    token++;
    if (synth) synth.cancel();
    index = -1;
    onBlockChange(null);
    if (state !== "idle") setState("idle");
  }

  return { play, pause, resume, stop, get state() { return state; }, get index() { return index; } };
}
