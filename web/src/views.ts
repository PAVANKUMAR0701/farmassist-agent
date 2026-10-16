/**
 * The four screens. Every amount shown is a display string computed by the server (totalDisplay,
 * amountDisplay): the client never adds anything up.
 */
import { ApiError, readTool, sendChat, type ChatReply } from './api.js';
import { append, clear, h, label, notice, shortDate, spinner } from './dom.js';
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
const SUGGESTIONS = ['Spent 2500 on cattle feed', 'Vaccinated the brown cow', 'How much on feed this month?', "Today's summary"];

export function chatView(): HTMLElement {
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const input = h('input', { type: 'text', placeholder: 'Type what you spent or did…', maxlength: '500', 'aria-label': 'Message', autocomplete: 'off' });
  const send = h('button', { type: 'submit', class: 'primary' }, 'Send');
  const prefs = loadVoicePrefs();
  let voiceInput = speechInputSupported();
  const idlePlaceholder = voiceInput ? 'Type or tap the mic…' : 'Type what you spent or did…';
  input.placeholder = idlePlaceholder;
  const mic = h('button', { type: 'button', class: 'mic', 'aria-label': 'Speak', title: 'Speak' }, '🎤');
  let listening: Listening | undefined;
  let openConfirmation: HTMLElement | undefined;
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
    el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return el;
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
    bubble('bot', h('p', {}, reply.reply), actions, buttons, mode);

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
    if (!message) return;
    // Any next message answers (or drops) the pending confirmation, so its buttons stop working.
    openConfirmation?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    openConfirmation = undefined;
    stopSpeaking();
    input.value = '';
    bubble('me', h('p', {}, message), spoken ? h('span', { class: 'spoken', title: 'Spoken' }, '🎤') : null);
    const pending = bubble('bot', h('p', { class: 'typing' }, 'Thinking…'));
    send.disabled = true;
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
      send.disabled = false;
    }
  }

  function setListening(on: boolean) {
    mic.classList.toggle('listening', on);
    mic.setAttribute('aria-label', on ? 'Stop listening' : 'Speak');
    mic.textContent = on ? '■' : '🎤';
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
          bubble('bot', notice('info', 'That sounded like my own voice. Please tap 🎤 and speak again, or type.'));
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
          form.classList.add('no-mic');
        }
      })
      .finally(() => {
        listening = undefined;
        setListening(false);
      });
  }

  mic.addEventListener('click', () => (listening ? listening.stop() : startListening()));

  const newChat = () => {
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
      h('p', {}, voiceInput ? 'Namaste! Tap 🎤 and tell me what you spent or did on the farm, or type it.' : 'Namaste! Tell me what you spent or did on the farm, or ask about your records.'),
      h('div', { class: 'chips' }, ...SUGGESTIONS.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => void submit(s) }, s))),
    );

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

  const form = h('form', { class: voiceInput ? 'composer' : 'composer no-mic', onsubmit: (e: Event) => (e.preventDefault(), void submit(input.value)) }, voiceInput ? mic : null, input, send);
  greet();
  return h(
    'section',
    { class: 'view chat' },
    h('div', { class: 'view-head' }, h('h2', {}, 'Chat'), h('button', { class: 'link', type: 'button', onclick: newChat }, 'New chat')),
    voiceSettings,
    log,
    form,
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

const dueLabel = (i: ReminderItem) => (i.overdue ? `${plural(-i.daysLeft, 'day', 'days')} overdue` : i.daysLeft === 0 ? 'today' : `in ${plural(i.daysLeft, 'day', 'days')}`);

/** Reminders and insurance renewals due in the next `days` days (and anything overdue), soonest first. */
export async function upcomingList(days: number): Promise<Node> {
  const { data } = await readTool<{ items: ReminderItem[] }>('list_reminders', { daysAhead: days });
  if (data.items.length === 0) return notice('empty', `Nothing due in the next ${plural(days, 'day', 'days')}.`);
  return h(
    'ul',
    { class: 'breakdown' },
    ...data.items.map((i) => h('li', { class: i.overdue ? 'overdue' : undefined }, h('span', {}, `${i.source === 'insurance' ? '🛡️ ' : '⏰ '}${i.title}`), h('strong', {}, dueLabel(i)))),
  );
}

export function card(title: string, body: HTMLElement): HTMLElement {
  return h('article', { class: 'card' }, h('h3', {}, title), body);
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
  h('ul', { class: 'breakdown' }, ...rows.map((r) => h('li', {}, h('span', {}, `${label(r.name)} (${r.count})`), h('strong', {}, r.value))));

export function todayView(): HTMLElement {
  const today = h('div');
  const month = h('div');
  const upcoming = h('div');
  const week = h('div');

  const load = () => {
    void fillCard(today, async () => {
      const { data } = await readTool<DailySummary>('get_daily_summary');
      return h(
        'div',
        {},
        h('p', { class: 'big' }, data.expenseTotalDisplay),
        h('p', { class: 'muted' }, `${plural(data.expenseCount, 'expense', 'expenses')} · ${plural(data.activities.length, 'activity', 'activities')} · ${shortDate(data.date)}`),
        data.byCategory.length ? breakdown(data.byCategory.map((g) => ({ name: g.category, value: g.totalDisplay, count: g.entryCount }))) : null,
        data.milkTotalMillilitres > 0 ? h('p', { class: 'milk-line' }, h('span', {}, 'Milk today'), h('strong', {}, data.milkTotalDisplay)) : null,
        data.activities.length
          ? h('ul', { class: 'plain' }, ...data.activities.map((a) => h('li', {}, `${label(a.activityType)}${a.animalOrField ? ` · ${a.animalOrField}` : ''}`)))
          : null,
      );
    });
    void fillCard(month, async () => {
      const { data } = await readTool<ExpenseSummary>('get_expense_summary', { period: 'this_month', groupBy: 'category' });
      return h(
        'div',
        {},
        h('p', { class: 'big' }, data.totalDisplay),
        h('p', { class: 'muted' }, `${plural(data.entryCount, 'expense', 'expenses')} since ${shortDate(data.range.from)}`),
        data.groups.length ? breakdown(data.groups.map((g) => ({ name: g.key, value: g.totalDisplay, count: g.entryCount }))) : notice('empty', 'Nothing recorded this month yet.'),
      );
    });
    void fillCard(upcoming, async () => upcomingList(7));
    void fillCard(week, async () => {
      const { data } = await readTool<WeeklyInsights>('weekly_insights');
      return h('div', {}, h('p', {}, data.narrative), h('p', { class: 'muted small' }, 'Every number above is checked against your saved records.'));
    });
  };
  load();

  return h(
    'section',
    { class: 'view' },
    h('div', { class: 'view-head' }, h('h2', {}, 'Today'), h('button', { class: 'link', type: 'button', onclick: load }, 'Refresh')),
    card('Spent today', today),
    card('Coming up', upcoming),
    card('This month', month),
    card('Last 7 days', week),
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
      if (!cursor && page.data.items.length === 0) list.appendChild(h('li', {}, notice('empty', 'No expenses for this choice.')));
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
  return h('section', { class: 'view' }, h('div', { class: 'view-head' }, h('h2', {}, 'Expenses')), filters, total, list, more);
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
        body.appendChild(notice('empty', 'No activities for this choice.'));
        return;
      }
      body.appendChild(h('p', { class: 'muted' }, text));
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
  return h('section', { class: 'view' }, h('div', { class: 'view-head' }, h('h2', {}, 'Activities')), filters, body);
}
