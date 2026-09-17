/*
 * Озвучка встроенным синтезатором речи браузера (Web Speech API).
 * Голоса берутся из системы: на iPhone — голоса iOS, на Android — Google.
 */

const supported = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
const listeners = new Set();
let voice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const found = voices.find((v) => /^zh[-_]CN/i.test(v.lang))
    ?? voices.find((v) => /^(zh|cmn)/i.test(v.lang))
    ?? null;
  if (found !== voice) {
    voice = found;
    listeners.forEach((fn) => fn());
  }
}

if (supported) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
  // Safari не всегда присылает voiceschanged
  setTimeout(pickVoice, 500);
  setTimeout(pickVoice, 2000);
}

export const speaker = {
  get available() {
    return voice !== null;
  },

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  speak(text) {
    if (!voice) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 0.85;
    speechSynthesis.speak(utterance);
  },

  stop() {
    if (supported) speechSynthesis.cancel();
  },
};
