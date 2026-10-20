/**
 * The four screens. Every amount shown is a display string computed by the server (totalDisplay,
 * amountDisplay): the client never adds anything up.
 */
import { ApiError, readTool, sendChat, sendPhoto, type ChatReply } from './api.js';
import { shrinkPhoto } from './photo.js';
import { append, badge, clear, h, icon, label, notice, pageHeader, shortDate, spinner, type IconName } from './dom.js';
import {
  isEcho,
  listen,
  loadVoicePrefs,
  saveVoicePrefs,
  speak,
  speechInputSupported,
  speechOutputSupported,
  stopSpeaking,
  VOICE_LANGUAGES,
  VoiceError,
  type Listening,
} from './voice.js';

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
const SUGGESTIONS: Array<{ text: string; send: boolean }> = [
  { text: 'How much did I spend today?', send: true },
  { text: "Today's summary", send: true },
  { text: 'How much on feed this month?', send: true },
  { text: 'How was my week?', send: true },
  { text: 'Spent 500 on cattle feed', send: false },
  { text: 'Lakshmi gave 8 litres this morning', send: false },
];

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

export function chatView(): HTMLElement {
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const input = h('input', { type: 'text', maxlength: '500', 'aria-label': 'Message to FarmAssist', autocomplete: 'off', enterkeyhint: 'send' });
  const send = h('button', { type: 'submit', class: 'send', 'aria-label': 'Send', title: 'Send' }, icon('send'));
  const prefs = loadVoicePrefs();
  let voiceInput = speechInputSupported();
  const idlePlaceholder = voiceInput ? 'Type or speak…' : 'Ask or record…';
  input.placeholder = idlePlaceholder;
  const mic = h('button', { type: 'button', class: 'tool mic', 'aria-label': 'Speak', title: 'Speak' }, icon('mic'));
  let listening: Listening | undefined;
  let openConfirmation: HTMLElement | undefined;
  /** True while a message or photo is with the server: stops double submissions from taps, chips and Enter. */
  let busy = false;
  /** What the app last said aloud, to recognise its own voice coming back through the microphone. */
  let lastSpoken = '';
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

  const showReply = (reply: ChatReply, spoken: boolean) => {
    // What the server did, in its own words; skipped when the reply already is that text (basic mode).
    const extra = reply.actions.filter((a) => a.text !== reply.reply);
    const actions = extra.length
      ? h('ul', { class: 'actions' }, ...extra.map((a) => h('li', { class: a.ok ? 'ok' : 'failed' }, `${a.ok ? '✓' : '✗'} ${a.text}`)))
      : null;
    const mode = reply.mode === 'fallback' ? h('div', { class: 'mode' }, reply.modelUnavailable ? 'Basic mode: the AI assistant is unavailable right now.' : 'Basic mode') : null;
    let buttons: HTMLElement | null = null;
    if (reply.awaitingConfirmation) {
      const answer = (text: string) => void submit(text, true);
      buttons = openConfirmation = h(
        'div',
        { class: 'confirm' },
        h('button', { type: 'button', class: 'primary', onclick: () => answer('yes') }, 'Yes, save'),
        h('button', { type: 'button', class: 'secondary', onclick: () => answer('no') }, 'No'),
      );
    }
    bubble('bot', h('p', { class: 'lines' }, reply.reply), actions, buttons, mode);

    if (spoken && prefs.speakReplies) {
      lastSpoken = reply.reply;
      void speak(reply.reply, prefs.lang).then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600)); // let the speaker fall silent before the mic opens
        // Hands-free: after reading a confirmation question aloud, listen for the yes or no.
        if (reply.awaitingConfirmation && voiceInput && !listening) startListening();
      });
    }
  };

  async function submit(text: string, spoken = false) {
    const message = text.trim();
    if (!message || busy) return;
    // Any next message answers (or drops) the pending confirmation, so its buttons stop working.
    openConfirmation?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    openConfirmation = undefined;
    stopSpeaking();
    input.value = '';
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
      showReply(reply, spoken);
    } catch (error) {
      pending.remove();
      bubble('bot', notice('error', errorText(error), () => void submit(message, spoken)));
    } finally {
      setBusy(false);
    }
  }

  function setListening(on: boolean) {
    mic.classList.toggle('listening', on);
    mic.setAttribute('aria-label', on ? 'Stop listening' : 'Speak');
    mic.replaceChildren(icon(on ? 'stop' : 'mic'));
    input.placeholder = on ? 'Listening… speak now' : idlePlaceholder;
  }

  function startListening() {
    stopSpeaking();
    const session = listen(prefs.lang, (heard) => (input.value = heard));
    listening = session;
    setListening(true);
    session.result
      .then((heard) => {
        // The words heard are shown in the chat; a spoken change is still read back before anything is saved.
        if (!heard) return;
        if (isEcho(heard, lastSpoken)) {
          // The phone's speaker came back through the mic (heard live, 2026-10-16). Never send that as the farmer's words.
          input.value = '';
          bubble('bot', notice('info', 'That sounded like my own voice. Please tap the mic and speak again, or type.'));
          return;
        }
        void submit(heard, true);
      })
      .catch((error: unknown) => {
        input.value = '';
        const voiceError = error instanceof VoiceError ? error : new VoiceError('Voice input stopped. Please try again, or type instead.');
        bubble('bot', notice('error', voiceError.message));
        if (voiceError.permanent) {
          voiceInput = false;
          mic.remove();
        }
      })
      .finally(() => {
        listening = undefined;
        setListening(false);
      });
  }

  mic.addEventListener('click', () => (listening ? listening.stop() : startListening()));

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
      if (prefs.speakReplies && lastSpoken) void speak(answer.reply, prefs.lang); // only for farmers already using voice
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
    conversationId = undefined;
    try {
      sessionStorage.removeItem(CONVERSATION_KEY);
    } catch {
      /* ignore */
    }
    clear(log);
    greet();
  };

  const greet = () =>
    bubble(
      'bot',
      h('p', {}, voiceInput ? 'Namaste! Tap the mic and tell me what you spent or did on the farm, or type it. Send a photo if an animal or crop looks unwell.' : 'Namaste! Tell me what you spent or did on the farm, or ask about your records. Send a photo if an animal or crop looks unwell.'),
      h(
        'div',
        { class: 'chips', role: 'group', 'aria-label': 'Suggestions' },
        ...SUGGESTIONS.map((s) =>
          h('button', { class: `chip${s.send ? '' : ' chip-fill'}`, type: 'button', title: s.send ? 'Ask this' : 'Put this in the box to edit, then press Send', onclick: () => (s.send ? void submit(s.text) : fillComposer?.(s.text)) }, s.send ? null : icon('plus'), s.text),
        ),
        h('button', { class: 'chip chip-fill', type: 'button', onclick: () => camera.click() }, icon('camera'), 'Check a crop or animal photo'),
      ),
    );

  fillComposer = (text: string) => {
    input.value = text;
    input.focus();
    input.setSelectionRange(text.length, text.length);
  };

  const voiceSettings =
    voiceInput || speechOutputSupported()
      ? h(
          'div',
          { class: 'voice-settings' },
          select('Voice language', VOICE_LANGUAGES, prefs.lang, (v) => ((prefs.lang = v), saveVoicePrefs(prefs))),
          h(
            'label',
            { class: 'toggle' },
            h('input', {
              type: 'checkbox',
              role: 'switch',
              checked: prefs.speakReplies,
              onchange: (e: Event) => {
                prefs.speakReplies = (e.target as HTMLInputElement).checked;
                saveVoicePrefs(prefs);
                if (!prefs.speakReplies) stopSpeaking();
              },
            }),
            'Read replies aloud',
          ),
        )
      : null;

  const form = h('form', { class: 'composer', onsubmit: (e: Event) => (e.preventDefault(), void submit(input.value)) }, camera, voiceInput ? mic : null, photoInput, input, send);
  const hint = voiceInput ? null : h('p', { class: 'composer-hint' }, 'Voice input is not available in this browser. Typing and photos still work.');
  greet();
  return h(
    'section',
    { class: 'assistant', 'aria-label': 'FarmAssist assistant' },
    h(
      'div',
      { class: 'assistant-head' },
      h('div', { class: 'assistant-title' }, h('span', { class: 'assistant-mark' }, icon('logo')), h('div', {}, h('strong', {}, 'Ask FarmAssist'), h('span', {}, 'Every number checked against your records'))),
      h('button', { class: 'ghost', type: 'button', onclick: newChat }, 'New chat'),
    ),
    voiceSettings,
    log,
    h('div', { class: 'composer-wrap' }, form, hint),
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
        h('span', { class: 'row-icon' }, icon(i.source === 'insurance' ? 'cow' : 'bell')),
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

/** A summary tile on the home screen. It links only to a screen that shows the same records in full. */
function statTile(href: string, name: IconName, title: string, load: () => Promise<{ value: string; sub: string; tone?: 'warn' | 'danger' }>): HTMLElement {
  const value = h('span', { class: 'stat-value skeleton' }, '…');
  const sub = h('span', { class: 'stat-sub' }, 'Loading…');
  const tile = h('a', { class: 'stat', href }, h('span', { class: 'stat-top' }, h('span', { class: 'stat-icon' }, icon(name)), h('span', { class: 'stat-label' }, title)), value, sub);
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
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
};

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
      }),
      statTile('#/farm', 'milk', 'Milk today', async () => {
        const { data } = await daily;
        return data.milkTotalMillilitres > 0 ? { value: data.milkTotalDisplay, sub: 'Recorded today' } : { value: '—', sub: 'Not recorded yet' };
      }),
      statTile('#/farm', 'cow', 'Animals', async () => {
        const { data } = await readTool<AnimalsResult>('list_animals');
        return { value: String(data.total), sub: data.total ? animalCounts(data.byType) : 'None registered' };
      }),
      statTile('#/farm', 'sprout', 'Growing crops', async () => {
        const { data } = await readTool<{ crops: Array<{ status: string; crop: string }> }>('list_crops');
        const growing = data.crops.filter((c) => c.status === 'growing');
        return { value: String(growing.length), sub: growing.length ? [...new Set(growing.map((c) => label(c.crop)))].join(', ') : 'None growing' };
      }),
      statTile('#/farm', 'bell', 'Due soon', async () => {
        const { data } = await reminders;
        const overdue = data.items.filter((i) => i.overdue).length;
        return { value: String(data.items.length), sub: overdue ? `${overdue} overdue` : data.items.length ? 'Nothing overdue' : 'All clear', ...(overdue ? { tone: 'danger' as const } : {}) };
      }),
    );

    void fillCard(today, async () => {
      const { data } = await daily;
      return h(
        'div',
        {},
        h('p', { class: 'muted small' }, `${shortDate(data.date)} · ${plural(data.expenseCount, 'expense', 'expenses')} · ${plural(data.activities.length, 'activity', 'activities')}`),
        data.byCategory.length ? breakdown(data.byCategory.map((g) => ({ name: g.category, value: g.totalDisplay, count: g.entryCount }))) : null,
        data.milkTotalMillilitres > 0 ? h('p', { class: 'milk-line' }, h('span', {}, 'Milk today'), h('strong', {}, data.milkTotalDisplay)) : null,
        data.activities.length
          ? h('ul', { class: 'plain' }, ...data.activities.map((a) => h('li', {}, `${label(a.activityType)}${a.animalOrField ? ` · ${a.animalOrField}` : ''}`)))
          : null,
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
        data.groups.length ? breakdown(data.groups.map((g) => ({ name: g.key, value: g.totalDisplay, count: g.entryCount }))) : emptyState('wallet', 'Nothing recorded this month yet.'),
      );
    });
    void fillCard(upcoming, () => upcomingList(7, reminders));
    void fillCard(week, async () => {
      const { data } = await readTool<WeeklyInsights>('weekly_insights');
      return h('div', {}, h('p', { class: 'lines' }, data.narrative), h('p', { class: 'muted small verified' }, '✓ Every number here is checked against your saved records.'));
    });
  };
  load();

  const refresh = h('button', { class: 'btn-outline', type: 'button', onclick: load }, icon('refresh'), 'Refresh');
  return h(
    'section',
    { class: 'view' },
    pageHeader(greeting(), 'Here is your farm at a glance.', refresh),
    tiles,
    h(
      'div',
      { class: 'dash-grid' },
      h(
        'div',
        { class: 'dash-col' },
        card('Today on the farm', today, { icon: 'list', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('') }, 'Record in chat') }),
        card('Last 7 days', week, { icon: 'sprout' }),
      ),
      h(
        'div',
        { class: 'dash-col' },
        card('Coming up', upcoming, { icon: 'bell', action: h('a', { class: 'link', href: '#/farm' }, 'Next 30 days') }),
        card('This month', month, { icon: 'wallet', action: h('a', { class: 'link', href: '#/expenses' }, 'All expenses') }),
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
