/**
 * The four screens. Every amount shown is a display string computed by the server (totalDisplay,
 * amountDisplay): the client never adds anything up.
 */
import { ApiError, displayName, readTool, sendChat, sendPhoto, type ChatReply } from './api.js';
import { shrinkPhoto } from './photo.js';
import { append, badge, clear, h, icon, label, notice, pageHeader, shortDate, spinner, type IconName } from './dom.js';
import { VoiceSimulator, type SimState, type SimView } from './simulator.js';
import { createRecognition, plainText, loadVoicePrefs, loadVoices, voicesFor, lastSpeakSkippedFor, saveVoicePrefs, speak, speechInputSupported, speechOutputSupported, stopSpeaking, VOICE_LANGUAGES } from './voice.js';

const CATEGORIES = ['feed', 'fodder', 'medicine', 'labour', 'fuel', 'equipment', 'seed', 'other'];
const ACTIVITY_TYPES = ['milking', 'vaccination', 'sowing', 'harvesting', 'irrigation', 'other'];
const PERIODS: Array<[string, string]> = [
  ['today', 'Today'],
  ['this_week', 'This week'],
  ['last_7_days', 'Last 7 days'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
];

interface EntryView {
  entryId: string;
  date: string;
  category: string;
  amountDisplay: string;
  note?: string;
}
interface ActivityView {
  entryId: string;
  date: string;
  activityType: string;
  animalOrField?: string;
  note?: string;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong. Please try again.');

function select(name: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h('select', { 'aria-label': name, onchange: () => onChange(el.value) }, ...options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
  return el;
}

// ---------------------------------------------------------------- Chat

const CONVERSATION_KEY = 'farmassist.conversation';
/**
 * Questions are sent straight away. Examples that would save a record only fill the box, so one tap never
 * writes to the farm ledger: the farmer edits the amount and presses Send.
 */
const SUGGESTIONS: Array<{ text: string; send: boolean; icon: IconName; more?: boolean }> = [
  { text: 'How much did I spend today?', send: true, icon: 'question' },
  { text: "Today's summary", send: true, icon: 'doc' },
  { text: 'How much on feed this month?', send: true, icon: 'sprout' },
  { text: 'How was my week?', send: true, icon: 'chart' },
  { text: 'Show milk records', send: true, icon: 'milk' },
  // Behind "View more"
  { text: 'Show my crops', send: true, icon: 'leaf', more: true },
  { text: 'What is due this week?', send: true, icon: 'bell', more: true },
  { text: 'Spent 500 on cattle feed', send: false, icon: 'plus', more: true },
  { text: 'Lakshmi gave 8 litres this morning', send: false, icon: 'plus', more: true },
];

/** The ALEXA+ wordmark (text with a curved underline), shown as supporting integration branding. */
function alexaMark(): HTMLElement {
  const mark = h('span', { class: 'alexa-mark', role: 'img', 'aria-label': 'Alexa+', title: 'Alexa-style voice simulator for this demo, not an Amazon device' });
  mark.innerHTML =
    '<svg viewBox="0 0 120 34" aria-hidden="true"><text x="60" y="20" text-anchor="middle" font-size="19" font-weight="800" letter-spacing="2" fill="currentColor">ALEXA+</text>' +
    '<path d="M28 25 Q60 34 92 25" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  return mark;
}

/** Set by chatView: puts text in the assistant's box and focuses it (used by "Record in chat" buttons). */
let fillComposer: ((text: string) => void) | undefined;

/** Opens the assistant with `text` ready to edit. On a phone that means going to the Ask screen. */
export function askAssistant(text: string): void {
  const fill = () => fillComposer?.(text);
  if (!window.matchMedia(DESKTOP_QUERY).matches && location.hash !== '#/chat') {
    // The shell re-renders on hashchange (its listener was added first); fill once the assistant is on screen.
    window.addEventListener('hashchange', fill, { once: true });
    location.hash = '#/chat';
  } else fill();
}

/** Wide screens show the assistant beside every screen instead of on its own tab. */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** Set by chatView: turns the voice simulator off (when the assistant leaves the screen, or on sign-out). */
let stopVoice: (() => void) | undefined;
export const pauseVoice = () => stopVoice?.();

/**
 * Voice event log for diagnosing a real phone: on only with ?voicedebug=1 (remembered on this device),
 * kept in memory, shown in the assistant panel with a Copy button. Never sent anywhere.
 */
const VOICE_DEBUG_KEY = 'farmassist.voiceDebug';
const voiceDebug = (() => {
  try {
    const param = new URLSearchParams(location.search).get('voicedebug');
    if (param === '1') localStorage.setItem(VOICE_DEBUG_KEY, '1');
    if (param === '0') localStorage.removeItem(VOICE_DEBUG_KEY);
    return localStorage.getItem(VOICE_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
})();
const voiceLog: string[] = [];
let voiceLogView: HTMLElement | undefined;
const started = Date.now();
function trace(event: string, detail?: string): void {
  if (!voiceDebug) return;
  const line = `${((Date.now() - started) / 1000).toFixed(1).padStart(7)}s  ${event}${detail ? `  ${detail}` : ''}`;
  voiceLog.push(line);
  if (voiceLog.length > 400) voiceLog.shift();
  if (voiceLogView) voiceLogView.textContent = voiceLog.slice(-12).join('\n');
}

/** A short two-note tone ("your turn"). Web Audio, so no file to load; silent where unsupported. */
let audio: AudioContext | undefined;
let audioIdle: ReturnType<typeof setTimeout> | undefined;
function chime(): void {
  try {
    audio ??= new AudioContext();
    trace('chime');
    void audio.resume();
    // Let go of the audio output again after the tone: an idle open output can click on some phones.
    clearTimeout(audioIdle);
    audioIdle = setTimeout(() => void audio?.suspend(), 600);
    const now = audio.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.16);
      osc.connect(gain).connect(audio!.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.18);
    });
  } catch {
    /* no sound: the orb still shows Listening */
  }
}

const SIM_TEXT: Record<SimState, { status: string; orb: string }> = {
  off: { status: 'Tap the mic or type a request', orb: 'Talk now' },
  ready: { status: 'Say "Alexa" and your request', orb: 'Talk now' },
  listening: { status: 'Listening…', orb: 'Stop listening' },
  processing: { status: 'Thinking…', orb: 'Working on it' },
  speaking: { status: 'Speaking…', orb: 'Stop speaking' },
  error: { status: 'Error — voice stopped', orb: 'Try voice again' },
};

/** "MCP tool calls" above a reply: one row per call, tap to see what was sent and what came back. */
function toolCallList(actions: ChatReply['actions']): HTMLElement {
  return h(
    'div',
    { class: 'tool-calls' },
    h('p', { class: 'tool-calls-title' }, 'MCP tool calls'),
    ...actions.map((a) =>
      h(
        'details',
        { class: `tool-call${a.ok ? '' : ' failed'}` },
        h(
          'summary',
          {},
          h('span', { class: 'tc-mark', 'aria-label': a.ok ? 'Succeeded' : 'Failed' }, a.ok ? '✓' : '✗'),
          h('code', { class: 'tc-name' }, a.tool),
          h('span', { class: 'tc-text' }, a.text),
          a.ms !== undefined ? h('span', { class: 'tc-ms' }, `${a.ms}ms`) : null,
          h('span', { class: 'tc-chevron' }, icon('chevron')),
        ),
        h(
          'div',
          { class: 'tc-body' },
          h('p', { class: 'tc-label' }, 'Result'),
          h('p', {}, a.text),
          a.input && Object.keys(a.input).length ? h('p', { class: 'tc-label' }, 'Input') : null,
          a.input && Object.keys(a.input).length ? h('pre', {}, JSON.stringify(a.input, null, 1)) : null,
        ),
      ),
    ),
  );
}

function voiceDebugPanel(): HTMLElement {
  voiceLogView = h('pre', { class: 'voice-log', 'aria-label': 'Voice log' }, voiceLog.slice(-12).join('\n'));
  const copy = h('button', { type: 'button', class: 'sim-toggle' }, 'Copy voice log');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(voiceLog.join('\n'));
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed: select the text instead';
    }
  });
  return h('div', { class: 'voice-debug' }, h('p', { class: 'try-title' }, 'Voice log (debug)'), voiceLogView, copy);
}

export function chatView(): HTMLElement {
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const input = h('input', { type: 'text', maxlength: '500', 'aria-label': 'Message to FarmAssist', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Ask FarmAssist…' });
  const send = h('button', { type: 'submit', class: 'send', 'aria-label': 'Send', title: 'Send' }, icon('send'));
  const prefs = loadVoicePrefs();
  const voiceInput = speechInputSupported();
  const voiceOutput = speechOutputSupported();
  let openConfirmation: HTMLElement | undefined;
  /** True while a message or photo is with the server: stops double submissions from taps, chips and Enter. */
  let busy = false;
  let conversationId: string | undefined;
  try {
    conversationId = sessionStorage.getItem(CONVERSATION_KEY) ?? undefined;
  } catch {
    conversationId = undefined;
  }

  const bubble = (who: 'me' | 'bot', ...content: Array<Node | string | null>) => {
    const el = h('div', { class: `bubble bubble-${who}` }, ...content);
    log.appendChild(el);
    requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
    return el;
  };
  const thinking = (text: string) => bubble('bot', h('p', { class: 'typing' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), text));

  const setBusy = (on: boolean) => {
    busy = on;
    send.disabled = on;
    camera.disabled = on;
    log.setAttribute('aria-busy', String(on));
  };

  const showReply = (reply: ChatReply) => {
    // Every MCP tool call behind the reply, as the server reported it. Tap one to see its input and result.
    if (reply.actions.length) log.appendChild(toolCallList(reply.actions));
    // Something was saved: let the screen beside the assistant reload its records.
    if (reply.actions.some((x) => x.ok && !/^(get|list|search)_|^weekly_insights$/.test(x.tool))) window.dispatchEvent(new Event('farmassist:changed'));
    const mode = reply.mode === 'fallback' ? h('div', { class: 'mode' }, reply.modelUnavailable ? 'Basic mode: the AI assistant is unavailable right now.' : 'Basic mode') : null;
    let buttons: HTMLElement | null = null;
    if (reply.awaitingConfirmation) {
      const answer = async (text: string) => {
        sim.cancelCommand(); // the farmer answered by tapping, so stop waiting for a spoken yes/no
        const next = await submit(text, true);
        if (next) void sim.say(next.reply);
      };
      buttons = openConfirmation = h(
        'div',
        { class: 'confirm' },
        h('button', { type: 'button', class: 'primary', onclick: () => void answer('yes') }, 'Yes, save'),
        h('button', { type: 'button', class: 'secondary', onclick: () => void answer('no') }, 'No'),
      );
    }
    bubble('bot', h('p', { class: 'lines' }, plainText(reply.reply)), buttons, mode);
  };

  /** Sends one message and shows the reply. `spoken` marks voice: the backend then reads changes back first. */
  async function submit(text: string, spoken = false): Promise<ChatReply | undefined> {
    const message = text.trim();
    if (!message || busy) return undefined;
    // Any next message answers (or drops) the pending confirmation, so its buttons stop working.
    openConfirmation?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    openConfirmation = undefined;
    stopSpeaking();
    if (!spoken) input.value = '';
    simBox.classList.add('compact'); // like a voice assistant: the orb steps aside once the conversation starts
    log.querySelector('.try')?.remove();
    bubble('me', h('p', {}, message), spoken ? h('span', { class: 'spoken', title: 'Spoken' }, '🎤') : null);
    const pending = thinking('Thinking…');
    setBusy(true);
    try {
      const reply = await sendChat(message, conversationId, spoken);
      conversationId = reply.conversationId;
      try {
        sessionStorage.setItem(CONVERSATION_KEY, conversationId);
      } catch {
        /* the conversation just won't survive a reload */
      }
      pending.remove();
      showReply(reply);
      // "Voice replies on" means every reply is read aloud, typed or tapped too (spoken ones are read by the
      // simulator itself). say() closes the mic while speaking so the reply is never heard as a command.
      if (!spoken && voiceOutput && prefs.speakReplies) void sim.say(reply.reply);
      return reply;
    } catch (error) {
      pending.remove();
      bubble('bot', notice('error', errorText(error), () => void submit(message, spoken)));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  // ---- Alexa-style voice simulator (like Pantry Pilot's): big orb until the conversation starts, then a header row
  const orb = h('button', { type: 'button', class: 'orb', 'data-state': 'off' }, h('span', { class: 'orb-core' }, icon('mic')));
  const status = h('p', { class: 'sim-status', 'aria-live': 'polite' });
  const hint = h('p', { class: 'sim-hint' });
  /** The round mic beside Send: talk now, no wake word needed. Red with a stop square while listening. */
  const talk = h('button', { type: 'button', class: 'talk', 'data-state': 'off' }, icon('mic'));
  const waves = (side: string) => h('span', { class: `orb-waves orb-waves-${side}`, 'aria-hidden': 'true' }, icon('waves'));
  const simBox = h(
    'div',
    { class: 'sim ask-card' },
    h('div', { class: 'ask-head' }, h('p', { class: 'ask-title' }, 'Ask FarmAssist')),
    h('p', { class: 'ask-desc' }, 'Get insights about your farm, expenses, animals, crops and more.'),
    h('div', { class: 'orb-wrap' }, waves('left'), orb, waves('right')),
    h('div', { class: 'sim-text' }, h('p', { class: 'sim-kicker' }, 'Alexa-style simulator'), status, hint),
    alexaMark(),
  );
  /** Hands-free: after each reply the mic stays on and waits for "Alexa". Off by default: the mic is never on unasked. */
  let handsFree = false;
  const render = (state: SimState, view: SimView) => {
    const text = SIM_TEXT[state];
    orb.dataset.state = state;
    orb.setAttribute('aria-label', text.orb);
    orb.title = text.orb;
    orb.disabled = state === 'processing';
    // While listening, the words heard replace the status, as on a voice assistant's screen.
    // "One moment" until the phone's mic is really capturing: words said before that are lost.
    status.textContent = view.transcript
      ? `“${view.transcript}”`
      : state === 'listening' && view.starting
        ? 'One moment…'
        : state === 'listening' && view.confirming
          ? 'Listening for yes or no…'
          : state === 'listening' && view.followUp
            ? "Anything else? I'm listening…"
            : text.status;
    status.classList.toggle('heard', Boolean(view.transcript));
    hint.textContent = view.message ?? (state === 'listening' && view.confirming && !view.transcript ? 'Say "yes" to save it, or "no" to cancel.' : '');
    hint.classList.toggle('err', Boolean(view.message));
    talk.dataset.state = state;
    talk.disabled = state === 'processing';
    talk.setAttribute('aria-label', text.orb);
    talk.title = text.orb;
    talk.replaceChildren(icon(state === 'listening' || state === 'speaking' ? 'stop' : 'mic'));
    input.placeholder = state === 'listening' ? 'Listening…' : 'Ask FarmAssist…';
  };
  /** Reads a reply aloud with the farmer's voice choice; says once if this browser cannot speak the language. */
  const skipNoticeShown = new Set<string>();
  async function speakReply(text: string): Promise<void> {
    await speak(text, prefs.lang, prefs.voiceName);
    if (lastSpeakSkippedFor && !skipNoticeShown.has(lastSpeakSkippedFor)) {
      skipNoticeShown.add(lastSpeakSkippedFor);
      const name = VOICE_LANGUAGES.find(([l]) => l === lastSpeakSkippedFor)?.[1] ?? lastSpeakSkippedFor;
      bubble('bot', notice('info', `This browser has no ${name} voice, so replies are shown as text only. Microsoft Edge includes ${name} voices; or choose English.`));
    }
  }

  const sim = new VoiceSimulator({
    createRecognition,
    lang: () => prefs.lang,
    submit: (command) => submit(command, true),
    speakEnabled: () => voiceOutput && prefs.speakReplies,
    speak: (text) => (trace('tts', `${text.length} chars`), speakReply(text)),
    stopSpeaking,
    chime,
    onChange: render,
    onIncomplete: (text) => {
      bubble('bot', notice('info', 'I may have missed some words. Check the text below and press Send, or tap the mic and try again.'));
      fillComposer?.(text);
    },
    onNotice: (text) => bubble('bot', notice('info', text)),
    handsFree: () => handsFree,
    trace,
  });
  stopVoice = () => sim.isActive && sim.stop();
  orb.addEventListener('click', () => sim.talk());
  talk.addEventListener('click', () => sim.talk());
  render('off', {});
  if (!voiceInput) {
    orb.disabled = true;
    orb.setAttribute('aria-label', 'Voice input is not available in this browser');
    status.textContent = 'Type a request';
    hint.textContent = window.isSecureContext ? 'Voice is not available in this browser. Try Chrome or Edge.' : 'Voice needs a secure (https) page.';
  }

  // Photo help: a sick animal or a crop problem. Any text in the box goes along as the farmer's note.
  const photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden-file', 'aria-label': 'Photo', tabindex: '-1' });
  const camera = h('button', { type: 'button', class: 'tool', 'aria-label': 'Send a photo of a sick animal or crop', title: 'Photo help' }, icon('camera'));
  camera.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file || busy) return;
    const note = input.value.trim();
    input.value = '';
    stopSpeaking();
    sim.cancelCommand();
    let shrunk: { base64: string; previewUrl: string };
    try {
      shrunk = await shrinkPhoto(file);
    } catch {
      bubble('bot', notice('error', 'That photo could not be opened. Please try another one.'));
      return;
    }
    bubble('me', h('img', { class: 'photo', src: shrunk.previewUrl, alt: 'Photo sent for help' }), note ? h('p', {}, note) : null);
    const pending = thinking('Looking at the photo…');
    setBusy(true);
    try {
      const answer = await sendPhoto(shrunk.base64, 'jpeg', note || undefined);
      pending.remove();
      const box = bubble('bot', answer.urgent ? badge('Needs attention', 'danger') : null, h('p', { class: 'lines' }, answer.reply));
      if (answer.urgent) box.classList.add('urgent');
      void sim.say(answer.reply); // read aloud when voice replies are on
    } catch (error) {
      pending.remove();
      bubble('bot', notice('error', errorText(error)));
    } finally {
      setBusy(false);
    }
  });

  const newChat = () => {
    if (busy) return;
    stopSpeaking();
    sim.cancelCommand();
    conversationId = undefined;
    try {
      sessionStorage.removeItem(CONVERSATION_KEY);
    } catch {
      /* ignore */
    }
    clear(log);
    simBox.classList.remove('compact');
    greet();
  };

  /** "Try saying" examples, shown until the conversation starts. Questions are sent; record examples only fill the box. */
  const greet = () => {
    const item = (text: string, iconName: IconName, onclick: () => void, extra = '', title = 'Ask this') =>
      h('button', { class: `try-item${extra}`, type: 'button', title, onclick }, h('span', { class: 'try-icon' }, icon(iconName)), h('span', { class: 'try-text' }, text), h('span', { class: 'try-chevron' }, icon('chevron')));
    const list = h('div', { class: 'try', role: 'group', 'aria-label': 'Try saying' });
    const more = h('button', { class: 'try-more', type: 'button', 'aria-expanded': 'false' }, 'View more', icon('chevronDown'));
    more.addEventListener('click', () => {
      const open = !list.classList.contains('show-more');
      list.classList.toggle('show-more', open);
      more.setAttribute('aria-expanded', String(open));
      more.replaceChildren(open ? 'View less' : 'View more', icon('chevronDown'));
    });
    list.append(
      h('p', { class: 'try-title' }, icon('waves'), 'Try saying'),
      ...SUGGESTIONS.map((s) =>
        item(
          `“${s.text}”`,
          s.icon,
          () => (s.send ? void submit(s.text) : fillComposer?.(s.text)),
          `${s.send ? '' : ' fill'}${s.more ? ' more' : ''}`,
          s.send ? 'Ask this' : 'Put this in the box to edit, then press Send',
        ),
      ),
      item('Check a crop or animal photo', 'camera', () => camera.click(), ' fill more', 'Send a photo'),
      more,
    );
    log.appendChild(list);
  };

  fillComposer = (text: string) => {
    input.value = text;
    input.focus();
    input.setSelectionRange(text.length, text.length);
  };

  const speaker = h('button', { type: 'button', class: 'sim-toggle', 'aria-pressed': String(prefs.speakReplies) });
  const showSpeaker = () => {
    speaker.replaceChildren(icon(prefs.speakReplies ? 'volume' : 'mute'), prefs.speakReplies ? 'Voice replies on' : 'Voice replies off');
    speaker.setAttribute('aria-pressed', String(prefs.speakReplies));
  };
  speaker.addEventListener('click', () => {
    prefs.speakReplies = !prefs.speakReplies;
    saveVoicePrefs(prefs);
    if (!prefs.speakReplies) stopSpeaking();
    showSpeaker();
  });
  showSpeaker();
  const handsFreeButton = h('button', { type: 'button', class: 'sim-toggle hands-free', 'aria-pressed': 'false' });
  const showHandsFree = () => {
    handsFreeButton.replaceChildren(icon(handsFree ? 'mic' : 'micoff'), handsFree ? 'Hands-free on' : 'Hands-free off');
    handsFreeButton.setAttribute('aria-pressed', String(handsFree));
    handsFreeButton.title = handsFree ? 'The mic stays on and waits for "Alexa"' : 'Turn on to keep the mic waiting for "Alexa"';
  };
  handsFreeButton.addEventListener('click', () => {
    handsFree = !handsFree;
    showHandsFree();
    sim.handsFreeChanged(handsFree);
  });
  showHandsFree();
  // Reply voice: this browser's voices for the chosen language (female first). Saved by name, and used only
  // when this browser has that voice; otherwise the automatic female choice (see pickVoice in voice.ts).
  const voiceSelect = h('select', { 'aria-label': 'Reply voice' }, h('option', { value: '' }, 'Automatic (female voice)'));
  const fillVoices = async () => {
    const list = voicesFor(await loadVoices(), prefs.lang);
    voiceSelect.replaceChildren(
      h('option', { value: '' }, list.length ? 'Automatic (female voice)' : 'No voice for this language in this browser'),
      ...list.map((v) => h('option', { value: v.name, selected: v.name === prefs.voiceName }, `${v.name.replace(/^(Microsoft|Google) /, '').replace(/ Online \(Natural\)/, '')} · ${v.lang}`)),
    );
  };
  void fillVoices();
  voiceSelect.addEventListener('change', () => {
    if (voiceSelect.value) prefs.voiceName = voiceSelect.value;
    else delete prefs.voiceName;
    saveVoicePrefs(prefs);
    if (voiceOutput) void speakReply(prefs.lang.startsWith('hi') ? 'नमस्ते, मैं फार्म असिस्ट हूँ।' : prefs.lang.startsWith('ta') ? 'வணக்கம், நான் ஃபார்ம் அசிஸ்ட்.' : 'Namaste, I am FarmAssist.');
  });
  const language = select('Voice language', VOICE_LANGUAGES, prefs.lang, (v) => {
    prefs.lang = v;
    delete prefs.voiceName; // a saved voice belongs to one language
    void fillVoices();
    saveVoicePrefs(prefs);
    if (sim.isActive) {
      sim.stop(); // a recogniser keeps the language it started with
      sim.start();
    }
  });

  // The round button on the right is always the microphone. Typed text is sent with Enter, or with the small
  // arrow that appears inside the box only while there is text.
  const showSend = (): void => void form.classList.toggle('has-text', input.value.trim().length > 0);
  input.addEventListener('input', showSend);
  const keyboard = h('span', { class: 'composer-icon', 'aria-hidden': 'true' }, icon('keyboard'));
  const form: HTMLFormElement = h(
    'form',
    { class: 'composer', onsubmit: (e: Event) => (e.preventDefault(), sim.cancelCommand(), void submit(input.value), showSend()) },
    h('span', { class: 'input-box' }, keyboard, input, send),
    photoInput,
    voiceInput ? talk : null,
  );
  // Settings: hands-free, photo help and a new chat, out of the way of the main controls.
  const settings = h(
    'details',
    { class: 'settings-menu', ontoggle: () => void fillVoices() },
    h('summary', { 'aria-label': 'Voice and chat settings', title: 'Settings' }, icon('settings')),
    h(
      'div',
      { class: 'menu', role: 'menu' },
      voiceInput ? handsFreeButton : null,
      h('button', { type: 'button', class: 'sim-toggle', onclick: () => camera.click() }, icon('camera'), 'Send a crop or animal photo'),
      h('button', { type: 'button', class: 'sim-toggle', onclick: () => newChat() }, icon('plus'), 'New chat'),
      voiceOutput ? h('label', { class: 'voice-pick' }, h('span', {}, icon('volume'), 'Reply voice'), voiceSelect) : null,
    ),
  );
  const languageBox = h('label', { class: 'lang-box' }, icon('globe'), language);
  greet();
  return h(
    'section',
    { class: 'assistant', 'aria-label': 'FarmAssist assistant' },
    simBox,
    log,
    h(
      'div',
      { class: 'composer-wrap' },
      form,
      h('div', { class: 'sim-controls' }, voiceOutput ? speaker : null, voiceInput || voiceOutput ? languageBox : null, settings),
      h('p', { class: 'composer-hint sr-only' }, 'A voice simulator for this demo, not an Amazon device.'),
      voiceDebug ? voiceDebugPanel() : null,
    ),
  );
}

// ---------------------------------------------------------------- Today (dashboard)

interface DailySummary {
  date: string;
  expenseTotalDisplay: string;
  expenseCount: number;
  byCategory: Array<{ category: string; totalDisplay: string; entryCount: number }>;
  activities: ActivityView[];
  milkTotalMillilitres: number;
  milkTotalDisplay: string;
}
interface ExpenseSummary {
  totalDisplay: string;
  entryCount: number;
  range: { from: string; to: string };
  groups: Array<{ key: string; totalDisplay: string; entryCount: number }>;
}
interface WeeklyInsights {
  narrative: string;
  narrationSource: 'bedrock' | 'template';
}

export interface ReminderItem {
  source: 'reminder' | 'insurance';
  title: string;
  dueDate: string;
  daysLeft: number;
  overdue: boolean;
}

const dueLabel = (i: ReminderItem) => (i.overdue ? `${plural(-i.daysLeft, 'day', 'days')} overdue` : i.daysLeft === 0 ? 'Due today' : `In ${plural(i.daysLeft, 'day', 'days')}`);
const dueTone = (i: ReminderItem) => (i.overdue ? 'danger' : i.daysLeft <= 3 ? 'warn' : 'neutral');

const fetchReminders = (days: number) => readTool<{ items: ReminderItem[] }>('list_reminders', { daysAhead: days });

/** Reminders and insurance renewals due in the next `days` days (and anything overdue), soonest first. */
export async function upcomingList(days: number, loaded?: Promise<{ data: { items: ReminderItem[] } }>): Promise<Node> {
  const { data } = await (loaded ?? fetchReminders(days));
  if (data.items.length === 0) return emptyState('bell', `Nothing due in the next ${plural(days, 'day', 'days')}.`, 'Ask in chat: "Remind me to deworm the calves on Friday".');
  return h(
    'ul',
    { class: 'rows' },
    ...data.items.map((i) =>
      h(
        'li',
        { class: i.overdue ? 'row overdue' : 'row' },
        h('span', { class: `row-icon${i.overdue ? '' : ' ok'}` }, icon(i.source === 'insurance' ? 'shield' : 'bell')),
        h('span', { class: 'row-main' }, h('strong', {}, i.title), h('span', { class: 'muted small' }, `${i.source === 'insurance' ? 'Insurance renewal' : 'Reminder'} · ${shortDate(i.dueDate)}`)),
        badge(dueLabel(i), dueTone(i)),
      ),
    ),
  );
}

export const emptyState = (name: IconName, text: string, hint?: string) =>
  h('div', { class: 'empty', role: 'status' }, h('span', { class: 'empty-icon' }, icon(name)), h('p', {}, text), hint ? h('p', { class: 'muted small' }, hint) : null);

export function card(title: string, body: HTMLElement, opts: { icon?: IconName; action?: Node; className?: string } = {}): HTMLElement {
  return h(
    'article',
    { class: `card${opts.className ? ` ${opts.className}` : ''}` },
    h('div', { class: 'card-head' }, opts.icon ? h('span', { class: 'card-icon' }, icon(opts.icon)) : null, h('h3', {}, title), opts.action ?? null),
    body,
  );
}

export async function fillCard(body: HTMLElement, load: () => Promise<Node>) {
  clear(body);
  body.appendChild(spinner());
  try {
    const content = await load();
    clear(body);
    body.appendChild(content);
  } catch (error) {
    clear(body);
    body.appendChild(notice('error', errorText(error), () => void fillCard(body, load)));
  }
}

export const breakdown = (rows: Array<{ name: string; value: string; count: number }>) =>
  h('ul', { class: 'breakdown' }, ...rows.map((r) => h('li', {}, h('span', {}, `${label(r.name)} `, h('span', { class: 'muted small' }, `(${r.count})`)), h('strong', {}, r.value))));

const CATEGORY_ICONS: Record<string, IconName> = { feed: 'leaf', fodder: 'sprout', medicine: 'pill', labour: 'user', fuel: 'fuel', equipment: 'wrench', seed: 'sprout', other: 'dots' };
/** Expense categories (or milk, activities) as rows with an icon, a label and a right-aligned value. */
const iconRows = (rows: Array<{ icon: IconName; name: string; count?: number; value: string }>) =>
  h(
    'ul',
    { class: 'breakdown icon-rows' },
    ...rows.map((r) =>
      h('li', {}, h('span', { class: 'row-lead' }, h('span', { class: 'mini-icon' }, icon(r.icon)), r.name, r.count !== undefined ? h('span', { class: 'muted small' }, ` (${r.count})`) : null), h('strong', {}, r.value)),
    ),
  );
const categoryRows = (groups: Array<{ key: string; value: string; count: number }>) =>
  iconRows(groups.map((g) => ({ icon: CATEGORY_ICONS[g.key] ?? 'dots', name: label(g.key), count: g.count, value: g.value })));

/** A summary tile on the home screen. It links only to a screen that shows the same records in full. */
function statTile(
  href: string,
  name: IconName,
  title: string,
  load: () => Promise<{ value: string; sub: string; tone?: 'warn' | 'danger' }>,
  accent = 'green',
  art: IconName = name,
): HTMLElement {
  const value = h('span', { class: 'stat-value skeleton' }, '…');
  const sub = h('span', { class: 'stat-sub' }, 'Loading…');
  const tile = h(
    'a',
    { class: `stat stat-accent-${accent}`, href },
    h('span', { class: 'stat-top' }, h('span', { class: 'stat-icon' }, icon(name)), h('span', { class: 'stat-label' }, title), h('span', { class: 'stat-chevron' }, icon('chevron'))),
    value,
    sub,
    h('span', { class: 'stat-art', 'aria-hidden': 'true' }, icon(art)),
  );
  load()
    .then((r) => {
      value.classList.remove('skeleton');
      value.textContent = r.value;
      sub.textContent = r.sub;
      if (r.tone) tile.classList.add(`stat-${r.tone}`);
    })
    .catch(() => {
      value.classList.remove('skeleton');
      value.textContent = '—';
      sub.textContent = 'Could not load. Tap Refresh.';
    });
  return tile;
}

interface AnimalsResult {
  total: number;
  byType: Array<{ type: string; count: number }>;
}

const ANIMAL_PLURALS: Record<string, string> = { calf: 'calves', sheep: 'sheep', buffalo: 'buffaloes' };
/** "4 cows · 1 calf" */
export const animalCounts = (byType: Array<{ type: string; count: number }>) =>
  byType.map((t) => plural(t.count, t.type, ANIMAL_PLURALS[t.type] ?? `${t.type}s`)).join(' · ');

const greeting = () => {
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = displayName().split(/[\s@._]/)[0];
  return first ? `${hello}, ${first.charAt(0).toUpperCase()}${first.slice(1)}` : hello;
};
const longToday = () => new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function todayView(): HTMLElement {
  const tiles = h('div', { class: 'stats' });
  const today = h('div');
  const month = h('div');
  const upcoming = h('div');
  const week = h('div');

  const load = () => {
    // Each tool is asked once; the tiles and the cards below share the answer.
    const daily = readTool<DailySummary>('get_daily_summary');
    const reminders = fetchReminders(7);
    clear(tiles);
    append(
      tiles,
      statTile('#/expenses', 'wallet', 'Spent today', async () => {
        const { data } = await daily;
        return { value: data.expenseTotalDisplay, sub: plural(data.expenseCount, 'expense', 'expenses') };
      }, 'green', 'chart'),
      statTile('#/farm', 'milk', 'Milk today', async () => {
        const { data } = await daily;
        return data.milkTotalMillilitres > 0 ? { value: data.milkTotalDisplay, sub: 'Recorded today' } : { value: '—', sub: 'Not recorded yet' };
      }, 'blue', 'waves'),
      statTile('#/farm', 'cow', 'Animals', async () => {
        const { data } = await readTool<AnimalsResult>('list_animals');
        return { value: String(data.total), sub: data.total ? animalCounts(data.byType) : 'None registered' };
      }, 'amber'),
      statTile('#/farm', 'sprout', 'Growing crops', async () => {
        const { data } = await readTool<{ crops: Array<{ status: string; crop: string }> }>('list_crops');
        const growing = data.crops.filter((c) => c.status === 'growing');
        return { value: String(growing.length), sub: growing.length ? [...new Set(growing.map((c) => label(c.crop)))].join(', ') : 'None growing' };
      }, 'mint', 'leaf'),
      statTile('#/farm', 'bell', 'Due soon', async () => {
        const { data } = await reminders;
        const overdue = data.items.filter((i) => i.overdue).length;
        return { value: String(data.items.length), sub: overdue ? `${overdue} overdue` : data.items.length ? 'Nothing overdue' : 'All clear', ...(overdue ? { tone: 'danger' as const } : {}) };
      }, 'rose', 'calendar'),
    );

    void fillCard(today, async () => {
      const { data } = await daily;
      return h(
        'div',
        {},
        h('p', { class: 'muted small' }, `${shortDate(data.date)} · ${plural(data.expenseCount, 'expense', 'expenses')} · ${plural(data.activities.length, 'activity', 'activities')}`),
        iconRows([
          ...data.byCategory.map((g) => ({ icon: CATEGORY_ICONS[g.category] ?? ('dots' as IconName), name: label(g.category), count: g.entryCount, value: g.totalDisplay })),
          ...(data.milkTotalMillilitres > 0 ? [{ icon: 'milk' as IconName, name: 'Milk today', value: data.milkTotalDisplay }] : []),
          ...data.activities.map((a) => ({ icon: 'dots' as IconName, name: `${label(a.activityType)}${a.animalOrField ? ` · ${a.animalOrField}` : ''}`, value: '' })),
        ]),
        !data.expenseCount && !data.activities.length && data.milkTotalMillilitres === 0 ? emptyState('list', 'Nothing recorded today yet.', 'Tell FarmAssist what you spent or did, by voice or text.') : null,
      );
    });
    void fillCard(month, async () => {
      const { data } = await readTool<ExpenseSummary>('get_expense_summary', { period: 'this_month', groupBy: 'category' });
      return h(
        'div',
        {},
        h('p', { class: 'big' }, data.totalDisplay),
        h('p', { class: 'muted small' }, `${plural(data.entryCount, 'expense', 'expenses')} since ${shortDate(data.range.from)}`),
        data.groups.length ? categoryRows(data.groups.map((g) => ({ key: g.key, value: g.totalDisplay, count: g.entryCount }))) : emptyState('wallet', 'Nothing recorded this month yet.'),
      );
    });
    void fillCard(upcoming, () => upcomingList(7, reminders));
    void fillCard(week, async () => {
      const { data } = await readTool<WeeklyInsights>('weekly_insights');
      return h('div', {}, h('p', { class: 'lines' }, data.narrative), h('p', { class: 'verified-strip' }, icon('bulb'), 'Every number here is checked against your saved records.'));
    });
  };
  load();

  const refresh = h('button', { class: 'btn-outline', type: 'button', onclick: load }, icon('refresh'), 'Refresh');
  return h(
    'section',
    { class: 'view' },
    pageHeader(h('span', { class: 'greeting' }, greeting(), h('span', { class: 'greeting-leaf' }, icon('leaf'))), "Here's your farm at a glance.", h('span', { class: 'date-chip' }, icon('calendar'), longToday()), refresh),
    tiles,
    h(
      'div',
      { class: 'dash-grid' },
      h(
        'div',
        { class: 'dash-col' },
        card('Today on the farm', today, { icon: 'doc', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('') }, 'Record in chat', icon('chevron')) }),
        card('Last 7 days', week, { icon: 'chart' }),
      ),
      h(
        'div',
        { class: 'dash-col' },
        card('Coming up', upcoming, { icon: 'calendar', action: h('a', { class: 'link', href: '#/farm' }, 'Next 30 days', icon('chevron')) }),
        card('This month', month, { icon: 'chart', action: h('a', { class: 'link', href: '#/expenses' }, 'All expenses', icon('chevron')) }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- Expenses

export function expensesView(): HTMLElement {
  let period = 'this_month';
  let category = '';
  const total = h('div', { class: 'total-line' });
  const list = h('ul', { class: 'entries' });
  const more = h('div');

  async function loadPage(cursor?: string) {
    clear(more);
    if (!cursor) {
      clear(list);
      clear(total);
      list.appendChild(spinner());
    } else {
      more.appendChild(spinner('Loading more…'));
    }
    const filter = { period, ...(category ? { category } : {}) };
    try {
      const [page, summary] = await Promise.all([
        readTool<{ items: EntryView[]; nextCursor?: string }>('list_expenses', { ...filter, limit: 20, ...(cursor ? { cursor } : {}) }),
        cursor ? undefined : readTool<ExpenseSummary>('get_expense_summary', filter),
      ]);
      if (!cursor) clear(list);
      clear(more);
      if (summary) append(total, h('span', {}, plural(summary.data.entryCount, 'expense', 'expenses')), h('strong', {}, summary.data.totalDisplay));
      if (!cursor && page.data.items.length === 0) list.appendChild(h('li', {}, emptyState('wallet', 'No expenses for this choice.', 'Try another period or category, or record one in chat.')));
      for (const e of page.data.items) {
        list.appendChild(
          h('li', { class: 'entry' }, h('div', {}, h('strong', {}, label(e.category)), h('span', { class: 'muted' }, `${shortDate(e.date)}${e.note ? ` · ${e.note}` : ''}`)), h('span', { class: 'amount' }, e.amountDisplay)),
        );
      }
      if (page.data.nextCursor) more.appendChild(h('button', { class: 'secondary', type: 'button', onclick: () => void loadPage(page.data.nextCursor) }, 'Show more'));
    } catch (error) {
      clear(more);
      if (!cursor) clear(list);
      more.appendChild(notice('error', errorText(error), () => void loadPage(cursor)));
    }
  }

  const filters = h(
    'div',
    { class: 'filters' },
    select('Period', PERIODS, period, (v) => ((period = v), void loadPage())),
    select('Category', [['', 'All categories'], ...CATEGORIES.map((c): [string, string] => [c, label(c)])], category, (v) => ((category = v), void loadPage())),
  );
  void loadPage();
  return h(
    'section',
    { class: 'view' },
    pageHeader('Expenses', 'Every amount is worked out from your saved records.', h('button', { class: 'primary btn', type: 'button', onclick: () => askAssistant('Spent ') }, icon('plus'), 'Record expense')),
    h('div', { class: 'card filter-card' }, filters, total),
    list,
    more,
  );
}

// ---------------------------------------------------------------- Activities

export function activitiesView(): HTMLElement {
  let period = 'this_month';
  let activityType = '';
  const body = h('div');

  async function load() {
    clear(body);
    body.appendChild(spinner());
    try {
      const { text, data } = await readTool<{ items: ActivityView[]; totalCount: number }>('list_activities', { period, ...(activityType ? { activityType } : {}), limit: 100 });
      clear(body);
      if (data.items.length === 0) {
        body.appendChild(emptyState('list', 'No activities for this choice.', 'Try another period, or record one in chat.'));
        return;
      }
      body.appendChild(h('p', { class: 'muted small' }, text));
      body.appendChild(
        h(
          'ul',
          { class: 'entries' },
          ...data.items.map((a) =>
            h(
              'li',
              { class: 'entry' },
              h('div', {}, h('strong', {}, `${label(a.activityType)}${a.animalOrField ? ` · ${a.animalOrField}` : ''}`), h('span', { class: 'muted' }, `${shortDate(a.date)}${a.note ? ` · ${a.note}` : ''}`)),
            ),
          ),
        ),
      );
    } catch (error) {
      clear(body);
      body.appendChild(notice('error', errorText(error), () => void load()));
    }
  }

  const filters = h(
    'div',
    { class: 'filters' },
    select('Period', PERIODS, period, (v) => ((period = v), void load())),
    select('Activity', [['', 'All activities'], ...ACTIVITY_TYPES.map((t): [string, string] => [t, label(t)])], activityType, (v) => ((activityType = v), void load())),
  );
  void load();
  return h(
    'section',
    { class: 'view' },
    pageHeader('Activities', 'Milking, vaccinations, sowing and other farm work.', h('button', { class: 'primary btn', type: 'button', onclick: () => askAssistant('Vaccinated ') }, icon('plus'), 'Record activity')),
    h('div', { class: 'card filter-card' }, filters),
    body,
  );
}
