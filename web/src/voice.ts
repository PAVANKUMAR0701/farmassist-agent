/**
 * Voice in and out with the browser's Web Speech API (no extra service, no keys).
 * Speech input works in Chrome (Android and desktop), Edge and Safari; elsewhere the mic button is hidden
 * and typing still works. Spoken replies use the device's own voices.
 */

export const VOICE_LANGUAGES: Array<[string, string]> = [
  ['en-IN', 'English'],
  ['hi-IN', 'हिन्दी'],
  ['ta-IN', 'தமிழ்'],
];

// Minimal typings: SpeechRecognition is not in TypeScript's DOM library.
interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const speechInputSupported = () => recognitionClass() !== undefined && window.isSecureContext;
export const speechOutputSupported = () => 'speechSynthesis' in window;

export class VoiceError extends Error {
  /** True when retrying will not help (permission blocked, no microphone): the UI should stop offering voice. */
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
  }
}

const ERROR_MESSAGES: Record<string, [string, boolean]> = {
  'not-allowed': ['Microphone access is blocked. Allow the microphone for this site in your browser settings, or type instead.', true],
  'service-not-allowed': ['Voice input is turned off in this browser. Please type instead.', true],
  'audio-capture': ['No microphone was found. Please type instead.', true],
  'no-speech': ["I didn't hear anything. Tap the mic and speak, or type instead.", false],
  network: ['Voice input needs an internet connection. Please check it, or type instead.', false],
  'language-not-supported': ['This language is not available for voice on this device. Try English, or type instead.', false],
};

export interface Listening {
  /** Resolves with the final transcript (possibly empty when stopped early); rejects with VoiceError. */
  result: Promise<string>;
  stop(): void;
}

/** Starts listening once. `onInterim` receives the words heard so far, to show them while the farmer speaks. */
export function listen(lang: string, onInterim: (text: string) => void): Listening {
  const Ctor = recognitionClass();
  if (!Ctor) return { result: Promise.reject(new VoiceError('Voice input is not available in this browser. Please type instead.', true)), stop: () => {} };
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let failure: VoiceError | undefined;
  const result = new Promise<string>((resolve, reject) => {
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]!;
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim((finalText + interim).trim());
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted') return;
      const [message, permanent] = ERROR_MESSAGES[event.error] ?? ['Voice input stopped unexpectedly. Please try again, or type instead.', false];
      failure = new VoiceError(message, permanent);
    };
    recognition.onend = () => (failure ? reject(failure) : resolve(finalText.trim()));
  });
  try {
    recognition.start();
  } catch {
    return { result: Promise.reject(new VoiceError('Voice input could not start. Tap the mic again, or type instead.')), stop: () => {} };
  }
  return { result, stop: () => recognition.stop() };
}

/** Rewrites a reply so it sounds natural: "₹2,500.00" -> "2,500 rupees", "2026-10-14" -> "14 October 2026". */
export function speakable(text: string): string {
  return text
    .replace(/₹\s?([\d,]+)\.(\d{2})/g, (_m, whole: string, paise: string) => (paise === '00' ? `${whole} rupees` : `${whole} rupees ${Number(paise)} paise`))
    .replace(/₹\s?([\d,]+)/g, '$1 rupees')
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y: string, mo: string, d: string) =>
      new Date(`${y}-${mo}-${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    )
    .replace(/→/g, ' to ');
}

/** Speaks text in the chosen language. Resolves when finished (or immediately if speech is unavailable). */
export function speak(text: string, lang: string): Promise<void> {
  if (!speechOutputSupported() || !text) return Promise.resolve();
  const synth = window.speechSynthesis;
  synth.cancel(); // never talk over the previous reply
  const utterance = new SpeechSynthesisUtterance(speakable(text));
  utterance.lang = lang;
  const voices = synth.getVoices();
  utterance.voice = voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(lang.slice(0, 2))) ?? null;
  utterance.rate = 0.95;
  return new Promise((resolve) => {
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}

// Per-device preferences (a convenience only; the app works without them).
const PREFS_KEY = 'farmassist.voice';
export interface VoicePrefs {
  lang: string;
  speakReplies: boolean;
}
export function loadVoicePrefs(): VoicePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<VoicePrefs>;
    return { lang: VOICE_LANGUAGES.some(([l]) => l === saved.lang) ? saved.lang! : 'en-IN', speakReplies: saved.speakReplies !== false };
  } catch {
    return { lang: 'en-IN', speakReplies: true };
  }
}
export function saveVoicePrefs(prefs: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
