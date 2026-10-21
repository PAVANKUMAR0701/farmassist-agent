/**
 * Voice in and out with the browser's Web Speech API (no extra service, no keys).
 * Speech input works in Chrome (Android and desktop), Edge and Safari; elsewhere the voice orb is disabled
 * and typing still works. The Alexa-style listening loop is in simulator.ts. Spoken replies use the device's own voices.
 */

export const VOICE_LANGUAGES: Array<[string, string]> = [
  ['en-IN', 'English'],
  ['hi-IN', 'हिन्दी'],
  ['ta-IN', 'தமிழ்'],
];

/// Minimal typings: SpeechRecognition is not in TypeScript's DOM library.
export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  /** Fired when the microphone really starts capturing (not every browser sends it). */
  onaudiostart?: (() => void) | null;
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

/** A new browser recogniser, or undefined where the browser has none. */
export function createRecognition(): Recognition | undefined {
  const Ctor = recognitionClass();
  return Ctor ? new Ctor() : undefined;
}

export class VoiceError extends Error {
  /** True when retrying will not help (permission blocked, no microphone): the UI should stop offering voice. */
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
  }
}

export const ERROR_MESSAGES: Record<string, [string, boolean]> = {
  'not-allowed': ['Microphone access is blocked. Allow the microphone for this site in your browser settings, or type instead.', true],
  'service-not-allowed': ['Voice input is turned off in this browser. Please type instead.', true],
  'audio-capture': ['No microphone was found. Please type instead.', true],
  'no-speech': ["I didn't hear anything. Tap the mic and speak, or type instead.", false],
  network: ['Voice input needs an internet connection. Please check it, or type instead.', false],
  'language-not-supported': ['This language is not available for voice on this device. Try English, or type instead.', false],
  'start-failed': ['Voice input could not start. Tap the orb to try again, or type instead.', false],
  'restart-loop': ['Voice input keeps stopping in this browser. Tap the orb to try again, or type instead.', false],
};

export function voiceError(code: string): VoiceError {
  const [message, permanent] = ERROR_MESSAGES[code] ?? ['Voice input stopped unexpectedly. Please try again, or type instead.', false];
  return new VoiceError(message, permanent);
}

/**
 * Joins recognised segments into one transcript. Android Chrome repeats earlier words in later final results
 * ("how much", "how much did I spend"), so a segment that already contains the text so far replaces it.
 */
export function joinSegments(segments: string[]): string {
  let text = '';
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    const a = text.toLowerCase();
    const s = seg.toLowerCase();
    if (!text || s.startsWith(a)) text = seg;
    else if (!a.endsWith(s)) text = `${text} ${seg}`;
  }
  return text;
}

/**
 * Final and still-changing (interim) text of one recognition session, rebuilt from all its results.
 * Results before `from` are skipped (talk already set aside, e.g. not addressed to the assistant).
 */
export function readResults(event: RecognitionResultEvent, from = 0): { final: string; interim: string; count: number } {
  const finals: string[] = [];
  const interims: string[] = [];
  for (let i = from; i < event.results.length; i++) {
    const r = event.results[i]!;
    (r.isFinal ? finals : interims).push(r[0].transcript);
  }
  return { final: joinSegments(finals), interim: joinSegments(interims), count: event.results.length };
}

/** Spellings recognisers produce for the wake word, in English, Hindi and Tamil. */
export const WAKE_WORDS = ['alexa', 'alexaa', 'alexia', 'elexa', 'aleksa', 'एलेक्सा', 'अलेक्सा', 'ऐलेक्सा', 'அலெக்சா', 'அலெக்ஸா', 'அலெக்ஸ்சா'];
const bareWord = (token: string) => token.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

/** Finds the wake word: `{ wake: true, command }` with the words said after it ("Alexa, how much…" -> "how much…"). */
export function extractCommand(text: string): { wake: boolean; command: string } {
  const tokens = text.trim().split(/\s+/);
  const at = tokens.findIndex((t) => WAKE_WORDS.includes(bareWord(t)));
  if (at < 0) return { wake: false, command: text.trim() };
  const command = tokens
    .slice(at + 1)
    .join(' ')
    .replace(/^[\s,.!?:;।-]+/u, '')
    .trim();
  return { wake: true, command };
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, '$1') // "2,500" (spoken text) and "2500" (recogniser) are the same
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ') // \p{M} keeps Hindi and Tamil vowel signs inside their words
    .trim();

/**
 * True when the microphone most likely heard the app's own spoken reply. Needs 3+ words, because a real
 * short answer ("yes", "haan") also appears inside the spoken question ("Say yes to save it").
 */
export function isEcho(heard: string, lastSpoken: string): boolean {
  const h = words(heard);
  return h.split(' ').length >= 3 && words(speakable(lastSpoken)).includes(h);
}

/** Model replies sometimes use Markdown ("**Geeta**", " - item"): show and say them as plain text. */
export function plainText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|[.,!?]|$)/g, '$1$2')
    .replace(/\s+-\s+(?=\S)/g, '\n• ')
    .trim();
}

/** Rewrites a reply so it sounds natural: "₹2,500.00" -> "2,500 rupees", "2026-10-14" -> "14 October 2026". */
export function speakable(text: string): string {
  return plainText(text)
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
    // Chrome sometimes never fires onend (long text, no voice installed); never wait forever, or the
    // voice simulator would stay in Speaking with the mic closed. About 12 characters a second, plus slack.
    const limit = setTimeout(() => (synth.cancel(), resolve()), 4000 + utterance.text.length * 90);
    const done = () => (clearTimeout(limit), resolve());
    utterance.onend = done;
    utterance.onerror = done;
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
